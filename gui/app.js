import { mount, components as C, h } from 'anentrypoint-design';

const TABS = ['overview', 'sessions', 'projects', 'tools', 'timeline', 'errors', 'subagents', 'live', 'search'];
const state = {
  tab: 'overview',
  data: { snapshot: null, sessions: [], projects: [], tools: [], timeline: [], stats: null, errors: [], subagents: [] },
  query: '',
  searchResults: [],
  searching: false,
  liveLog: [],
};

const api = (p) => fetch(p).then(r => r.json());

async function loadAll() {
  const [snapshot, sessions, projects, tools, timeline, stats, errors, subagents] = await Promise.all([
    api('/api/snapshot'), api('/api/sessions'), api('/api/projects'), api('/api/tools'),
    api('/api/timeline'), api('/api/stats'), api('/api/errors'), api('/api/subagents'),
  ]);
  state.data = { snapshot, sessions, projects, tools, timeline, stats, errors, subagents };
  render();
}

function ts(t) { return new Date(t).toISOString().slice(0, 19).replace('T', ' '); }
function n(v) { return (v || 0).toLocaleString(); }
function dur(ms) { const s = Math.round((ms || 0) / 1000); return s < 60 ? s + 's' : Math.round(s / 60) + 'm'; }

function Stat(lbl, val, sub) {
  return h('div', { class: 'stat' }, h('div', { class: 'lbl' }, lbl), h('div', { class: 'val' }, val), sub ? h('div', { class: 'lbl', style: 'margin-top:4px' }, sub) : null);
}

function Overview() {
  const s = state.data.snapshot || {};
  const st = state.data.stats || { role: {}, type: {}, model: {} };
  return h('div', { class: 'grid' },
    h('div', { class: 'grid cols-4' },
      Stat('events', n(s.events)),
      Stat('sessions', n(s.sessions)),
      Stat('projects', n(s.projects)),
      Stat('tools', n(s.tools)),
      Stat('errors', n(s.errors)),
      Stat('files', n(s.files)),
      Stat('total cost', '$' + (st.totalCostUsd || 0).toFixed(4)),
      Stat('total duration', dur(st.totalDurationMs)),
    ),
    C.Panel({ head: 'roles', children: dist(st.role) }),
    C.Panel({ head: 'block types', children: dist(st.type) }),
    C.Panel({ head: 'models', children: dist(st.model) }),
    C.Panel({ head: 'window', children: h('div', { class: 'row-grid', style: 'grid-template-columns: 140px 1fr' },
      h('span', {}, 'earliest'), h('span', {}, s.earliest ? ts(s.earliest) : '—'),
      h('span', {}, 'latest'), h('span', {}, s.latest ? ts(s.latest) : '—'),
      h('span', {}, 'indexed'), h('span', {}, s.indexedAt ? ts(s.indexedAt) : '—'),
      h('span', {}, 'bytes (text)'), h('span', {}, n(s.bytes)),
    ) }),
  );
}

function dist(map) {
  const entries = Object.entries(map || {}).sort((a, b) => b[1] - a[1]);
  const max = entries[0]?.[1] || 1;
  return h('div', {}, ...entries.map(([k, v]) => h('div', { class: 'row-grid', style: 'grid-template-columns: 200px 80px 1fr' },
    h('span', {}, k), h('span', {}, n(v)),
    h('span', { class: 'bar' }, h('i', { style: `width:${(v / max) * 100}%` })),
  )));
}

function SessionsView() {
  const list = state.data.sessions.slice(0, 200);
  return C.Panel({ head: `sessions · ${list.length}`, children: h('div', {},
    h('div', { class: 'row-grid sessions', style: 'opacity:.55' },
      h('span', {}, 'last'), h('span', {}, 'turns'), h('span', {}, 'tools'), h('span', {}, 'ev'), h('span', {}, 'err'), h('span', {}, 'project · sid')),
    ...list.map(s => h('div', { class: 'row-grid sessions' },
      h('span', {}, ts(s.last).slice(5)),
      h('span', {}, n(s.userTurns)),
      h('span', {}, n(s.tools)),
      h('span', {}, n(s.events)),
      h('span', { class: s.errors ? 'err' : '' }, n(s.errors)),
      h('span', { class: 'truncate' }, (s.isSubagent ? '★ ' : '') + (s.project || '—') + '  ', h('span', { class: 'accent' }, s.sid.slice(0, 8))),
    )),
  ) });
}

