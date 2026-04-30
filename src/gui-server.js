import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JsonlReplayer, JsonlWatcher } from './index.js';
import { buildIndex, search, snippet, tokenize } from './bm25.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUI_DIR = path.join(__dirname, '..', 'gui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

function blockText(b) {
  if (!b) return '';
  if (typeof b.text === 'string') return b.text;
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) return b.content.map(c => c?.text || '').join('');
  if (b.input) { try { return JSON.stringify(b.input); } catch { return ''; } }
  return '';
}

function flattenEvent(ev, idx) {
  const c = ev.conversation || {};
  const b = ev.block || {};
  return {
    i: idx,
    ts: ev.timestamp || 0,
    sid: c.id || '',
    parent: c.parentSid || null,
    cwd: c.cwd || '',
    project: path.basename(c.cwd || ''),
    isSubagent: !!c.isSubagent,
    role: ev.role,
    type: b.type || null,
    tool: b.name || null,
    text: blockText(b),
    isError: !!b.is_error || ev.role === 'streaming_error',
    cost: b.total_cost_usd || null,
    duration: b.duration_ms || null,
    subtype: b.subtype || null,
    model: b.model || null,
  };
}

class Store {
  constructor(projectsDir) {
    this.projectsDir = projectsDir;
    this.events = [];
    this.errors = [];
    this.fileBytes = 0;
    this.fileCount = 0;
    this.index = null;
    this.lastBuilt = 0;
    this.watcher = null;
    this.sseClients = new Set();
  }

  loadOnce() {
    const r = new JsonlReplayer(this.projectsDir);
    let i = 0;
    r.on('streaming_progress', ev => { this.events.push(flattenEvent(ev, i++)); });
    r.on('streaming_error', ev => { this.errors.push({ ts: ev.timestamp, sid: ev.conversationId, error: ev.error, recoverable: ev.recoverable }); });
    const stats = r.replay({});
    this.fileCount = stats.files;
    this.rebuildIndex();
    return stats;
  }

  rebuildIndex() {
    this.index = buildIndex(this.events, e => e.text);
    this.lastBuilt = Date.now();
  }

  startLive() {
    if (this.watcher) return;
    this.watcher = new JsonlWatcher(this.projectsDir);
    this.watcher.on('streaming_progress', ev => {
      const fl = flattenEvent(ev, this.events.length);
      this.events.push(fl);
      this.broadcast('event', fl);
    });
    this.watcher.on('streaming_error', ev => {
      const e = { ts: ev.timestamp, sid: ev.conversationId, error: ev.error, recoverable: ev.recoverable };
      this.errors.push(e);
      this.broadcast('error', e);
    });
    this.watcher.on('streaming_start', ev => this.broadcast('start', { sid: ev.conversationId, ts: ev.timestamp }));
    this.watcher.on('streaming_complete', ev => this.broadcast('complete', { sid: ev.conversationId, ts: ev.timestamp }));
    this.watcher.on('conversation_created', ev => this.broadcast('conversation', { conv: ev.conversation, ts: ev.timestamp }));
    this.watcher.start();
  }

  stop() {
    if (this.watcher) this.watcher.stop();
    for (const r of this.sseClients) try { r.end(); } catch {}
    this.sseClients.clear();
  }

