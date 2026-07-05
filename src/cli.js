#!/usr/bin/env node
import { JsonlReplayer, rollup, vault } from './index.js';
import { toUnslothMessages, toShareGPT } from './unsloth.js';
import { parseTime, compileRegexes, buildFilter } from './filters.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

if (process.argv[2] === 'gui') {
  const { createServer } = await import('./gui-server.js');
  const args = process.argv.slice(3);
  let port = 0, host = '127.0.0.1', open = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port') port = parseInt(args[++i], 10) || 0;
    else if (a === '--host') host = args[++i];
    else if (a === '--open') open = true;
  }
  if (!port) port = 4791;
  const { url } = await createServer({ port, host });
  process.stdout.write(`ccsniff gui · ${url}\n`);
  if (open) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    try { (await import('child_process')).exec(cmd); } catch {}
  }
  process.stdin.resume();
} else {

const FLAGS = {
  string: ['since', 'until', 'before', 'after', 'grep', 'igrep', 'cwd', 'project', 'role', 'type', 'tool', 'session', 'sid', 'sess', 'parent', 'rollup', 'format', 'sort', 'unsloth', 'unsloth-format', 'exclude-sess', 'exclude-sid', 'exclude-cwd', 'exclude-project'],
  multi: ['grep', 'igrep', 'role', 'type', 'tool', 'session', 'sid', 'project', 'cwd', 'exclude-sess', 'exclude-sid', 'exclude-cwd', 'exclude-project'],
  number: ['limit', 'head', 'tail-n', 'ctx', 'truncate', 'days'],
  bool: ['json', 'ndjson', 'tail', 'f', 'full', 'reverse', 'invert', 'no-subagents', 'only-subagents', 'no-meta', 'only-meta', 'list-sessions', 'list-projects', 'list-tools', 'text', 'full-history', 'stats', 'count', 'help', 'h', 'git-discipline', 'search-discipline', 'glyph-discipline'],
};

function parseArgs(argv) {
  const opts = { _multi: {} };
  for (const k of FLAGS.multi) opts._multi[k] = [];
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { opts.help = true; continue; }
    if (a === '-f') { opts.tail = true; continue; }
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const key = a.slice(2);
    if (FLAGS.bool.includes(key)) { opts[key] = true; continue; }
    const val = argv[++i];
    if (FLAGS.multi.includes(key)) opts._multi[key].push(val);
    else if (FLAGS.number.includes(key)) opts[key] = parseInt(val, 10) || 0;
    else opts[key] = val;
  }
  return { opts, rest };
}

