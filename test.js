import { strict as assert } from 'assert';
import os from 'os';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { buildIndex, search, tokenize } from './src/bm25.js';
import { createServer } from './src/gui-server.js';
import { toUnslothMessages, toShareGPT } from './src/unsloth.js';
import { targetsOutsideCwd, targetsSingleFile } from './src/discipline-helpers.js';

function testSearchDisciplineExemptions() {
  const CWD = 'C:/dev/gm';
  const cases = [
    ['git -C sibling exempt', () => targetsOutsideCwd('git -C /c/dev/rs-plugkit grep X', CWD), true],
    ['cd sibling exempt', () => targetsOutsideCwd('cd /c/dev/ccsniff; grep X', CWD), true],
    ['pushd sibling exempt', () => targetsOutsideCwd('pushd /c/dev/ccsniff; grep X', CWD), true],
    ['git -C inside cwd not exempt', () => targetsOutsideCwd('git -C /c/dev/gm/sub grep X', CWD), false],
    ['msys path form normalized', () => targetsOutsideCwd('grep X /c/dev/rs-learn/src/a.rs', CWD), true],
    ['single file exempt', () => targetsSingleFile('grep -n writeStatus gm-plugkit/wrapper.js'), true],
    ['single file with redirect exempt', () => targetsSingleFile("grep -n pat src/entry.rs 2>/dev/null"), true],
    ['recursive tree not single', () => targetsSingleFile('grep -r X src/'), false],
    ['glob not single', () => targetsSingleFile('grep X **/*.js'), false],
    ['dir target not single', () => targetsSingleFile('grep -n X src/'), false],
    ['no-path not single', () => targetsSingleFile('grep writeStatus'), false],
    ['in-cwd file flagged via single-exempt-only', () => targetsSingleFile('grep -n writeStatus gm-plugkit/wrapper.js') && !targetsOutsideCwd('grep -n writeStatus gm-plugkit/wrapper.js', CWD), true],
  ];
  for (const [desc, fn, want] of cases) assert.equal(fn(), want, `search-discipline exemption: ${desc}`);
  console.log(`ok search-discipline exemptions (${cases.length} cases)`);
}

function get(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, body: d })); }).on('error', rej);
  });
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsniff-test-'));
  const proj = path.join(dir, 'sample-project', 'sub');
  fs.mkdirSync(proj, { recursive: true });
  const sid = '11111111-aaaa-bbbb-cccc-222222222222';
  const file = path.join(proj, sid + '.jsonl');
  const baseTs = Date.now() - 5_000;
  const lines = [
    { type: 'system', subtype: 'init', sessionId: sid, model: 'claude-opus', cwd: proj, timestamp: new Date(baseTs).toISOString() },
    { type: 'user', sessionId: sid, message: { content: [{ type: 'text', text: 'please search for foobar in the codebase' }] }, timestamp: new Date(baseTs + 100).toISOString() },
    { type: 'assistant', sessionId: sid, message: { id: 'm1', content: [{ type: 'text', text: 'I will search for foobar across files.' }, { type: 'tool_use', name: 'Grep', input: { pattern: 'foobar' } }] }, timestamp: new Date(baseTs + 200).toISOString() },
    { type: 'assistant', sessionId: sid, message: { id: 'm2', content: [{ type: 'text', text: 'Found unrelated lorem ipsum content.' }] }, timestamp: new Date(baseTs + 300).toISOString() },
    { type: 'result', sessionId: sid, result: 'ok', subtype: 'success', duration_ms: 1234, total_cost_usd: 0.0042, timestamp: new Date(baseTs + 400).toISOString() },
  ];
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return dir;
}