function ProjectsView() {
  return C.Panel({ head: `projects · ${state.data.projects.length}`, children: h('div', {},
    h('div', { class: 'row-grid projects', style: 'opacity:.55' },
      h('span', {}, 'project'), h('span', {}, 'sessions'), h('span', {}, 'events'), h('span', {}, 'tools'), h('span', {}, 'last')),
    ...state.data.projects.map(p => h('div', { class: 'row-grid projects' },
      h('span', { class: 'truncate accent' }, p.project),
      h('span', {}, n(p.sessions)),
      h('span', {}, n(p.events)),
      h('span', {}, n(p.tools)),
      h('span', {}, ts(p.last).slice(5)),
    )),
  ) });
}

function ToolsView() {
  const max = state.data.tools[0]?.count || 1;
  return C.Panel({ head: `tools · ${state.data.tools.length}`, children: h('div', {},
    h('div', { class: 'row-grid tools', style: 'opacity:.55' },
      h('span', {}, 'tool'), h('span', {}, 'count'), h('span', {}, 'sessions'), h('span', {}, 'errors'), h('span', {}, 'bar')),
    ...state.data.tools.map(t => h('div', { class: 'row-grid tools' },
      h('span', { class: 'accent' }, t.tool),
      h('span', {}, n(t.count)),
      h('span', {}, n(t.sessions)),
      h('span', { class: t.errors ? 'err' : '' }, n(t.errors)),
      h('span', { class: 'bar' }, h('i', { style: `width:${(t.count / max) * 100}%` })),
    )),
  ) });
}

function TimelineView() {
  const buckets = state.data.timeline;
  const max = buckets.reduce((m, b) => Math.max(m, b.events), 1);
  return C.Panel({ head: `timeline · 1h buckets · ${buckets.length}`, children: h('div', {},
    h('div', { class: 'spark', style: 'padding:12px' }, ...buckets.map(b => h('i', { style: `height:${(b.events / max) * 100}%`, title: `${ts(b.t)}  ev:${b.events} tools:${b.tools} err:${b.errors}` }))),
    h('div', { class: 'row-grid', style: 'grid-template-columns:160px 80px 80px 80px 80px;opacity:.55' },
      h('span', {}, 'bucket'), h('span', {}, 'events'), h('span', {}, 'tools'), h('span', {}, 'sess'), h('span', {}, 'err')),
    ...buckets.slice(-40).reverse().map(b => h('div', { class: 'row-grid', style: 'grid-template-columns:160px 80px 80px 80px 80px' },
      h('span', {}, ts(b.t).slice(5)), h('span', {}, n(b.events)), h('span', {}, n(b.tools)), h('span', {}, n(b.sessions)), h('span', { class: b.errors ? 'err' : '' }, n(b.errors)),
    )),
  ) });
}

function ErrorsView() {
  return C.Panel({ head: `errors · ${state.data.errors.length}`, children: h('div', {},
    h('div', { class: 'row-grid errors', style: 'opacity:.55' }, h('span', {}, 'when'), h('span', {}, 'session'), h('span', {}, 'message')),
    ...state.data.errors.map(e => h('div', { class: 'row-grid errors err' },
      h('span', {}, ts(e.ts).slice(5)),
      h('span', {}, (e.sid || '').slice(0, 8)),
      h('span', { class: 'truncate' }, e.error + (e.recoverable ? ' (recoverable)' : '')),
    )),
  ) });
}

function SubagentsView() {
  return C.Panel({ head: `subagents · ${state.data.subagents.length} parents`, children: h('div', {},
    ...state.data.subagents.map(p => h('div', { style: 'padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.05)' },
      h('div', { class: 'accent' }, 'parent ', p.parent.slice(0, 8), ' · ', n(p.children.length), ' children'),
      ...p.children.map(c => h('div', { class: 'row-grid', style: 'grid-template-columns:90px 100px 1fr' },
        h('span', {}, c.sid.slice(0, 8)), h('span', {}, n(c.events) + ' ev'), h('span', { class: 'truncate' }, c.project || '—'),
      )),
    )),
  ) });
}

function LiveView() {
  return C.Panel({ head: `live · ${state.liveLog.length} events (last 200)`, children: h('div', { class: 'live' },
    ...state.liveLog.slice().reverse().map((e, i) => h('div', { key: i, class: 'e' },
      h('span', { class: 'ts' }, ts(e.ts || Date.now()).slice(11)),
      h('span', { class: 'k' }, e._kind || 'event'),
      h('span', {}, fmtLive(e)),
    )),
  ) });
}

