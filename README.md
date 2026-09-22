Status: M0 — types, interface stub, and test harness only. No real layout yet.

# tensor-engine

`@tensor-editor/engine` is a headless, PURE document-layout engine:
semantic blocks in, positioned geometry out. No rendering, ever. `src/`
contains no DOM, window, or canvas (enforced by `tests/purity.test.ts`)
and the package has zero runtime dependencies.

What works today: `layout(doc, opts, previous?)` returns one page derived
from the options and one line box per paragraph, using hardcoded 1.5×
line-height / 0.8× baseline metrics (TODO(M1): measured metrics via an
injected port). `previous` is accepted but ignored — full recompute
(TODO(M1+): incremental invalidation).

The M0 golden output is pinned in `tests/golden.test.ts`; snapshots are
committed and CI fails if they are missing. See
[CONVENTIONS.md](CONVENTIONS.md) for project rules.

## Develop

    npm install
    npm run typecheck
    npm run test
