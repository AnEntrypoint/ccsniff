// Shared store for both legacy /api/* (gui-server.js) and new /v1/history/* (router.js).
import path from 'path';
import os from 'os';
import { JsonlReplayer, JsonlWatcher } from './index.js';
import { buildIndex, search, snippet, tokenize } from './bm25.js';

export const DEFAULT_PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');

export function blockText(b) {
  if (!b) return '';
  if (typeof b.text === 'string') return b.text;
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) return b.content.map(c => c?.text || '').join('');
  if (b.input) { try { return JSON.stringify(b.input); } catch { return ''; } }
  return '';
}

export function flattenEvent(ev, idx) {
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
    isMeta: !!b.isMeta,
    cost: b.total_cost_usd || null,
    duration: b.duration_ms || null,
    subtype: b.subtype || null,
    model: b.model || null,
  };
}

export class Store {
  constructor(projectsDir) {
    this.projectsDir = projectsDir || DEFAULT_PROJECTS_DIR;
    this.events = [];
    this.errors = [];
    this.fileBytes = 0;
    this.fileCount = 0;
    this.index = null;
    this.lastBuilt = 0;
    this.watcher = null;
    this.sseClients = new Set();
    this.convs = new Map();
  }

  loadOnce() {
    const r = new JsonlReplayer(this.projectsDir);
    let i = 0;
    r.on('conversation_created', ev => this.convs.set(ev.conversation.id, ev.conversation));
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
    this.watcher.on('conversation_created', ev => {
      this.convs.set(ev.conversation.id, ev.conversation);
      this.broadcast('conversation', { conv: ev.conversation, ts: ev.timestamp });
    });
    this.watcher.on('streaming_progress', ev => {
      const fl = flattenEvent(ev, this.events.length);
      this.events.push(fl);
      this.broadcast('event', { sid: fl.sid, payload: fl });
    });
    this.watcher.on('streaming_error', ev => {
      const e = { ts: ev.timestamp, sid: ev.conversationId, error: ev.error, recoverable: ev.recoverable };
      this.errors.push(e);
      this.broadcast('error', e);
    });
    this.watcher.on('streaming_start', ev => this.broadcast('start', { sid: ev.conversationId, ts: ev.timestamp }));
    this.watcher.on('streaming_complete', ev => this.broadcast('complete', { sid: ev.conversationId, ts: ev.timestamp }));
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
      events: this.events.length,
      sessions: sids.size,
      projects: projects.size,
      tools: tools.size,
      errors: this.errors.length,
      files: this.fileCount,
      bytes,
      earliest: earliest === Infinity ? 0 : earliest,
      latest,
      dateRange: { earliest: earliest === Infinity ? 0 : earliest, latest },
      indexedAt: this.lastBuilt,
    };
  }

  sessions() {
    const map = new Map();
    for (const e of this.events) {
      let s = map.get(e.sid);
      if (!s) {
        const conv = this.convs.get(e.sid) || {};
        s = { sid: e.sid, title: conv.title || '', project: e.project, cwd: e.cwd, parent: e.parent, isSubagent: e.isSubagent, first: e.ts, last: e.ts, events: 0, tools: 0, userTurns: 0, cost: 0, errors: 0 };
        map.set(e.sid, s);
      }
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

  sessionEvents(sid) {
    return this.events.filter(e => e.sid === sid);
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

  events_filtered({ role, type, project, sid, tool, since, until, limit = 200, offset = 0, q, grep, igrep, isMeta, isSubagent, isError, parent } = {}) {
    let arr = this.events;
    let greRe = null, igreRe = null;
    try {
      if (grep) greRe = new RegExp(grep, 'i');
      if (igrep) igreRe = new RegExp(igrep, 'i');
    } catch (e) {
      return { total: 0, rows: [], error: `invalid regex: ${e.message}` };
    }
    if (q) {
      const tokens = [...new Set(tokenize(q))];
      if (tokens.length) {
        arr = arr.filter(e => { const t = tokenize(e.text); return tokens.every(x => t.includes(x)); });
      } else {
        const needle = String(q).toLowerCase();
        arr = arr.filter(e => (e.text || '').toLowerCase().includes(needle));
      }
    }
    arr = arr.filter(e => {
      if (role && e.role !== role) return false;
      if (type && e.type !== type) return false;
      if (project && e.project !== project) return false;
      if (sid && !e.sid.startsWith(sid)) return false;
      if (parent && e.parent !== parent) return false;
      if (tool && e.tool !== tool) return false;
      if (since && e.ts < since) return false;
      if (until && e.ts > until) return false;
      if (isMeta === true && !e.isMeta) return false;
      if (isMeta === false && e.isMeta) return false;
      if (isSubagent === true && !e.isSubagent) return false;
      if (isSubagent === false && e.isSubagent) return false;
      if (isError === true && !e.isError) return false;
      if (isError === false && e.isError) return false;
      if (greRe && !greRe.test(e.text || '')) return false;
      if (igreRe && igreRe.test(e.text || '')) return false;
      return true;
    });
    return { total: arr.length, rows: arr.slice(offset, offset + limit) };
  }
}

let _shared = null;
export function getStore(projectsDir) {
  if (_shared) return _shared;
  _shared = new Store(projectsDir);
  _shared.loadOnce();
  _shared.startLive();
  return _shared;
}
