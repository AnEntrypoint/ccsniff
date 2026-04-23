import * as webjsx from 'webjsx';
const h = webjsx.createElement;

const VERSION = 'v1.0.2';
const INSTALL = 'npm install ccpeek';
const REPO = 'https://github.com/AnEntrypoint/ccpeek';
const NPM = 'https://www.npmjs.com/package/ccpeek';

const state = { tab: 'overview', copied: false };
const root = document.getElementById('root');

const EVENTS = [
    { name: 'conversation_created', desc: 'new claude code session detected (new jsonl file with unknown sessionId).', payload: '{ conversation: { id, title, cwd }, timestamp }' },
    { name: 'streaming_start',      desc: 'agent started generating output. fires on system init or first assistant message.', payload: '{ conversationId, conversation, timestamp }' },
    { name: 'streaming_progress',   desc: 'a content block was emitted. block.type is text | tool_use | tool_result | system | result.', payload: '{ conversationId, conversation, block, role, seq, timestamp }' },
    { name: 'streaming_complete',   desc: 'agent turn finished (system turn_duration or stop_hook_summary or result received).', payload: '{ conversationId, conversation, seq, timestamp }' },
    { name: 'streaming_error',      desc: 'rate limit or unrecoverable error. recoverable=true means the agent may retry.', payload: '{ conversationId, error, recoverable, timestamp }' },
    { name: 'error',                desc: 'internal watcher error (file i/o failure, fs.watch failure). standard node.js error event.', payload: 'Error' }
];

const API = [
    { sig: 'watch(projectsDir?) → JsonlWatcher', desc: 'factory. creates a watcher, calls .start(), returns instance. projectsDir defaults to ~/.claude/projects.' },
    { sig: 'new JsonlWatcher(projectsDir?)',     desc: 'class constructor. call .start() manually after attaching listeners.' },
    { sig: 'watcher.start() → this',             desc: 'scans projectsDir recursively for existing .jsonl files, then sets up an fs.watch listener. chainable.' },
    { sig: 'watcher.stop()',                     desc: 'closes all open file descriptors, clears debounce timers, removes the directory watcher. call on SIGINT.' },
    { sig: 'watcher.on(event, handler) → this',  desc: 'standard EventEmitter.on. chainable. see events for all names and payload shapes.' }
];

const DEMO = [
    ['conversation_created', 'main @ myproject — new session detected'],
    ['streaming_start',      'conversationId: abc123'],
    ['streaming_progress',   'role=system subtype=init model=claude-opus-4-7'],
    ['streaming_progress',   'role=assistant type=text "let me look at the codebase..."'],
    ['streaming_progress',   'role=assistant type=tool_use name=Read input={path:"src/index.js"}'],
    ['streaming_progress',   'role=tool_result type=tool_result content=[{type:"text"...}]'],
    ['streaming_progress',   'role=assistant type=text "i found the issue. here is the fix..."'],
    ['streaming_progress',   'role=result subtype=success duration_ms=4231 cost=$0.0042'],
    ['streaming_complete',   'seq=8 conversationId: abc123']
];

const side = [
    { group: 'project', items: [
        ['◆', 'overview',  'overview'],
        ['§', 'install',   'install'],
        ['§', 'events',    'events'],
        ['§', 'api',       'api'],
        ['§', 'demo',      'demo']
    ]},
    { group: 'events', items: EVENTS.map(e => ['›', e.name, 'events']) },
    { group: 'links', items: [
        ['↗', 'github',   REPO],
        ['↗', 'npm',      NPM],
        ['↗', 'releases', REPO + '/releases']
    ]}
];

function Topbar() {
    const tab = (id, label) => h('a', {
        href: '#' + id,
        class: state.tab === id ? 'active' : '',
        onclick: (e) => { e.preventDefault(); state.tab = id; render(); scrollTo(id); }
    }, label);
    return h('header', { class: 'app-topbar' },
        h('span', { class: 'brand' }, '247420', h('span', { class: 'slash' }, ' / '), 'ccpeek'),
        h('nav', {},
            tab('overview', 'overview'),
            tab('install',  'install'),
            tab('events',   'events'),
            tab('api',      'api'),
            tab('demo',     'demo'),
            h('a', { href: REPO, target: '_blank', rel: 'noopener' }, 'source ↗')
        )
    );
}

