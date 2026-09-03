// Filter primitives shared by cli.js, gui-server.js, and tests.
import path from 'path';

export function parseTime(s) {
  if (s === undefined || s === null || s === '') return 0;
  if (typeof s === 'number') return Number.isFinite(s) ? s : 0;
  s = String(s).trim();
  if (!s) return 0;
  if (/^\d{10,}$/.test(s)) return parseInt(s, 10);
  const m = /^(\d+)\s*([smhdw])$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 10);
    const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2].toLowerCase()];
    return Date.now() - n * mult;
  }
  const t = Date.parse(s);
  if (Number.isFinite(t)) return t;
  throw new Error(`invalid time: ${s} (use ISO date, epoch ms, or Ns/Nm/Nh/Nd/Nw)`);
}

export function compileRegexes(arr) {
  return (arr || []).map(s => {
    try { return new RegExp(s, 'i'); }
    catch (e) { throw new Error(`invalid regex /${s}/: ${e.message}`); }
  });
}

function blockText(b) {
  if (!b) return '';
  if (typeof b.text === 'string') return b.text;
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) return b.content.map(c => c?.text || '').join('');
  if (b.input) { try { return JSON.stringify(b.input); } catch { return ''; } }
  return '';
}

export function buildFilter(opts) {
  const m = opts._multi || {};
  const since = parseTime(opts.since || opts.after);
  const until = parseTime(opts.until || opts.before);
  const greps = compileRegexes(m.grep);
  const igreps = compileRegexes(m.igrep);
  const cwdRes = compileRegexes(m.cwd);
  const projects = new Set(m.project || []);
  const roles = new Set(m.role || []);
  const types = new Set(m.type || []);
  const tools = new Set(m.tool || []);
  const sids = (m.session || []).concat(m.sid || []);
  const excludeSids = (m['exclude-sess'] || []).concat(m['exclude-sid'] || []);
  const excludeCwdRes = compileRegexes(m['exclude-cwd']);
  const excludeProjects = new Set(m['exclude-project'] || []);
  const parent = opts.parent || null;

  return ev => {
    const conv = ev.conversation || {};
    const block = ev.block || {};
    const ts = ev.timestamp || 0;
    let pass = true;
    if (since && ts < since) pass = false;
    else if (until && ts > until) pass = false;
    else if (cwdRes.length && !cwdRes.every(r => r.test(conv.cwd || ''))) pass = false;
    else if (projects.size && !projects.has(path.basename(conv.cwd || ''))) pass = false;
    else if (roles.size && !roles.has(ev.role)) pass = false;
    else if (types.size && !types.has(block.type)) pass = false;
    else if (tools.size && !tools.has(block.name)) pass = false;
    else if (sids.length && !sids.some(s => conv.id?.startsWith(s))) pass = false;
    else if (excludeSids.length && excludeSids.some(s => conv.id?.startsWith(s))) pass = false;
    else if (excludeCwdRes.length && excludeCwdRes.some(r => r.test(conv.cwd || ''))) pass = false;
    else if (excludeProjects.size && excludeProjects.has(path.basename(conv.cwd || ''))) pass = false;
    else if (parent && conv.parentSid !== parent) pass = false;
    else if (opts['no-subagents'] && conv.isSubagent) pass = false;
    else if (opts['only-subagents'] && !conv.isSubagent) pass = false;
    else if (opts['no-meta'] && block.isMeta) pass = false;
    else if (opts['only-meta'] && !block.isMeta) pass = false;
    else {
      const text = blockText(block);
      if (greps.length && !greps.every(r => r.test(text))) pass = false;
      else if (igreps.length && igreps.some(r => r.test(text))) pass = false;
    }
    return opts.invert ? !pass : pass;
  };
}

export const DEFAULT_PRESETS = [
  { id: 'recent',     label: 'Last 24h',       query: { since: '24h', isMeta: false } },
  { id: 'week',       label: 'Last 7d',        query: { since: '7d',  isMeta: false } },
  { id: 'errors',     label: 'Errors',         query: { since: '7d',  isError: true } },
  { id: 'tools',      label: 'Tool calls',     query: { since: '24h', type: 'tool_use' } },
  { id: 'user-turns', label: 'User turns',     query: { since: '7d',  role: 'user', type: 'text', isMeta: false } },
  { id: 'assistant',  label: 'Assistant text', query: { since: '24h', role: 'assistant', type: 'text' } },
  { id: 'subagents',  label: 'Subagents',      query: { since: '7d',  isSubagent: true } },
  { id: 'all',        label: 'All time',       query: {} },
];

export const DEFAULT_ACTIVE = 'recent';
