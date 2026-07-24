import path from 'path';

const GM_SPOOL_RE = /\.gm[\\\/]exec-spool[\\\/]in[\\\/]/;
const GIT_PUSH_RE = /\bgit\s+push\b/;
const GIT_COMMIT_RE = /\bgit\s+(commit|push)\b/;
const PORCELAIN_RE = /git\s+status\s+--porcelain/;
const GLYPH_RE = /[\u{2190}-\u{21FF}\u{2500}-\u{25FF}\u{2600}-\u{27BF}\u{1F000}-\u{1FAFF}]/gu;

function groupSessions(rows) {
  const sessions = new Map();
  for (const ev of rows) {
    const sid = ev.conversation?.id || '?';
    if (!sessions.has(sid)) sessions.set(sid, []);
    sessions.get(sid).push(ev);
  }
  for (const evs of sessions.values()) evs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return sessions;
}

function isGmSession(evs) {
  for (const ev of evs) {
    const b = ev.block || {};
    if (b.type !== 'tool_use') continue;
    if (b.name === 'Skill' && b.input?.skill === 'gm') return true;
    if (b.name === 'Write' && GM_SPOOL_RE.test(String(b.input?.file_path || ''))) return true;
    if (b.name === 'Bash' && GM_SPOOL_RE.test(String(b.input?.command || ''))) return true;
  }
  return false;
}

function sample(ev, detail, manual) {
  const sid = (ev.conversation?.id || '?').slice(0, 8);
  const iso = new Date(ev.timestamp || 0).toISOString().slice(0, 19).replace('T', ' ');
  const repo = path.basename(ev.conversation?.cwd || '');
  if (manual) {
    const text = String(detail).replace(/\s+/g, ' ');
    return `  [${iso}] [${repo}] ${sid}\n    ${text}\n`;
  }
  const text = String(detail).replace(/\s+/g, ' ').slice(0, 160);
  return `  [${iso}] [${repo}] ${sid}  ${text}\n`;
}

function report(label, observations, maxSamples) {
  process.stdout.write(`# ${label}: ${observations.length} observation(s) for manual review\n`);
  for (const f of observations.slice(0, maxSamples)) process.stdout.write(f);
  if (observations.length > maxSamples) process.stdout.write(`  ... ${observations.length - maxSamples} more\n`);
}

// Every detector below prints its own CLI report as a side effect (existing --*-discipline
// flag contract, unchanged) AND stashes its last structured result here so a non-CLI caller
// (e.g. a GUI route) can read {label, count, findings} without re-parsing stdout text or
// re-running the scan. Detectors are synchronous and single-threaded per process, so last-run
// storage keyed by label is race-free within one process.
const _lastRun = new Map();

function recordRun(label, findings) {
  _lastRun.set(label, { label, count: findings.length, findings: findings.map(f => String(f).trim()) });
}

// Runs every discipline detector against rows and returns the structured {label,count,findings}
// result for each, without relying on stdout capture. Used by the GUI /api/disciplines route;
// CLI flag handling in cli.js keeps calling the individual named exports directly so its
// existing per-flag stdout report behavior is untouched.
export function runAllDisciplines(rows, maxSamples = 10, manual = false) {
  gitDiscipline(rows, maxSamples, manual);
  searchDiscipline(rows, maxSamples, manual);
  verbBypassDiscipline(rows, maxSamples, manual);
  spoolDiscipline(rows, maxSamples, manual);
  glyphDiscipline(rows, maxSamples, manual);
  return [..._lastRun.values()];
}

