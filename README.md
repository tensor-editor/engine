Status: M1 — metrics port + greedy line breaker. Slicing/pages still stubbed.

# tensor-engine

`@tensor-editor/engine` is a headless, PURE document-layout engine:
semantic blocks in, positioned geometry out. No rendering, ever. `src/`
contains no DOM, window, or canvas (enforced by `tests/purity.test.ts`)
and the package has zero runtime dependencies.

What works today: `createLayoutEngine({ metrics })` builds a layout engine
that measures through the injected `TextMetrics` port — the real
(canvas-based) implementation lives in the shell repo, never here, and
the engine does no caching (memoization is the metrics implementation's
job). Each paragraph's runs are broken into lines by a greedy breaker
(break at spaces only, trim the break space, no hyphenation, hard-split
overlong tokens; TODO(M2+): proper UAX #14), and every line box carries
measured width, max-ascent baseline, and max ascent/descent height, plus
run-boundary segments. Everything is page 0 — slicing is M2
(TODO(M2)); empty paragraphs emit a zero-size placeholder line
(TODO(M2): baseStyle fallback). `previous` is accepted but ignored —
full recompute (TODO(M2+): incremental invalidation).

The golden output is pinned in `tests/golden.test.ts` (FakeMetrics:
10px/char, 0.85/0.25 em ascent/descent); snapshots are committed and CI
fails if they are missing. See [CONVENIONS.md](CONVENTIONS.md) for
project rules.

## Develop

    npm install
    npm run typecheck
    npm run test
