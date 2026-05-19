// Mountable Express router exposing /v1/history/* — mount at app.use('/', createHistoryRouter()).
// Express is a peer dependency. Caller must `npm i express`.
import { Store, getStore, DEFAULT_PROJECTS_DIR } from './store.js';

function loadExpress() {
  // Lazy import so ccsniff doesn't hard-require express for its other exports.
  // Caller (e.g. agentgui) already has express in its deps.
  // eslint-disable-next-line no-undef
  return import('express').then(m => m.default || m);
}

export async function createHistoryRouter({ projectsDir, store: providedStore } = {}) {
  const express = await loadExpress();
  const router = express.Router();
  const store = providedStore || getStore(projectsDir || DEFAULT_PROJECTS_DIR);

  const corsHeaders = (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
  };

  router.use((req, res, next) => { corsHeaders(res); next(); });

  router.get('/v1/history/snapshot', (req, res) => {
    try { res.json(store.snapshot()); }
    catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  router.get('/v1/history/sessions', (req, res) => {
    try { res.json({ sessions: store.sessions() }); }
    catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  router.get('/v1/history/sessions/:sid/events', (req, res) => {
    try { res.json({ sid: req.params.sid, events: store.sessionEvents(req.params.sid) }); }
    catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  router.get('/v1/history/search', (req, res) => {
    try {
      const q = req.query.q || '';
      const limit = parseInt(req.query.limit, 10) || 50;
      const opts = { limit };
      for (const k of ['role', 'type', 'project', 'sid']) {
        if (req.query[k]) opts[k] = req.query[k];
      }
      const results = q ? store.search(q, opts) : [];
      const hits = results.map(r => ({ sid: r.sid, snippet: r.snippet, score: r.score, ts: r.ts, role: r.role, type: r.type, project: r.project, text: r.text }));
      res.json({ query: q, hits, results });
    } catch (e) {
      res.status(500).json({ error: { message: e.message } });
    }
  });

  router.post('/v1/history/reindex', (req, res) => {
    try { store.rebuildIndex(); res.json({ ok: true, at: store.lastBuilt }); }
    catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  router.get('/v1/history/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('event: hello\ndata: {}\n\n');
    store.sseClients.add(res);
    req.on('close', () => store.sseClients.delete(res));
  });

  // Compatibility GET reindex (some clients may call GET).
  router.get('/v1/history/reindex', (req, res) => {
    try { store.rebuildIndex(); res.json({ ok: true, at: store.lastBuilt }); }
    catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  router.get('/v1/history', (req, res) => {
    try { res.json(store.snapshot()); }
    catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });

  return router;
}

export { Store, getStore, DEFAULT_PROJECTS_DIR };
