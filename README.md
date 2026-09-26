## `@tensor-editor/engine`

Layout engine for the Tensor editor project.

## Status: integrated

The shell (word processor) renders its paginated mode from this engine: `createLayoutEngine` + `RealMetrics` (the shell-side measurement port) drive `PaginatedView`, sheets from `PageGeometry[]`, glyphs from `LineBox[]` segments, and a synthetic caret from the same metrics instance. The engine's incremental cache is load-bearing in production: a warm keystroke layout walks only the edited block (see `lastStats`: 1 block walked, 1 re-broken, 1 spliced, vs 3/3/0 cold on the integration doc).

See [ARCHITECTURE.md](ARCHITECTURE.md) for the engineer's guide.

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsc -p tsconfig.build.json → dist/
npm test            # vitest: golden, slicer, flow, parity fuzz, purity
```