async function main() {
  testSearchDisciplineExemptions();
  // BM25 unit
  const docs = ['the quick brown foobar jumps', 'lorem ipsum dolor sit', 'foobar foobar foobar wins'];
  const idx = buildIndex(docs, d => d);
  const r = search(idx, 'foobar');
  assert.equal(r[0].i, 2, 'BM25: highest tf wins');
  assert.equal(tokenize('Hello, world! 42').includes('hello'), true);
  console.log('ok bm25');

  const projectsDir = makeFixture();
  const srv = await createServer({ projectsDir, port: 0, host: '127.0.0.1' });
  try {
    const snap = JSON.parse((await get(srv.url + '/api/snapshot')).body);
    assert.ok(snap.events > 0, 'events loaded');
    assert.ok(snap.sessions >= 1, 'sessions loaded');
    assert.ok(snap.files >= 1, 'files counted');
    console.log('ok snapshot', snap);

    const sessions = JSON.parse((await get(srv.url + '/api/sessions')).body);
    assert.ok(sessions.length >= 1);
    assert.ok(sessions[0].userTurns >= 1);
    console.log('ok sessions');

    const projects = JSON.parse((await get(srv.url + '/api/projects')).body);
    assert.ok(projects.find(p => p.project === 'sub'));
    console.log('ok projects');

    const tools = JSON.parse((await get(srv.url + '/api/tools')).body);
    assert.ok(tools.find(t => t.tool === 'Grep'));
    console.log('ok tools');

    const tl = JSON.parse((await get(srv.url + '/api/timeline')).body);
    assert.ok(tl.length >= 1);
    console.log('ok timeline');

    const stats = JSON.parse((await get(srv.url + '/api/stats')).body);
    assert.ok(stats.role.assistant >= 1);
    console.log('ok stats');

    const sa = JSON.parse((await get(srv.url + '/api/subagents')).body);
    assert.ok(Array.isArray(sa));
    console.log('ok subagents');

    const errs = JSON.parse((await get(srv.url + '/api/errors')).body);
    assert.ok(Array.isArray(errs));
    console.log('ok errors');

    const search1 = JSON.parse((await get(srv.url + '/api/search?q=foobar')).body);
    assert.ok(search1.results.length >= 1, 'search returned results');
    assert.ok(search1.results[0].text.toLowerCase().includes('foobar'));
    console.log('ok search', search1.results.length, 'hits, top score', search1.results[0].score.toFixed(3));

    const search2 = JSON.parse((await get(srv.url + '/api/search?q=lorem')).body);
    assert.ok(search2.results[0].text.toLowerCase().includes('lorem'));
    console.log('ok search2');

    const evs = JSON.parse((await get(srv.url + '/api/events?role=assistant&limit=10')).body);
    assert.ok(evs.total >= 1);
    console.log('ok events filter');

    // GUI filter coverage
    const evTool = JSON.parse((await get(srv.url + '/api/events?tool=Grep')).body);
    assert.ok(evTool.rows.every(r => r.tool === 'Grep'), 'tool filter excludes non-Grep');
    assert.ok(evTool.total >= 1, 'tool filter finds Grep');

    const evType = JSON.parse((await get(srv.url + '/api/events?type=tool_use')).body);
    assert.ok(evType.rows.every(r => r.type === 'tool_use'), 'type filter');

    const evSince = JSON.parse((await get(srv.url + '/api/events?since=1h')).body);
    assert.ok(evSince.total >= 1, 'relative since=1h works');
    const evSinceFuture = JSON.parse((await get(srv.url + '/api/events?until=' + (Date.now() - 3600_000))).body);
    assert.equal(evSinceFuture.total, 0, 'until=1h-ago excludes just-loaded events');

    const evGrep = JSON.parse((await get(srv.url + '/api/events?grep=foobar')).body);
    assert.ok(evGrep.total >= 1 && evGrep.rows.every(r => /foobar/i.test(r.text)), 'grep regex');

    const evIgrep = JSON.parse((await get(srv.url + '/api/events?igrep=foobar')).body);
    assert.ok(evIgrep.rows.every(r => !/foobar/i.test(r.text)), 'igrep regex excludes');

    const evBadRe = JSON.parse((await get(srv.url + '/api/events?grep=%5B')).body);
    assert.ok(evBadRe.error && /invalid regex/.test(evBadRe.error), 'invalid regex error surfaced');

    // q substring fallback — 'ok' is 2 chars but a stopword-like; pick a short token under tokenizer's 2-char limit
    const evQ1 = JSON.parse((await get(srv.url + '/api/events?q=foobar')).body);
    assert.ok(evQ1.total >= 1, 'tokenized q works');
    const evQ2 = JSON.parse((await get(srv.url + '/api/events?q=a')).body); // 1 char → empty tokens → substring fallback
    assert.ok(evQ2.total >= 1, 'q substring fallback for sub-tokenizer queries');

    const defs = JSON.parse((await get(srv.url + '/api/defaults')).body);
    assert.ok(Array.isArray(defs.presets) && defs.presets.length >= 4, 'defaults exposes presets');
    assert.ok(defs.presets.find(p => p.id === 'errors'), 'errors preset exists');
    console.log('ok gui filter suite');

    // CLI buildFilter / parseTime unit tests
    const { buildFilter, parseTime, compileRegexes } = await import('./src/filters.js');
    const mkOpts = (o = {}) => ({ _multi: { grep: [], igrep: [], role: [], type: [], tool: [], session: [], sid: [], project: [], cwd: [], parent: [] }, ...o });
    const baseEv = (over = {}) => ({ timestamp: Date.now(), role: 'assistant', conversation: { id: 'sid1', cwd: '/repo/proj', isSubagent: false, parentSid: null }, block: { type: 'text', text: 'hello world' }, ...over });

    // role filter
    const fRole = buildFilter(mkOpts({ _multi: { ...mkOpts()._multi, role: ['user'] } }));
    assert.equal(fRole(baseEv()), false, 'role=user excludes assistant');
    assert.equal(fRole(baseEv({ role: 'user' })), true, 'role=user includes user');

    // grep + igrep combination
    const fGrep = buildFilter(mkOpts({ _multi: { ...mkOpts()._multi, grep: ['hello'], igrep: ['world'] } }));
    assert.equal(fGrep(baseEv()), false, 'grep matches but igrep also matches → exclude');
    assert.equal(fGrep(baseEv({ block: { type: 'text', text: 'hello there' } })), true, 'grep matches, igrep does not → include');

    // multi-grep AND
    const fGrep2 = buildFilter(mkOpts({ _multi: { ...mkOpts()._multi, grep: ['hello', 'world'] } }));
    assert.equal(fGrep2(baseEv()), true);
    assert.equal(fGrep2(baseEv({ block: { type: 'text', text: 'hello' } })), false, 'multi-grep is AND');

    // invert
    const fInv = buildFilter(mkOpts({ invert: true, _multi: { ...mkOpts()._multi, role: ['user'] } }));
    assert.equal(fInv(baseEv()), true, 'invert flips exclude → include');

    // since / until
    const past = Date.now() - 60_000;
    const fSince = buildFilter(mkOpts({ since: '30s' }));
    assert.equal(fSince(baseEv({ timestamp: past })), false, '60s-old ev excluded by since=30s');
    assert.equal(fSince(baseEv()), true);

    // project exact match
    const fProj = buildFilter(mkOpts({ _multi: { ...mkOpts()._multi, project: ['proj'] } }));
    assert.equal(fProj(baseEv()), true);
    assert.equal(fProj(baseEv({ conversation: { id: 's', cwd: '/x/other' } })), false);

    // no-meta / only-meta
    const fNoMeta = buildFilter(mkOpts({ 'no-meta': true }));
    assert.equal(fNoMeta(baseEv({ block: { type: 'text', text: 't', isMeta: true } })), false);
    assert.equal(fNoMeta(baseEv()), true);
    const fOnlyMeta = buildFilter(mkOpts({ 'only-meta': true }));
    assert.equal(fOnlyMeta(baseEv()), false);
    assert.equal(fOnlyMeta(baseEv({ block: { type: 'text', text: 't', isMeta: true } })), true);

    // subagents
    const fNoSub = buildFilter(mkOpts({ 'no-subagents': true }));
    assert.equal(fNoSub(baseEv({ conversation: { id: 's', cwd: '/x', isSubagent: true } })), false);
    assert.equal(fNoSub(baseEv()), true);

    // multi-sid OR
    const fSid = buildFilter(mkOpts({ _multi: { ...mkOpts()._multi, sid: ['aaa', 'bbb'] } }));
    assert.equal(fSid(baseEv({ conversation: { id: 'aaa123', cwd: '/x' } })), true);
    assert.equal(fSid(baseEv({ conversation: { id: 'bbb999', cwd: '/x' } })), true);
    assert.equal(fSid(baseEv({ conversation: { id: 'ccc000', cwd: '/x' } })), false);

    // parseTime errors loudly
    assert.equal(parseTime(''), 0);
    assert.equal(parseTime(null), 0);
    assert.throws(() => parseTime('garbage'), /invalid time/);
    assert.ok(parseTime('1h') > 0);
    assert.ok(parseTime('1H') > 0, 'case-insensitive units');

    // compileRegexes errors loudly
    assert.throws(() => compileRegexes(['[']), /invalid regex/);
    console.log('ok cli filter suite');

    // unsloth export (messages + sharegpt)
    const usid = 's1';
    const conv = { id: usid, cwd: '/x', parentSid: null, isSubagent: false };
    const uevs = [
      { timestamp: 1, role: 'user', conversation: conv, block: { type: 'text', text: 'find foobar <system-reminder>ignore this</system-reminder> please' } },
      { timestamp: 2, role: 'assistant', conversation: conv, block: { type: 'text', text: 'searching' } },
      { timestamp: 3, role: 'assistant', conversation: conv, block: { type: 'thinking', thinking: 'should not leak' } },
      { timestamp: 4, role: 'assistant', conversation: conv, block: { type: 'tool_use', id: 'tu1', name: 'Grep', input: { pattern: 'foobar' } } },
      { timestamp: 5, role: 'user', conversation: conv, block: { type: 'tool_result', tool_use_id: 'tu1', content: 'hit at line 3' } },
      { timestamp: 6, role: 'assistant', conversation: conv, block: { type: 'text', text: 'done' } },
    ];
    const msgs = toUnslothMessages(uevs);
    assert.equal(msgs.length, 1);
    const m = msgs[0].messages;
    assert.equal(m[0].role, 'user');
    assert.ok(!m[0].content.includes('system-reminder'), 'system-reminder stripped from user text');
    assert.ok(!m[0].content.includes('ignore this'), 'system-reminder body stripped');
    assert.equal(m[1].role, 'assistant');
    assert.ok(m[1].tool_calls && m[1].tool_calls[0].function.name === 'Grep');
    assert.equal(JSON.parse(m[1].tool_calls[0].function.arguments).pattern, 'foobar');
    const toolMsg = m.find(x => x.role === 'tool');
    assert.ok(toolMsg && toolMsg.tool_call_id === 'tu1');
    const lineStr = JSON.stringify(msgs[0]);
    assert.equal(JSON.parse(lineStr).session_id, usid);
    assert.ok(!lineStr.includes('"type":"tool_use"'), 'no raw tool_use envelope');
    assert.ok(!lineStr.includes('"type":"thinking"'), 'no thinking envelope');
    assert.ok(!lineStr.includes('<system-reminder>'), 'no system-reminder leak');
    console.log('ok unsloth messages');
    const sg = toShareGPT(uevs);
    assert.equal(sg.length, 1);
    const turns = sg[0].conversations;
    assert.equal(turns[0].from, 'human');
    assert.ok(turns.some(t => t.from === 'gpt' && t.value.includes('<tool_call>Grep')));
    assert.ok(turns.some(t => t.from === 'tool'));
    console.log('ok unsloth sharegpt');
    // skip sessions with no training value
    assert.equal(toUnslothMessages([{ timestamp: 1, role: 'system', conversation: conv, block: { type: 'system' } }]).length, 0);
    console.log('ok unsloth skips empty');

    // static index
    const idxRes = await get(srv.url + '/');
    assert.equal(idxRes.status, 200);
    assert.ok(idxRes.body.includes('ccsniff'), 'index.html served');
    console.log('ok static');
  } finally {
    await srv.close();
    if (!projectsDir.startsWith(os.tmpdir())) throw new Error(`refusing to rmSync outside tmpdir: ${projectsDir}`);
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
  console.log('\nALL TESTS PASS');
}

main().catch(e => { console.error(e); process.exit(1); });