function Crumb() {
    return h('div', { class: 'app-crumb' },
        h('span', {}, '247420'), h('span', { class: 'sep' }, '›'),
        h('span', {}, 'ccpeek'), h('span', { class: 'sep' }, '›'),
        h('span', { class: 'leaf' }, state.tab),
        h('span', { style: 'margin-left:auto;display:flex;gap:10px;align-items:center' },
            h('span', { class: 'chip accent' }, '● live'),
            h('span', { class: 'chip dim' }, VERSION)
        )
    );
}

function Side() {
    return h('aside', { class: 'app-side' }, ...side.flatMap(sec => [
        h('div', { class: 'group', key: sec.group }, sec.group),
        ...sec.items.map(([glyph, label, target], i) => {
            const isHref = typeof target === 'string' && target.startsWith('http');
            return h('a', {
                key: sec.group + i,
                href: isHref ? target : ('#' + target),
                target: isHref ? '_blank' : null,
                rel: isHref ? 'noopener' : null,
                class: !isHref && state.tab === target ? 'active' : '',
                onclick: isHref ? null : (e) => { e.preventDefault(); state.tab = target; render(); scrollTo(target); }
            },
                h('span', { class: 'glyph' }, glyph),
                h('span', {}, label)
            );
        })
    ]));
}

function scrollTo(id) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function Install() {
    return h('div', { class: 'cli' },
        h('span', { class: 'prompt' }, '$'),
        h('span', { class: 'cmd' }, INSTALL),
        h('span', {
            class: 'copy',
            onclick: () => {
                navigator.clipboard?.writeText(INSTALL);
                state.copied = true; render();
                setTimeout(() => { state.copied = false; render(); }, 1200);
            }
        }, state.copied ? 'copied' : 'copy')
    );
}

function Receipt() {
    const rows = [
        ['status',       'live · node >= 18'],
        ['package',      'ccpeek'],
        ['version',      VERSION],
        ['license',      'MIT'],
        ['lang',         'javascript · esm + cjs'],
        ['deps',         '0 runtime'],
        ['source',       'AnEntrypoint/ccpeek'],
        ['surface',      'jsonlwatcher · watch()']
    ];
    return h('table', { class: 'kv' },
        h('tbody', {}, ...rows.map(([k, v], i) =>
            h('tr', { key: i }, h('td', {}, k), h('td', {}, v))
        ))
    );
}

function Pre({ children }) {
    return h('pre', {}, h('code', { innerHTML: children }));
}

const ESM_SNIPPET =
`<span class="k">import</span> { watch } <span class="k">from</span> <span class="s">'ccpeek'</span>;

<span class="k">const</span> watcher = <span class="k">watch</span>()
  .<span class="k">on</span>(<span class="s">'conversation_created'</span>, ({ conversation }) =&gt; {
    <span class="c">// new session detected</span>
    console.log(<span class="s">'new session:'</span>, conversation.title);
  })
  .<span class="k">on</span>(<span class="s">'streaming_progress'</span>, ({ block, role }) =&gt; {
    <span class="k">if</span> (block.type === <span class="s">'text'</span>) process.stdout.write(block.text);
  })
  .<span class="k">on</span>(<span class="s">'streaming_complete'</span>, ({ conversationId }) =&gt; {
    console.log(<span class="s">'\\ndone:'</span>, conversationId);
  });

process.on(<span class="s">'SIGINT'</span>, () =&gt; watcher.stop());`;

const CJS_SNIPPET =
`<span class="k">const</span> { watch, JsonlWatcher } = <span class="k">require</span>(<span class="s">'ccpeek'</span>);

<span class="c">// default ~/.claude/projects dir</span>
<span class="k">const</span> watcher = <span class="k">watch</span>();

<span class="c">// or pass a custom directory</span>
<span class="k">const</span> custom = <span class="k">watch</span>(<span class="s">'/path/to/projects'</span>);

<span class="c">// or use the class directly</span>
<span class="k">const</span> w = <span class="k">new</span> JsonlWatcher(<span class="s">'/custom/dir'</span>);
w.start();
w.on(<span class="s">'streaming_start'</span>, (e) =&gt; console.log(e));`;

