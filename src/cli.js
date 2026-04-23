#!/usr/bin/env node
import { JsonlReplayer, rollup } from './index.js';
import path from 'path';

function parseArgs(argv) {
  const opts = { since: null, grep: null, cwd: null, role: null, type: null, limit: 0, json: false, tail: false, rollup: null, format: 'ndjson' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--since') opts.since = next();
    else if (a === '--grep') opts.grep = next();
    else if (a === '--cwd') opts.cwd = next();
    else if (a === '--role') opts.role = next();
    else if (a === '--type') opts.type = next();
    else if (a === '--limit') opts.limit = parseInt(next(), 10) || 0;
    else if (a === '--json') opts.json = true;
    else if (a === '--tail' || a === '-f') opts.tail = true;
    else if (a === '--rollup') opts.rollup = next();
    else if (a === '--format') opts.format = next();
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else rest.push(a);
  }
  return { opts, rest };
}

function printHelp() {
  process.stdout.write(`ccpeek — query and tail Claude Code session history

Usage:
  ccpeek [--since 12d] [--grep pattern] [--cwd path] [--role user|assistant|tool_result]
          [--type text|tool_use|tool_result] [--limit N] [--json] [-f]
  ccpeek --rollup out.ndjson [--since 7d]
  ccpeek --rollup out.sqlite --format sqlite [--since 7d]      # requires better-sqlite3

Examples:
  ccpeek --since 24h --grep "rs-exec" --limit 50
  ccpeek --since 7d --role user --json
  ccpeek -f                  # tail new events live
`);
}

function parseSince(s) {
  if (!s) return 0;
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) return Date.parse(s) || 0;
  const n = parseInt(m[1], 10);
  const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]];
  return Date.now() - n * mult;
}

const { opts } = parseArgs(process.argv.slice(2));
const since = parseSince(opts.since);
const grepRe = opts.grep ? new RegExp(opts.grep, 'i') : null;
const cwdRe = opts.cwd ? new RegExp(opts.cwd, 'i') : null;

let count = 0;
function out(ev) {
  const conv = ev.conversation;
  if (cwdRe && !cwdRe.test(conv.cwd || '')) return;
  if (opts.role && ev.role !== opts.role) return;
  if (opts.type && ev.block?.type !== opts.type) return;
  const text = ev.block?.text || (ev.block?.content ? (typeof ev.block.content === 'string' ? ev.block.content : JSON.stringify(ev.block.content).slice(0, 400)) : '');
  if (grepRe && !grepRe.test(text)) return;
  count++;
  if (opts.limit && count > opts.limit) return;
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ts: ev.timestamp, sid: conv.id, cwd: conv.cwd, role: ev.role, type: ev.block?.type, text: text.slice(0, 2000) }) + '\n');
  } else {
    const t = new Date(ev.timestamp).toISOString().slice(0, 19).replace('T', ' ');
    const repo = path.basename(conv.cwd || '');
    process.stdout.write(`[${t}] [${repo}] ${ev.role}/${ev.block?.type || '?'}: ${text.replace(/\s+/g, ' ').slice(0, 200)}\n`);
  }
}

if (opts.rollup) {
  const stats = await rollup({ since, out: opts.rollup, format: opts.format });
  process.stderr.write(`# rolled up ${stats.rows} events from ${stats.events} routed (${stats.files} files) → ${stats.format}: ${stats.out}\n`);
  process.exit(0);
}

const r = new JsonlReplayer();
r.on('streaming_progress', out);
r.on('error', e => process.stderr.write(`error: ${e?.message || e}\n`));

if (opts.tail) {
  r.start();
  process.stdout.write('tailing... (Ctrl-C to exit)\n');
} else {
  const stats = r.replay({ since });
  process.stderr.write(`# ${stats.events} events across ${stats.files} files (matched: ${count})\n`);
}
