# Changelog

## Unreleased

- Rename package + CLI + repo from `@lanmower/cc-tail` to `ccpeek`. Bare `cc-tail` on npm blocked by similarity to `cctail`; went to creative unscoped name instead.
- Fix cwd reconstruction for project dirs containing dashes (rs-exec, ccpeek, gm-cc, etc). Previous `replace(/-/g, '/')` corrupted `C--dev-rs-exec` into `C:/dev/rs/exec`. Now falls back to the encoded project-dir basename when jsonl has no `cwd` field.

## 1.0.0 — 2026-04-11

- Initial release: `cc-tail` npm package
- `JsonlWatcher` class extending EventEmitter — watches `~/.claude/projects/` JSONL files
- `watch(projectsDir?)` factory — chainable, returns started watcher
- Events: `conversation_created`, `streaming_start`, `streaming_progress`, `streaming_complete`, `streaming_error`, `error`
- Dual ESM + CJS exports (`src/index.js` + `src/index.cjs`)
- Zero external dependencies, Node >= 18
- GitHub Actions: npm publish on `v*` tags, gh-pages deploy on every main push
- Landing page at https://anentrypoint.github.io/cc-tail/ (WebJSX + RippleUI, dark/light theme)