export function gitDiscipline(rows, maxSamples = 10, manual = false) {
  const sessions = groupSessions(rows);
  const pushNoPorcelain = [];
  const gmRawGit = [];
  let bashGit = 0;
  for (const evs of sessions.values()) {
    const gm = isGmSession(evs);
    let porcelainSeen = false;
    for (const ev of evs) {
      const b = ev.block || {};
      if (b.type !== 'tool_use' || b.name !== 'Bash') continue;
      const cmd = String(b.input?.command || '');
      if (!/\bgit\b/.test(cmd)) continue;
      bashGit++;
      if (PORCELAIN_RE.test(cmd) && !GIT_PUSH_RE.test(cmd)) porcelainSeen = true;
      if (GIT_PUSH_RE.test(cmd) && !porcelainSeen) pushNoPorcelain.push(sample(ev, cmd, manual));
      if (gm && GIT_COMMIT_RE.test(cmd)) gmRawGit.push(sample(ev, cmd, manual));
      if (GIT_PUSH_RE.test(cmd)) porcelainSeen = false;
    }
  }
  process.stdout.write(`# git-discipline: ${sessions.size} sessions, ${bashGit} raw git Bash events\n`);
  report('git push without a prior separate porcelain status check', pushNoPorcelain, maxSamples);
  report('git push/commit inside a gm session (may indicate spool bypass)', gmRawGit, maxSamples);
  recordRun('git-discipline', [...pushNoPorcelain, ...gmRawGit]);
  return pushNoPorcelain.length + gmRawGit.length;
}

const GM_STATE_PATH_RE = /\.gm[\\\/](prd\.yml|mutables\.yml|exec-spool[\\\/](out|in|instructions)[\\\/]|instructions[\\\/]|daemon-config-reference\.md|next-step\.md)/;

function isExemptKnownPathLookup(toolName, input) {
  const targetPath = String(input?.path || '');
  if (GM_STATE_PATH_RE.test(targetPath)) return true;
  if (toolName === 'Grep' && targetPath && !targetPath.endsWith('/') && /\.[a-zA-Z0-9]+$/.test(targetPath)) return true;
  return false;
}

export function searchDiscipline(rows, maxSamples = 10, manual = false) {
  const sessions = groupSessions(rows);
  const observations = [];
  let gmSessions = 0;
  let exempted = 0;
  for (const evs of sessions.values()) {
    if (!isGmSession(evs)) continue;
    gmSessions++;
    for (const ev of evs) {
      const b = ev.block || {};
      if (b.type !== 'tool_use') continue;
      if (b.name !== 'Grep' && b.name !== 'Glob') continue;
      if (isExemptKnownPathLookup(b.name, b.input)) { exempted++; continue; }
      const detail = `${b.name} ${b.input?.pattern || ''}`;
      observations.push(sample(ev, detail, manual));
    }
  }
  process.stdout.write(`# search-discipline: ${sessions.size} sessions, ${gmSessions} gm sessions, ${exempted} exempt known-path lookups skipped\n`);
  report('Grep/Glob discovery inside gm session (prefer codesearch verb)', observations, maxSamples);
  recordRun('search-discipline', observations);
  return observations.length;
}

function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

const GM_SPOOL_OUT_RE = /\.gm[\\\/]exec-spool[\\\/]out[\\\/]/;
const MEMORY_WRITE_RE = /[\\\/]\.claude[\\\/]projects[\\\/][^\\\/]+[\\\/]memory[\\\/]|[\\\/]\.codex[\\\/]memory[\\\/]|[\\\/]\.cursor[\\\/]/;
const BROWSER_LIB_RE = /\b(puppeteer|playwright)\b/i;
const GIT_LEADING_RE = /^\s*(cd\s+\S+\s*&&\s*)?git\b/;