function EventsSection() {
    return h('div', { class: 'panel' },
        h('div', { class: 'panel-head' },
            h('span', {}, 'emitter events'),
            h('span', {}, EVENTS.length + ' total')
        ),
        h('div', { class: 'panel-body' },
            ...EVENTS.map((ev, i) =>
                h('div', { key: i, class: 'row', style: 'grid-template-columns:200px 1fr;align-items:start' },
                    h('span', { class: 'code' }, ev.name),
                    h('span', {},
                        h('div', { class: 'title' }, ev.desc),
                        h('div', { class: 'sub', style: 'margin-left:0;font-family:var(--ff-mono);margin-top:4px;color:var(--panel-text-2)' }, ev.payload)
                    )
                )
            )
        )
    );
}

function ApiSection() {
    return h('div', { class: 'panel' },
        h('div', { class: 'panel-head' },
            h('span', {}, 'api surface'),
            h('span', {}, 'esm + cjs')
        ),
        h('div', { class: 'panel-body' },
            ...API.map((a, i) =>
                h('div', { key: i, class: 'row', style: 'grid-template-columns:340px 1fr;align-items:start' },
                    h('span', { class: 'code', style: 'color:var(--panel-accent)' }, a.sig),
                    h('span', { class: 'title' }, a.desc)
                )
            )
        )
    );
}

function DemoSection() {
    return h('div', { class: 'panel', style: 'max-width:900px' },
        h('div', { class: 'panel-head' },
            h('span', {}, 'live event stream'),
            h('span', {}, 'synthetic · loops')
        ),
        h('div', { class: 'panel-body', style: 'max-height:340px;overflow-y:auto;padding:8px 0', id: 'demoStream' })
    );
}

function Overview() {
    return [
        h('h1', { id: 'overview' }, 'ccpeek'),
        h('p', { class: 'lede' }, 'watch claude code jsonl output files and emit structured events — streaming starts, tool calls, results — as a standard node.js EventEmitter. quiet chrome, loud events.'),

        h('h3', { id: 'install' }, 'install'),
        Install(),

        h('h3', {}, 'receipt'),
        Receipt(),

        h('h3', {}, 'esm / typescript'),
        Pre({ children: ESM_SNIPPET }),

        h('h3', {}, 'commonjs'),
        Pre({ children: CJS_SNIPPET }),

        h('h3', { id: 'events' }, 'events'),
        h('p', {}, 'every event fires on the watcher\'s EventEmitter with a consistent payload shape.'),
        EventsSection(),

        h('h3', { id: 'api' }, 'api'),
        ApiSection(),

        h('h3', { id: 'demo' }, 'demo'),
        h('p', {}, 'this is what ccpeek emits when claude code runs. synthetic stream, loops forever.'),
        DemoSection()
    ];
}

function Status() {
    return h('footer', { class: 'app-status' },
        h('span', { class: 'item' }, 'main'),
        h('span', { class: 'item' }, '• javascript'),
        h('span', { class: 'item' }, '• 0 deps'),
        h('span', { class: 'item' }, '• node >= 18'),
        h('span', { class: 'spread' }),
        h('span', { class: 'item' }, VERSION),
        h('span', { class: 'item' }, '• MIT')
    );
}

function App() {
    return h('div', { class: 'app' },
        Topbar(),
        Crumb(),
        h('div', { class: 'app-body' },
            Side(),
            h('main', { class: 'app-main narrow' }, ...Overview())
        ),
        Status()
    );
}

function render() { webjsx.applyDiff(root, App()); }
render();

function ts() {
    const d = new Date();
    return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function animateDemo() {
    const stream = document.getElementById('demoStream');
    if (!stream) { setTimeout(animateDemo, 200); return; }
    let i = 0;
    function add() {
        const cur = document.getElementById('demoStream');
        if (!cur) return;
        if (i >= DEMO.length) { setTimeout(() => { cur.innerHTML = ''; i = 0; add(); }, 2000); return; }
        const [ev, content] = DEMO[i++];
        const line = document.createElement('div');
        line.className = 'row';
        line.style.cssText = 'grid-template-columns:100px 180px 1fr;padding:4px 16px;cursor:default;font-family:var(--ff-mono);font-size:12px';
        line.innerHTML =
            '<span class="code">' + ts() + '</span>' +
            '<span style="color:var(--panel-accent)">' + ev + '</span>' +
            '<span style="color:var(--panel-text-2)">' + content + '</span>';
        cur.appendChild(line);
        cur.scrollTop = cur.scrollHeight;
        setTimeout(add, 400 + Math.random() * 600);
    }
    add();
}
animateDemo();
