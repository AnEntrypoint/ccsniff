const { createElement: h, render, Fragment } = window.webjsx || {};

const EVENTS = [
  {
    name: 'conversation_created',
    desc: 'Fired when a new Claude Code session is detected for the first time (new JSONL file with unknown sessionId).',
    payload: '{ conversation: { id, title, cwd }, timestamp }'
  },
  {
    name: 'streaming_start',
    desc: 'Agent started generating output. Fired on system init or first assistant message.',
    payload: '{ conversationId, conversation, timestamp }'
  },
  {
    name: 'streaming_progress',
    desc: 'A content block was emitted. block.type can be "text", "tool_use", "tool_result", "system", "result", etc.',
    payload: '{ conversationId, conversation, block, role, seq, timestamp }'
  },
  {
    name: 'streaming_complete',
    desc: 'Agent turn finished (system turn_duration or stop_hook_summary or result received).',
    payload: '{ conversationId, conversation, seq, timestamp }'
  },
  {
    name: 'streaming_error',
    desc: 'Rate limit or unrecoverable error encountered. recoverable=true means the agent may retry.',
    payload: '{ conversationId, error, recoverable, timestamp }'
  },
  {
    name: 'error',
    desc: 'Internal watcher error (file I/O failure, fs.watch failure). Standard Node.js error event.',
    payload: 'Error'
  }
];

const API_ROWS = [
  {
    sig: '<span class="fn-name">watch</span>(<span class="param">projectsDir?</span>): <span class="ret">JsonlWatcher</span>',
    desc: 'Factory — creates a JsonlWatcher, calls .start(), and returns the instance. projectsDir defaults to ~/.claude/projects.'
  },
  {
    sig: '<span class="fn-name">new JsonlWatcher</span>(<span class="param">projectsDir?</span>)',
    desc: 'Class constructor. Call .start() manually after attaching listeners.'
  },
  {
    sig: 'watcher.<span class="fn-name">start</span>(): <span class="ret">this</span>',
    desc: 'Scans projectsDir recursively for existing .jsonl files, then sets up an fs.watch listener for changes. Returns this for chaining.'
  },
  {
    sig: 'watcher.<span class="fn-name">stop</span>()',
    desc: 'Closes all open file descriptors, clears debounce timers, and removes the directory watcher. Call on SIGINT/SIGTERM.'
  },
  {
    sig: 'watcher.<span class="fn-name">on</span>(<span class="param">event</span>, <span class="param">handler</span>): <span class="ret">this</span>',
    desc: 'Standard EventEmitter.on. Returns this for chaining. See Events section for all event names and payload shapes.'
  }
];

const DEMO_EVENTS = [
  { event: 'conversation_created', content: 'main @ myproject — new session detected' },
  { event: 'streaming_start', content: 'conversationId: abc123' },
  { event: 'streaming_progress', content: 'role=system subtype=init model=claude-opus-4-5' },
  { event: 'streaming_progress', content: 'role=assistant type=text "Let me look at the codebase..."' },
  { event: 'streaming_progress', content: 'role=assistant type=tool_use name=Read input={path: "src/index.js"}' },
  { event: 'streaming_progress', content: 'role=tool_result type=tool_result content=[{type:"text"...}]' },
  { event: 'streaming_progress', content: 'role=assistant type=text "I found the issue. Here is the fix..."' },
  { event: 'streaming_progress', content: 'role=result subtype=success duration_ms=4231 cost=$0.0042' },
  { event: 'streaming_complete', content: 'seq=8 conversationId: abc123' }
];

function EventsTable() {
  return h(Fragment, null, EVENTS.map(ev =>
    h('div', { class: 'event-row' },
      h('div', { class: 'event-name' }, ev.name),
      h('div', { class: 'event-desc' }, ev.desc),
      h('div', { class: 'event-payload' }, ev.payload)
    )
  ));
}

function ApiTable() {
  return h(Fragment, null, API_ROWS.map(row =>
    h('div', { class: 'api-row' },
      h('div', { class: 'api-sig', innerHTML: row.sig }),
      h('div', { class: 'api-desc' }, row.desc)
    )
  ));
}

function DemoLine({ event, content, ts }) {
  return h('div', { class: 'demo-line' },
    h('span', { class: 'demo-ts' }, ts),
    h('span', { class: 'demo-event' }, event),
    h('span', { class: 'demo-content' }, content)
  );
}

function Demo() {
  return h('div', { class: 'demo-stream', id: 'demoStream' });
}

function mount() {
  const eventsRoot = document.getElementById('eventsRoot');
  const apiRoot = document.getElementById('apiRoot');
  const demoRoot = document.getElementById('demoRoot');

  if (eventsRoot) {
    const grid = document.createElement('div');
    grid.className = 'events-grid';
    eventsRoot.appendChild(grid);
    if (window.webjsx) render(h(EventsTable), grid);
    else grid.innerHTML = EVENTS.map(ev =>
      `<div class="event-row"><div class="event-name">${ev.name}</div><div class="event-desc">${ev.desc}</div><div class="event-payload">${ev.payload}</div></div>`
    ).join('');
  }

  if (apiRoot) {
    const grid = document.createElement('div');
    grid.className = 'api-grid';
    apiRoot.appendChild(grid);
    if (window.webjsx) render(h(ApiTable), grid);
    else grid.innerHTML = API_ROWS.map(row =>
      `<div class="api-row"><div class="api-sig">${row.sig}</div><div class="api-desc">${row.desc}</div></div>`
    ).join('');
  }

  if (demoRoot) {
    const stream = document.createElement('div');
    stream.className = 'demo-stream';
    demoRoot.appendChild(stream);
    animateDemo(stream);
  }
}

function ts() {
  const d = new Date();
  return d.toTimeString().slice(0,8) + '.' + String(d.getMilliseconds()).padStart(3,'0');
}

function animateDemo(container) {
  let i = 0;
  function addLine() {
    if (i >= DEMO_EVENTS.length) {
      setTimeout(() => { container.innerHTML = ''; i = 0; addLine(); }, 2000);
      return;
    }
    const ev = DEMO_EVENTS[i++];
    const line = document.createElement('div');
    line.className = 'demo-line';
    line.innerHTML = `<span class="demo-ts">${ts()}</span><span class="demo-event">${ev.event}</span><span class="demo-content">${ev.content}</span>`;
    container.appendChild(line);
    container.scrollTop = container.scrollHeight;
    setTimeout(addLine, 400 + Math.random() * 600);
  }
  addLine();
}

function setupTheme() {
  const btn = document.getElementById('themeToggle');
  const icon = btn && btn.querySelector('.theme-icon');
  const stored = localStorage.getItem('ccwatch-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initial = stored || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', initial);
  if (icon) icon.textContent = initial === 'dark' ? '☀' : '☾';

  if (btn) btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('ccwatch-theme', next);
    if (icon) icon.textContent = next === 'dark' ? '☀' : '☾';
  });
}

function setupCopy() {
  const btn = document.getElementById('copyInstall');
  const cmd = document.getElementById('installCmd');
  if (!btn || !cmd) return;
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(cmd.textContent).then(() => {
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = '⎘'; }, 1500);
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setupTheme();
  setupCopy();
  mount();
});
