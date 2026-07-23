# ccsniff

Watch Claude Code JSONL output files and emit structured events as a Node.js EventEmitter.

## Install

```bash
npm install ccsniff
```

## Usage

```js
import { watch } from 'ccsniff';

const watcher = watch()
  .on('conversation_created', ({ conversation }) => {
    console.log('New session:', conversation.title);
  })
  .on('streaming_progress', ({ block, role }) => {
    if (block.type === 'text') process.stdout.write(block.text);
  })
  .on('streaming_complete', ({ conversationId }) => {
    console.log('Done:', conversationId);
  });

process.on('SIGINT', () => watcher.stop());
```

CommonJS:

```js
const { watch, JsonlWatcher } = require('ccsniff');
```

## Mountable Express router (`/v1/history/*`)

ccsniff ships a mountable router that hosts all the read-only history endpoints used by AgentGUI's live client (`/v1/history/snapshot`, `/sessions`, `/sessions/:sid/events`, `/search`, `/stream` SSE, and `POST /reindex`). It reads `~/.claude/projects` by default; override with the `CLAUDE_PROJECTS_DIR` env var. `express` is an optional peer dependency — install it in the host app.

```js
import express from 'express';
import { createHistoryRouter } from 'ccsniff';

const app = express();
app.use(await createHistoryRouter({ projectsDir: process.env.CLAUDE_PROJECTS_DIR }));
app.listen(3000);
```


## CLI

```bash
npx ccsniff --since 24h --grep "rs-exec" --limit 50
npx ccsniff --since 7d --role user --json
npx ccsniff -f                     # tail new events live
npx ccsniff --rollup out.ndjson --since 7d
npx ccsniff --unsloth train.jsonl --since 7d --no-subagents
npx ccsniff --unsloth train.jsonl --unsloth-format sharegpt --since 7d
npx ccsniff --git-discipline --since 7d --project myrepo
npx ccsniff --search-discipline --since 7d
npx ccsniff --glyph-discipline --since 24h
npx ccsniff --verb-bypass-discipline --since 7d
npx ccsniff --spool-discipline --since 24h
```

Discipline audits: `--git-discipline` flags `git push` without a prior separate `git status --porcelain` Bash event and raw git push/commit inside gm (spool-dispatching) sessions; `--search-discipline` flags Grep/Glob discovery events inside gm sessions, exempting known-path lookups (a `.gm/`-state-file target like `prd.yml`/`mutables.yml`/a spool response, or a `Grep` targeting one specific already-located file) since those are retrieval of a known target, not open-ended discovery; `--glyph-discipline` flags decorative non-ASCII glyphs in assistant text (code blocks excluded); `--verb-bypass-discipline` flags WebFetch/WebSearch/Task-search/raw-browser-lib/raw-memory-write inside gm sessions where a plugkit verb already exists for that action; `--spool-discipline` flags gm sessions that write exec-spool/in dispatches without ever reading a matching out/ response (a fabricated chain). All compose with `--project`/`--since`.

### Unsloth training export

`--unsloth <out>` writes one JSONL line per Claude Code session, ready for
Unsloth / TRL conversational fine-tuning. All filter flags (`--since`,
`--project`, `--session`, `--no-subagents`, ...) apply.

Two formats are supported via `--unsloth-format`:

- `messages` (default) — OpenAI / ChatML shape with native tool calling:
  ```json
  {"session_id":"...","messages":[
    {"role":"user","content":"find foobar"},
    {"role":"assistant","content":null,"tool_calls":[{"id":"tu1","type":"function","function":{"name":"Grep","arguments":"{\"pattern\":\"foobar\"}"}}]},
    {"role":"tool","tool_call_id":"tu1","content":"hit at line 3"},
    {"role":"assistant","content":"done"}
  ]}
  ```
- `sharegpt` — `{conversations:[{from:human|gpt|tool, value}]}`, compatible
  with `standardize_sharegpt`. Tool calls are inlined into the `gpt` turn as
  `<tool_call>name(json-args)</tool_call>`.

Sessions with no user/assistant turn pair are skipped (no training value).

## GUI (Observatory)

A turnkey, zero-dep browser observatory ships with the package. It indexes
every session in `~/.claude/projects` and exposes sessions, projects, tools,
timeline, errors, subagent tree, live stream, and BM25 full-text search.

```bash
npx ccsniff gui --open          # auto-open in default browser
npx ccsniff gui --port 4791     # custom port (default 4791)
```

Endpoints under `/api/*`: `snapshot`, `sessions`, `projects`, `tools`,
`timeline`, `stats`, `errors`, `subagents`, `events`, `search`, `stream`
(SSE).

## API

### `watch(projectsDir?)` → `JsonlWatcher`

Creates and starts a watcher. `projectsDir` defaults to `~/.claude/projects`.

### `new JsonlWatcher(projectsDir?)`

Class constructor. Call `.start()` manually after attaching listeners.

### `watcher.start()` → `this`

Scans for existing `.jsonl` files and begins watching. Chainable.

### `watcher.stop()`

Closes file descriptors and directory watcher.

## Events

| Event | Payload |
|---|---|
| `conversation_created` | `{ conversation: { id, title, cwd }, timestamp }` |
| `streaming_start` | `{ conversationId, conversation, timestamp }` |
| `streaming_progress` | `{ conversationId, conversation, block, role, seq, timestamp }` |
| `streaming_complete` | `{ conversationId, conversation, seq, timestamp }` |
| `streaming_error` | `{ conversationId, error, recoverable, timestamp }` |
| `error` | `Error` |

`block.type` values: `text`, `tool_use`, `tool_result`, `system`, `result`, etc.

## Requirements

Node >= 18. Zero external dependencies.

## License

MIT