  broadcast(kind, data) {
    const payload = `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) { try { res.write(payload); } catch {} }
  }

  snapshot() {
    const sids = new Set(), projects = new Set(), tools = new Map();
    let earliest = Infinity, latest = 0, bytes = 0;
    for (const e of this.events) {
      sids.add(e.sid); if (e.project) projects.add(e.project);
      if (e.tool) tools.set(e.tool, (tools.get(e.tool) || 0) + 1);
      if (e.ts < earliest) earliest = e.ts;
      if (e.ts > latest) latest = e.ts;
      bytes += (e.text || '').length;
    }
    return {
      events: this.events.length, sessions: sids.size, projects: projects.size,
      tools: tools.size, errors: this.errors.length, files: this.fileCount,
      bytes, earliest: earliest === Infinity ? 0 : earliest, latest, indexedAt: this.lastBuilt,
    };
  }

  sessions() {
    const map = new Map();
    for (const e of this.events) {
      let s = map.get(e.sid);
      if (!s) { s = { sid: e.sid, project: e.project, cwd: e.cwd, parent: e.parent, isSubagent: e.isSubagent, first: e.ts, last: e.ts, events: 0, tools: 0, userTurns: 0, cost: 0, errors: 0 }; map.set(e.sid, s); }
      s.events++;
      if (e.ts < s.first) s.first = e.ts;
      if (e.ts > s.last) s.last = e.ts;
      if (e.type === 'tool_use') s.tools++;
      if (e.role === 'user' && e.type === 'text') s.userTurns++;
      if (e.cost) s.cost += e.cost;
      if (e.isError) s.errors++;
    }
    return [...map.values()].sort((a, b) => b.last - a.last);
  }

  projects() {
    const map = new Map();
    for (const e of this.events) {
      if (!e.project) continue;
      let p = map.get(e.project);
      if (!p) { p = { project: e.project, sessions: new Set(), events: 0, tools: 0, last: 0, errors: 0, cost: 0 }; map.set(e.project, p); }
      p.events++;
      p.sessions.add(e.sid);
      if (e.type === 'tool_use') p.tools++;
      if (e.ts > p.last) p.last = e.ts;
      if (e.cost) p.cost += e.cost;
      if (e.isError) p.errors++;
    }
    return [...map.values()].map(p => ({ ...p, sessions: p.sessions.size })).sort((a, b) => b.last - a.last);
  }

  tools() {
    const map = new Map();
    for (const e of this.events) {
      if (!e.tool) continue;
      let t = map.get(e.tool);
      if (!t) { t = { tool: e.tool, count: 0, sessions: new Set(), errors: 0, last: 0 }; map.set(e.tool, t); }
      t.count++;
      t.sessions.add(e.sid);
      if (e.isError) t.errors++;
      if (e.ts > t.last) t.last = e.ts;
    }
    return [...map.values()].map(t => ({ ...t, sessions: t.sessions.size })).sort((a, b) => b.count - a.count);
  }

  timeline(bucketMs = 3600_000) {
    const buckets = new Map();
    for (const e of this.events) {
      const k = Math.floor(e.ts / bucketMs) * bucketMs;
      let b = buckets.get(k);
      if (!b) { b = { t: k, events: 0, tools: 0, errors: 0, sessions: new Set() }; buckets.set(k, b); }
      b.events++;
      if (e.type === 'tool_use') b.tools++;
      if (e.isError) b.errors++;
      b.sessions.add(e.sid);
    }
    return [...buckets.values()].map(b => ({ ...b, sessions: b.sessions.size })).sort((a, b) => a.t - b.t);
  }

  stats() {
    const role = {}, type = {}, model = {};
    let cost = 0, dur = 0, results = 0;
    for (const e of this.events) {
      role[e.role || '?'] = (role[e.role || '?'] || 0) + 1;
      type[e.type || '?'] = (type[e.type || '?'] || 0) + 1;
      if (e.model) model[e.model] = (model[e.model] || 0) + 1;
      if (e.cost) { cost += e.cost; results++; }
      if (e.duration) dur += e.duration;
    }
    return { role, type, model, totalCostUsd: cost, totalDurationMs: dur, results };
  }

  errorsList() { return this.errors.slice(-200).reverse(); }

  subagents() {
    const tree = new Map();
    for (const e of this.events) {
      if (!e.isSubagent) continue;
      const parent = e.parent || 'orphan';
      let p = tree.get(parent);
      if (!p) { p = { parent, children: new Map() }; tree.set(parent, p); }
      let c = p.children.get(e.sid);
      if (!c) { c = { sid: e.sid, project: e.project, events: 0, last: 0 }; p.children.set(e.sid, c); }
      c.events++;
      if (e.ts > c.last) c.last = e.ts;
    }
    return [...tree.values()].map(p => ({ parent: p.parent, children: [...p.children.values()] }));
  }

  search(q, { limit = 50, role, type, project, sid } = {}) {
    if (!this.index) this.rebuildIndex();
    const hits = search(this.index, q, { limit: limit * 4 });
    const out = [];
    for (const h of hits) {
      const e = this.events[h.i];
      if (role && e.role !== role) continue;
      if (type && e.type !== type) continue;
      if (project && e.project !== project) continue;
      if (sid && !e.sid.startsWith(sid)) continue;
      out.push({ ...e, score: h.score, terms: h.terms, snippet: snippet(e.text, h.terms) });
      if (out.length >= limit) break;
    }
    return out;
  }

  events_filtered({ role, type, project, sid, tool, since, until, limit = 200, offset = 0, q } = {}) {
    let arr = this.events;
    if (q) {
      const tokens = new Set(tokenize(q));
      arr = arr.filter(e => { const t = tokenize(e.text); return [...tokens].every(x => t.includes(x)); });
    }
    arr = arr.filter(e => {
      if (role && e.role !== role) return false;
      if (type && e.type !== type) return false;
      if (project && e.project !== project) return false;
      if (sid && !e.sid.startsWith(sid)) return false;
      if (tool && e.tool !== tool) return false;
      if (since && e.ts < since) return false;
      if (until && e.ts > until) return false;
      return true;
    });
    return { total: arr.length, rows: arr.slice(offset, offset + limit) };
  }
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(GUI_DIR, p);
  if (!file.startsWith(GUI_DIR)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    const ext = path.extname(file);
    send(res, 200, buf, MIME[ext] || 'application/octet-stream');
  });
}

function parseQuery(u) {
  const q = {};
  for (const [k, v] of u.searchParams) q[k] = v;
  if (q.limit) q.limit = parseInt(q.limit, 10);
  if (q.offset) q.offset = parseInt(q.offset, 10);
  if (q.since) q.since = parseInt(q.since, 10);
  if (q.until) q.until = parseInt(q.until, 10);
  if (q.bucket) q.bucket = parseInt(q.bucket, 10);
  return q;
}

export function createServer({ projectsDir, port = 0, host = '127.0.0.1' } = {}) {
  const store = new Store(projectsDir);
  store.loadOnce();
  store.startLive();

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = parseQuery(u);
    const path = u.pathname;
    if (!path.startsWith('/api/')) return serveStatic(req, res);
    try {
      if (path === '/api/snapshot') return send(res, 200, store.snapshot());
      if (path === '/api/sessions') return send(res, 200, store.sessions());
      if (path === '/api/projects') return send(res, 200, store.projects());
      if (path === '/api/tools') return send(res, 200, store.tools());
      if (path === '/api/timeline') return send(res, 200, store.timeline(q.bucket || 3600_000));
      if (path === '/api/stats') return send(res, 200, store.stats());
      if (path === '/api/errors') return send(res, 200, store.errorsList());
      if (path === '/api/subagents') return send(res, 200, store.subagents());
      if (path === '/api/events') return send(res, 200, store.events_filtered(q));
      if (path === '/api/search') return send(res, 200, { query: q.q || '', results: q.q ? store.search(q.q, q) : [] });
      if (path === '/api/reindex') { store.rebuildIndex(); return send(res, 200, { ok: true, at: store.lastBuilt }); }
      if (path === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
        res.write('event: hello\ndata: {}\n\n');
        store.sseClients.add(res);
        req.on('close', () => store.sseClients.delete(res));
        return;
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: String(e?.message || e) });
    }
  });

  return new Promise(resolve => {
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, store, url: `http://${host}:${addr.port}`, port: addr.port, close: () => { store.stop(); return new Promise(r => server.close(r)); } });
    });
  });
}
