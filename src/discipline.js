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

function sample(ev, detail) {
  const sid = (ev.conversation?.id || '?').slice(0, 8);
  const iso = new Date(ev.timestamp || 0).toISOString().slice(0, 19).replace('T', ' ');
  const repo = path.basename(ev.conversation?.cwd || '');
  const text = String(detail).replace(/\s+/g, ' ').slice(0, 160);
  return `  [${iso}] [${repo}] ${sid}  ${text}\n`;
}

function report(label, findings, maxSamples) {
  process.stdout.write(`# ${label}: ${findings.length} finding(s)\n`);
  for (const f of findings.slice(0, maxSamples)) process.stdout.write(f);
  if (findings.length > maxSamples) process.stdout.write(`  ... ${findings.length - maxSamples} more\n`);
}

export function gitDiscipline(rows, maxSamples = 10) {
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
      if (GIT_PUSH_RE.test(cmd) && !porcelainSeen) pushNoPorcelain.push(sample(ev, cmd));
      if (gm && GIT_COMMIT_RE.test(cmd)) gmRawGit.push(sample(ev, cmd));
      if (GIT_PUSH_RE.test(cmd)) porcelainSeen = false;
    }
  }
  process.stdout.write(`# git-discipline: ${sessions.size} sessions, ${bashGit} raw git Bash events\n`);
  report('push without prior separate porcelain event', pushNoPorcelain, maxSamples);
  report('raw git push/commit inside gm session (spool bypass)', gmRawGit, maxSamples);
  return pushNoPorcelain.length + gmRawGit.length;
}

export function searchDiscipline(rows, maxSamples = 10) {
  const sessions = groupSessions(rows);
  const findings = [];
  let gmSessions = 0;
  for (const evs of sessions.values()) {
    if (!isGmSession(evs)) continue;
    gmSessions++;
    for (const ev of evs) {
      const b = ev.block || {};
      if (b.type !== 'tool_use') continue;
      if (b.name !== 'Grep' && b.name !== 'Glob') continue;
      const detail = `${b.name} ${b.input?.pattern || ''}`;
      findings.push(sample(ev, detail));
    }
  }
  process.stdout.write(`# search-discipline: ${sessions.size} sessions, ${gmSessions} gm sessions\n`);
  report('Grep/Glob discovery inside gm session', findings, maxSamples);
  return findings.length;
}

function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

const GM_SPOOL_OUT_RE = /\.gm[\\\/]exec-spool[\\\/]out[\\\/]/;
const MEMORY_WRITE_RE = /[\\\/]\.claude[\\\/]projects[\\\/][^\\\/]+[\\\/]memory[\\\/]|[\\\/]\.codex[\\\/]memory[\\\/]|[\\\/]\.cursor[\\\/]/;
const BROWSER_LIB_RE = /\b(puppeteer|playwright)\b/i;
const GIT_LEADING_RE = /^\s*(cd\s+\S+\s*&&\s*)?git\b/;

export function verbBypassDiscipline(rows, maxSamples = 10) {
  const sessions = groupSessions(rows);
  const findings = [];
  let gmSessions = 0;
  for (const evs of sessions.values()) {
    if (!isGmSession(evs)) continue;
    gmSessions++;
    for (const ev of evs) {
      const b = ev.block || {};
      if (b.type !== 'tool_use') continue;
      if (b.name === 'WebFetch' || b.name === 'WebSearch') {
        findings.push(sample(ev, `${b.name} ${b.input?.url || b.input?.query || ''} (use fetch verb)`));
      } else if (b.name === 'Task' || b.name === 'Agent') {
        const desc = String(b.input?.description || b.input?.prompt || '');
        if (/\b(find|search|where|locate|grep|look for)\b/i.test(desc)) {
          findings.push(sample(ev, `${b.name} ${desc.slice(0, 80)} (use codesearch verb)`));
        }
      } else if (b.name === 'Bash') {
        const cmd = String(b.input?.command || '');
        // A git command (commit -m heredoc body, push, etc) merely MENTIONING
        // puppeteer/playwright in prose text is not a bypass -- only flag when
        // the command isn't git-led, so a commit message describing this exact
        // detector doesn't trip itself.
        if (BROWSER_LIB_RE.test(cmd) && !GIT_LEADING_RE.test(cmd)) {
          findings.push(sample(ev, `Bash ${cmd} (use browser verb)`));
        }
      } else if (b.name === 'Write' && MEMORY_WRITE_RE.test(String(b.input?.file_path || ''))) {
        findings.push(sample(ev, `Write ${b.input?.file_path} (use memorize-fire verb)`));
      }
    }
  }
  process.stdout.write(`# verb-bypass-discipline: ${sessions.size} sessions, ${gmSessions} gm sessions\n`);
  report('platform-native tool used where a plugkit verb exists', findings, maxSamples);
  return findings.length;
}

export function spoolDiscipline(rows, maxSamples = 10) {
  const sessions = groupSessions(rows);
  const findings = [];
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
      findings.push(sample(lastEv, `${writes} spool dispatch(es) written, 0 out/ responses read -- fabricated chain`));
    } else if (writes >= 5 && reads > 0 && reads < writes / 3) {
      findings.push(sample(lastEv, `${writes} spool dispatch(es) written, only ${reads} out/ responses read -- under-witnessed chain`));
    }
  }
  process.stdout.write(`# spool-discipline: ${sessions.size} sessions, ${gmSessions} gm sessions\n`);
  report('spool writes without paired response reads (fabricated chain)', findings, maxSamples);
  return findings.length;
}

export function glyphDiscipline(rows, maxSamples = 10) {
  const findings = [];
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
    const ctx = text.slice(Math.max(0, ctxIdx - 40), ctxIdx + 40);
    findings.push(sample(ev, `${matches.length}x [${uniq}] ...${ctx}...`));
  }
  process.stdout.write(`# glyph-discipline: ${scanned} assistant text blocks scanned, ${glyphTotal} decorative glyphs\n`);
  report('assistant text with decorative non-ASCII glyphs', findings, maxSamples);
  return findings.length;
}