function fmtLive(e) {
  if (e._kind === 'conversation') return 'new ' + (e.conv?.title || e.conv?.id?.slice(0, 8));
  if (e._kind === 'start' || e._kind === 'complete') return (e.sid || '').slice(0, 8);
  if (e._kind === 'error') return e.error;
  const tag = `${e.role || ''}/${e.type || ''}` + (e.tool ? ':' + e.tool : '');
  return tag + '  ' + (e.text || '').slice(0, 200);
}

function SearchView() {
  return C.Panel({ head: `bm25 search · ${state.searchResults.length} hits`, children: h('div', {},
    h('div', { style: 'padding:12px' },
      h('input', {
        class: 'search', placeholder: 'query (BM25 over all event text)…', value: state.query,
        oninput: (e) => { state.query = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter') doSearch(); },
      }),
      h('div', { style: 'margin-top:8px;font-size:11px;opacity:.6' }, state.searching ? 'searching…' : 'enter to search · zero deps · idf-weighted'),
    ),
    h('div', { class: 'row-grid search', style: 'opacity:.55' },
      h('span', {}, 'score'), h('span', {}, 'when'), h('span', {}, 'role'), h('span', {}, 'tool'), h('span', {}, 'snippet')),
    ...state.searchResults.map(r => h('div', { class: 'row-grid search' },
      h('span', { class: 'accent' }, r.score.toFixed(2)),
      h('span', {}, ts(r.ts).slice(5)),
      h('span', {}, r.role + '/' + (r.type || '?')),
      h('span', {}, r.tool || '—'),
      h('span', { class: 'truncate' }, h('span', { class: 'pill' }, r.project || '—'), r.snippet),
    )),
  ) });
}

async function doSearch() {
  if (!state.query.trim()) return;
  state.searching = true; render();
  const res = await api('/api/search?q=' + encodeURIComponent(state.query) + '&limit=200');
  state.searchResults = res.results || [];
  state.searching = false; render();
}

const VIEWS = { overview: Overview, sessions: SessionsView, projects: ProjectsView, tools: ToolsView, timeline: TimelineView, errors: ErrorsView, subagents: SubagentsView, live: LiveView, search: SearchView };

function App() {
  const s = state.data.snapshot || {};
  return C.AppShell({
    topbar: C.Topbar({
      brand: '247420', leaf: 'ccsniff',
      items: TABS.map(t => [t, '#/' + t]),
      active: state.tab,
      onNav: (t) => { state.tab = t; location.hash = '#/' + t; render(); },
    }),
    main: h('div', { style: 'padding:16px;display:flex;flex-direction:column;gap:16px' },
      C.Crumb({ trail: ['247420', 'ccsniff'], leaf: state.tab, right: h('span', { class: 'pill' }, n(s.events) + ' events') }),
      (VIEWS[state.tab] || Overview)(),
    ),
    status: C.Status({
      left: ['ccsniff', '·', n(s.sessions) + ' sessions', '·', n(s.events) + ' events'],
      right: [state.searching ? 'searching' : 'live', '·', s.indexedAt ? ts(s.indexedAt).slice(11) : '—'],
    }),
  });
}

const root = document.getElementById('app');
function render() { mount(root, App); window.__ccsniff = { state, render, doSearch }; }
render();

(function initRoute() {
  const h0 = (location.hash || '').replace(/^#\//, '');
  if (TABS.includes(h0)) state.tab = h0;
})();

(async function init() {
  await loadAll();
  setInterval(loadAll, 15_000);
  const sse = new EventSource('/api/stream');
  const push = (kind, data) => {
    const item = { ...data, _kind: kind, ts: data?.ts || Date.now() };
    state.liveLog.push(item);
    if (state.liveLog.length > 200) state.liveLog = state.liveLog.slice(-200);
    if (state.tab === 'live') render();
  };
  sse.addEventListener('event', e => push('event', JSON.parse(e.data)));
  sse.addEventListener('error', e => { try { push('error', JSON.parse(e.data)); } catch {} });
  sse.addEventListener('start', e => push('start', JSON.parse(e.data)));
  sse.addEventListener('complete', e => push('complete', JSON.parse(e.data)));
  sse.addEventListener('conversation', e => push('conversation', JSON.parse(e.data)));
})();
