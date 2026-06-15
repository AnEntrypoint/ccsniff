export const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/^\/([a-z])\//i, '$1:/').replace(/\/+$/, '').toLowerCase();

export const stripQuoted = (s) => s.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])*'/g, "''");

const isAbs = (d) => d.startsWith('/') || /^[a-z]:/.test(d);

export function targetsOutsideCwd(line, cwd) {
  const cwdN = normPath(cwd);
  if (!cwdN) return false;
  const stripped = stripQuoted(line).replace(/\\/g, '/');
  const ctxM = stripped.match(/(?:^|[|&;]\s*)(?:cd|pushd)\s+([^\s|&;]+)/i) || stripped.match(/\bgit\s+-C\s+([^\s|&;]+)/i);
  if (ctxM) { const d = normPath(ctxM[1]); if (isAbs(d) && !d.startsWith(cwdN)) return true; }
  const absArgs = stripped.match(/(?:^|\s)((?:[a-z]:)?\/[^\s|&;"']+)/gi) || [];
  for (const a of absArgs) { const d = normPath(a.trim()); if (isAbs(d) && !d.startsWith(cwdN)) return true; }
  return false;
}

export function targetsSingleFile(line) {
  let s = stripQuoted(line).split('|')[0];
  s = s.replace(/\d*>>?\s*&?\s*\S+/g, ' ').replace(/<\s*\S+/g, ' ');
  if (!/\b(grep|egrep|fgrep|rg|ag|ack)\b/.test(s)) return false;
  if (/\s-[a-z]*[rR]\b|--recursive/.test(s)) return false;
  const toks = s.trim().split(/\s+/);
  const last = toks[toks.length - 1];
  if (!last || last.startsWith('-')) return false;
  if (/[*?{}\[\]]/.test(last)) return false;
  if (last.endsWith('/')) return false;
  return /\.[a-z0-9]{1,6}$/i.test(last) && !last.includes('|');
}