function printHelp() {
  process.stdout.write(`ccsniff — query, search, and tail Claude Code session history

USAGE
  ccsniff [filters] [output]                dump matching events (requires ≥1 flag)
  ccsniff -f                                live tail
  ccsniff --rollup out.ndjson [--since 7d]
  ccsniff --rollup out.sqlite --format sqlite
  ccsniff --list-sessions [filters]
  ccsniff --list-projects
  ccsniff --list-tools
  ccsniff --text [filters]              human-readable demarcated view of thinking/tool calls/actions
  ccsniff --stats [filters]

TIME (any ISO date, epoch ms, or relative Ns/Nm/Nh/Nd/Nw)
  --since <t>            include events at/after t (alias: --after)
  --until <t>            include events at/before t (alias: --before)

FILTERS (repeatable flags combine as OR within a flag, AND across flags)
  --grep <re>            text regex (case-insensitive); repeat = AND
  --igrep <re>           exclude if regex matches text; repeat = exclude if ANY matches
  --invert               invert the entire filter result
  --cwd <re>             working-dir regex
  --project <name>       basename(cwd) exact match; repeat = OR
  --role <r>             user|assistant|tool_result|system|result; repeat = OR
  --type <t>             text|tool_use|tool_result|thinking|system|result; repeat = OR
  --tool <name>          tool name (Read, Bash, ...); repeat = OR
  --session <sid>        session id prefix; repeat = OR  (alias: --sid)
  --exclude-sess <sid>   exclude session id prefix; repeat = exclude any (alias: --exclude-sid)
  --exclude-cwd <re>     exclude working-dir regex; repeat = exclude any
  --exclude-project <n>  exclude basename(cwd) exact match; repeat = exclude any
  --parent <sid>         subagent parent session id
  --no-subagents         exclude subagent sessions
  --only-subagents       only subagent sessions
  --no-meta              exclude meta/system-injected user messages
  --only-meta            only meta messages

OUTPUT
  --json                 ndjson rows (one event per line)
  --ndjson               alias for --json
  --full                 do not truncate text fields
  --truncate <N>         max chars of text per row (default 200, 2000 in --json)
  --ctx <N>              include N events before+after each match (context)
  --limit <N>            stop after N matches
  --head <N>             alias for --limit
  --tail-n <N>           keep only the last N matches
  --reverse              newest first
  --sort <key>           ts|sid|cwd|role|type (default ts)
  --count                print only the match count
  --stats                breakdown by role/type/tool/project/session
  --text                 human-readable demarcated blocks (thinking/tool_use/tool_result/text)
  -f, --tail             live tail after replay
  --rollup <out>         dump filtered events to file
  --format ndjson|sqlite rollup format (default ndjson; sqlite needs better-sqlite3)
  --unsloth <out>        write Unsloth training JSONL (one conversation per session per line)
  --unsloth-format <fmt> messages (OpenAI/ChatML, default) | sharegpt

AUDIT
  --git-discipline       flag git push without prior separate porcelain event; raw git push/commit in gm sessions
  --search-discipline    flag Grep/Glob discovery events inside gm (spool-dispatching) sessions
  --glyph-discipline     flag decorative non-ASCII glyphs in assistant text (code blocks excluded)

LIMITS
  by default, output caps at the 500 most recent matching events (after --limit/--tail-n/--ctx apply)
  --full-history         disable the default 500-event cap and dump everything matched

EXAMPLES
  ccsniff --since 24h --grep "rs-exec" --limit 50
  ccsniff --since 7d --until 1d --role user --json
  ccsniff --project ccsniff --tool Bash --ctx 2
  ccsniff --grep error --grep timeout --invert        # error AND NOT timeout? no — both must match
  ccsniff --igrep DEBUG --since 1h                    # exclude DEBUG lines
  ccsniff --list-sessions --since 7d --project myrepo
  ccsniff --stats --since 24h
  ccsniff -f --project ccsniff --role assistant
`);
}

function blockText(b) {
  if (!b) return '';
  if (typeof b.text === 'string') return b.text;
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) return b.content.map(c => c?.text || '').join('');
  if (b.input) return JSON.stringify(b.input);
  return '';
}

function formatRow(ev, opts) {
  const conv = ev.conversation || {};
  const block = ev.block || {};
  const text = blockText(block).replace(/\s+/g, ' ');
  const truncN = opts.full ? Infinity : (opts.truncate || (opts.json ? 2000 : 200));
  const out = text.length > truncN ? text.slice(0, truncN) + '…' : text;
  if (opts.json) {
    return JSON.stringify({
      ts: ev.timestamp,
      iso: new Date(ev.timestamp).toISOString(),
      sid: conv.id,
      parent: conv.parentSid || null,
      cwd: conv.cwd,
      project: path.basename(conv.cwd || ''),
      role: ev.role,
      type: block.type,
      tool: block.name || null,
      isMeta: !!block.isMeta,
      text: opts.full ? text : out,
    }) + '\n';
  }
  const t = new Date(ev.timestamp).toISOString().slice(0, 19).replace('T', ' ');
  const repo = path.basename(conv.cwd || '');
  const tool = block.name ? `:${block.name}` : '';
  const tag = conv.isSubagent ? '*' : '';
  return `[${t}] [${repo}${tag}] ${ev.role}/${block.type || '?'}${tool}: ${out}\n`;
}

// Human-readable demarcated block per event — for watching an agent's thinking, tool calls,
// and tool results go by as a live transcript rather than a dense single-line dump.
function formatTextBlock(ev) {
  const conv = ev.conversation || {};
  const block = ev.block || {};
  const t = new Date(ev.timestamp).toISOString().slice(0, 19).replace('T', ' ');
  const repo = path.basename(conv.cwd || '');
  const tag = conv.isSubagent ? ' (subagent)' : '';
  const kind = block.type === 'tool_use' ? `tool_use: ${block.name || '?'}`
    : block.type === 'tool_result' ? 'tool_result'
    : block.type === 'thinking' ? 'thinking'
    : block.type || ev.role;
  const header = `==== [${t}] ${repo}${tag} :: ${ev.role} :: ${kind} ====`;
  const body = blockText(block).trim();
  return `${header}\n${body}\n\n`;
}