export function verbBypassDiscipline(rows, maxSamples = 10, manual = false) {
  const sessions = groupSessions(rows);
  const observations = [];
  let gmSessions = 0;
  for (const evs of sessions.values()) {
    if (!isGmSession(evs)) continue;
    gmSessions++;
    for (const ev of evs) {
      const b = ev.block || {};
      if (b.type !== 'tool_use') continue;
      if (b.name === 'WebFetch' || b.name === 'WebSearch') {
        observations.push(sample(ev, `${b.name} ${b.input?.url || b.input?.query || ''} (use fetch verb)`, manual));
      } else if (b.name === 'Task' || b.name === 'Agent') {
        const desc = String(b.input?.description || b.input?.prompt || '');
        if (/\b(find|search|where|locate|grep|look for)\b/i.test(desc)) {
          observations.push(sample(ev, `${b.name} ${desc.slice(0, 80)} (use codesearch verb)`, manual));
        }
      } else if (b.name === 'Bash') {
        const cmd = String(b.input?.command || '');
        if (BROWSER_LIB_RE.test(cmd) && !GIT_LEADING_RE.test(cmd)) {
          observations.push(sample(ev, `Bash ${cmd} (use browser verb)`, manual));
        }
      } else if (b.name === 'Write' && MEMORY_WRITE_RE.test(String(b.input?.file_path || ''))) {
        observations.push(sample(ev, `Write ${b.input?.file_path} (use memorize-fire verb)`, manual));
      }
    }
  }
  process.stdout.write(`# verb-bypass-discipline: ${sessions.size} sessions, ${gmSessions} gm sessions\n`);
  report('platform-native tool used where a plugkit verb exists', observations, maxSamples);
  recordRun('verb-bypass-discipline', observations);
  return observations.length;
}

export function spoolDiscipline(rows, maxSamples = 10, manual = false) {
  const sessions = groupSessions(rows);
  const observations = [];
  let gmSessions = 0;
  for (const evs of sessions.values()) {
    if (!isGmSession(evs)) continue;
    gmSessions++;
    let writes = 0, reads = 0;
    let lastEv = null;
    for (const ev of evs) {
      const b = ev.block || {};
      if (b.type !== 'tool_use') continue;
      if (b.name === 'Write' && GM_SPOOL_RE.test(String(b.input?.file_path || ''))) { writes++; lastEv = ev; }
      if (b.name === 'Read' && GM_SPOOL_OUT_RE.test(String(b.input?.file_path || ''))) reads++;
    }
    if (writes >= 3 && reads === 0) {
      observations.push(sample(lastEv, `${writes} spool dispatch(es) written, 0 out/ responses read -- may indicate fabricated chain`, manual));
    } else if (writes >= 5 && reads > 0 && reads < writes / 3) {
      observations.push(sample(lastEv, `${writes} spool dispatch(es) written, only ${reads} out/ responses read -- may indicate under-witnessed chain`, manual));
    }
  }
  process.stdout.write(`# spool-discipline: ${sessions.size} sessions, ${gmSessions} gm sessions\n`);
  report('spool writes without paired response reads', observations, maxSamples);
  recordRun('spool-discipline', observations);
  return observations.length;
}

export function glyphDiscipline(rows, maxSamples = 10, manual = false) {
  const observations = [];
  let scanned = 0;
  let glyphTotal = 0;
  for (const ev of rows) {
    const b = ev.block || {};
    if (ev.role !== 'assistant' || b.type !== 'text') continue;
    scanned++;
    const text = stripCode(String(b.text || ''));
    const matches = text.match(GLYPH_RE);
    if (!matches || !matches.length) continue;
    glyphTotal += matches.length;
    const uniq = [...new Set(matches)].slice(0, 8).join(' ');
    const ctxIdx = text.search(GLYPH_RE);
    const ctxLen = manual ? 120 : 40;
    const ctx = text.slice(Math.max(0, ctxIdx - ctxLen), ctxIdx + ctxLen);
    observations.push(sample(ev, `${matches.length}x [${uniq}] ...${ctx}...`, manual));
  }
  process.stdout.write(`# glyph-discipline: ${scanned} assistant text blocks scanned, ${glyphTotal} decorative glyphs\n`);
  report('assistant text with decorative non-ASCII glyphs', observations, maxSamples);
  recordRun('glyph-discipline', observations);
  return observations.length;
}
