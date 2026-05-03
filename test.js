import { strict as assert } from 'assert';
import os from 'os';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { buildIndex, search, tokenize } from './src/bm25.js';
import { createServer } from './src/gui-server.js';

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
