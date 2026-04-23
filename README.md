# ccpeek

Watch Claude Code JSONL output files and emit structured events as a Node.js EventEmitter.

## Install

```bash
npm install ccpeek
```

## Usage

```js
import { watch } from 'ccpeek';

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
const { watch, JsonlWatcher } = require('ccpeek');
```

## CLI

```bash
npx ccpeek --since 24h --grep "rs-exec" --limit 50
npx ccpeek --since 7d --role user --json
npx ccpeek -f                     # tail new events live
npx ccpeek --rollup out.ndjson --since 7d
```

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