function collect(opts, since) {
  const r = new JsonlReplayer();
  const all = [];
  r.on('streaming_progress', ev => all.push(ev));
  r.on('error', e => process.stderr.write(`error: ${e?.message || e}\n`));
  const stats = r.replay({ since });
  return { stats, all };
}

function applyContext(matchedIdxs, all, ctx) {
  if (!ctx) return matchedIdxs.map(i => all[i]);
  const keep = new Set();
  for (const i of matchedIdxs) {
    for (let j = Math.max(0, i - ctx); j <= Math.min(all.length - 1, i + ctx); j++) keep.add(j);
  }
  return [...keep].sort((a, b) => a - b).map(i => all[i]);
}

function sortRows(rows, key, reverse) {
  const get = {
    ts: e => e.timestamp || 0,
    sid: e => e.conversation?.id || '',
    cwd: e => e.conversation?.cwd || '',
    role: e => e.role || '',
    type: e => e.block?.type || '',
  }[key] || (e => e.timestamp || 0);
  rows.sort((a, b) => { const x = get(a), y = get(b); return x < y ? -1 : x > y ? 1 : 0; });
  if (reverse) rows.reverse();
  return rows;
}

const { opts } = parseArgs(process.argv.slice(2));
if (opts.help || process.argv.length <= 2) { printHelp(); process.exit(0); }

{ const r = vault(); if (r.copied > 0) process.stderr.write(`# vault: ${r.copied} copied → ~/.claude/history-backup\n`); }

let since, filter;
try {
  since = parseTime(opts.since || opts.after);
  filter = buildFilter(opts);
} catch (e) {
  process.stderr.write(`ccsniff: ${e.message}\n`);
  process.exit(2);
}

// ---------- rollup (filtered)
if (opts.rollup) {
  const stats = await rollup({ since, out: opts.rollup, format: opts.format || 'ndjson' });
  process.stderr.write(`# rolled up ${stats.rows} events from ${stats.events} routed (${stats.files} files) → ${stats.format}: ${stats.out}\n`);
  process.exit(0);
}

// ---------- live tail (filter applied to live events)
if (opts.tail) {
  const r = new JsonlReplayer();
  r.on('streaming_progress', ev => { if (filter(ev)) process.stdout.write(opts.text ? formatTextBlock(ev) : formatRow(ev, opts)); });
  r.on('error', e => process.stderr.write(`error: ${e?.message || e}\n`));
  r.start(since);
  process.stdout.write('# tailing... (Ctrl-C to exit)\n');
  process.stdin.resume();
} else {

// ---------- one-shot collection (everything else needs the full set)
const { stats, all } = collect(opts, since);

// ---------- discipline audits
if (opts['git-discipline'] || opts['search-discipline'] || opts['glyph-discipline']) {
  const { gitDiscipline, searchDiscipline, glyphDiscipline } = await import('./discipline.js');
  const rows = all.filter(filter);
  if (opts['git-discipline']) gitDiscipline(rows);
  if (opts['search-discipline']) searchDiscipline(rows);
  if (opts['glyph-discipline']) glyphDiscipline(rows);
  process.stderr.write(`# ${stats.events} events / ${stats.files} files / ${rows.length} in scope\n`);
  process.exit(0);
}

// ---------- list-projects
if (opts['list-projects']) {
  const projects = new Map();
  for (const ev of all) {
    const p = path.basename(ev.conversation?.cwd || '');
    if (!p) continue;
    if (!projects.has(p)) projects.set(p, { events: 0, sessions: new Set(), last: 0 });
    const x = projects.get(p);
    x.events++;
    x.sessions.add(ev.conversation.id);
    if (ev.timestamp > x.last) x.last = ev.timestamp;
  }
  const rows = [...projects.entries()].sort((a, b) => b[1].last - a[1].last);
  for (const [p, x] of rows) {
    process.stdout.write(`${new Date(x.last).toISOString().slice(0, 19)}  ${String(x.sessions.size).padStart(4)} sess  ${String(x.events).padStart(7)} ev  ${p}\n`);
  }
  process.stderr.write(`# ${rows.length} projects\n`);
  process.exit(0);
}

// ---------- list-tools
if (opts['list-tools']) {
  const tools = new Map();
  for (const ev of all) {
    if (!filter(ev)) continue;
    const n = ev.block?.name;
    if (!n) continue;
    tools.set(n, (tools.get(n) || 0) + 1);
  }
  const rows = [...tools.entries()].sort((a, b) => b[1] - a[1]);
  for (const [n, c] of rows) process.stdout.write(`${String(c).padStart(7)}  ${n}\n`);
  process.stderr.write(`# ${rows.length} distinct tools\n`);
  process.exit(0);
}

// ---------- list-sessions
if (opts['list-sessions']) {
  const sess = new Map();
  for (const ev of all) {
    if (!filter(ev)) continue;
    const conv = ev.conversation;
    const sid = conv.id;
    if (!sess.has(sid)) sess.set(sid, { cwd: conv.cwd, parent: conv.parentSid, sub: conv.isSubagent, first: ev.timestamp, last: ev.timestamp, events: 0, tools: 0, userTurns: 0 });
    const s = sess.get(sid);
    if (ev.timestamp < s.first) s.first = ev.timestamp;
    if (ev.timestamp > s.last) s.last = ev.timestamp;
    s.events++;
    if (ev.block?.type === 'tool_use') s.tools++;
    if (ev.role === 'user' && ev.block?.type === 'text' && !ev.block.isMeta) s.userTurns++;
  }
  const rows = [...sess.entries()].sort((a, b) => b[1].last - a[1].last);
  for (const [sid, s] of rows) {
    const dur = Math.round((s.last - s.first) / 1000);
    const tag = s.sub ? '*' : ' ';
    process.stdout.write(`${new Date(s.last).toISOString().slice(0, 19)} ${tag} ${sid.slice(0, 8)}  turns:${String(s.userTurns).padStart(3)} tools:${String(s.tools).padStart(4)} ev:${String(s.events).padStart(5)} dur:${String(dur).padStart(5)}s  ${path.basename(s.cwd || '')}\n`);
  }
  process.stderr.write(`# ${rows.length} sessions match\n`);
  process.exit(0);
}

// ---------- main filter pass
const matchedIdxs = [];
for (let i = 0; i < all.length; i++) if (filter(all[i])) matchedIdxs.push(i);
let rows = applyContext(matchedIdxs, all, opts.ctx || 0);
rows = sortRows(rows, opts.sort || 'ts', opts.reverse);

if (opts['tail-n']) rows = rows.slice(-opts['tail-n']);
const limit = opts.limit || opts.head || 0;
if (limit) rows = rows.slice(0, limit);

const DEFAULT_CAP = 500;
let capped = 0;
if (!opts['full-history'] && !opts.stats && !opts.count && !opts.unsloth && rows.length > DEFAULT_CAP) {
  capped = rows.length - DEFAULT_CAP;
  rows = rows.slice(-DEFAULT_CAP);
}

// ---------- stats
if (opts.stats) {
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const byRole = new Map(), byType = new Map(), byTool = new Map(), byProject = new Map(), bySid = new Map();
  for (const ev of rows) {
    bump(byRole, ev.role || '?');
    bump(byType, ev.block?.type || '?');
    if (ev.block?.name) bump(byTool, ev.block.name);
    bump(byProject, path.basename(ev.conversation?.cwd || '') || '?');
    bump(bySid, (ev.conversation?.id || '?').slice(0, 8));
  }
  const dump = (label, m, top = 20) => {
    process.stdout.write(`\n# ${label}\n`);
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).forEach(([k, v]) => process.stdout.write(`  ${String(v).padStart(7)}  ${k}\n`));
  };
  process.stdout.write(`# total matched: ${rows.length}  files:${stats.files}  routed:${stats.events}\n`);
  dump('by role', byRole);
  dump('by type', byType);
  dump('by tool', byTool);
  dump('by project', byProject);
  dump('by session (top 20)', bySid);
  process.exit(0);
}

if (opts.count) {
  process.stdout.write(`${rows.length}\n`);
  process.exit(0);
}

if (opts.unsloth) {
  const fmt = opts['unsloth-format'] || 'messages';
  const recs = fmt === 'sharegpt' ? toShareGPT(rows) : toUnslothMessages(rows);
  const body = recs.map(r => JSON.stringify(r)).join('\n') + (recs.length ? '\n' : '');
  fs.writeFileSync(opts.unsloth, body);
  process.stderr.write(`# unsloth(${fmt}): ${recs.length} conversations → ${opts.unsloth}\n`);
  process.exit(0);
}

for (const ev of rows) process.stdout.write(opts.text ? formatTextBlock(ev) : formatRow(ev, opts));
const capNote = capped ? ` (${capped} older events hidden by default cap — pass --full-history to see all)` : '';
process.stderr.write(`# ${stats.events} events / ${stats.files} files / ${rows.length} matched${capNote}\n`);

}
}
