# tensor-engine conventions (for humans and AI contributors)
- TypeScript only. No new runtime dependency without explicit approval.
- The layout core is PURE: no DOM/window/canvas in src/. All measurement goes
  through an injected metrics port (added in M1).
- Unimplemented API surface throws loudly; it never silently no-ops. JSON
  null counts as unset (PM attribute JSON round-trips use null for absent
  attrs).
- Test-first: every bug fix lands with a test that failed before the fix.
  Never weaken a test to make it pass.
- Known-wrong placeholders are pinned by tests; replacing one is a
  deliberate red → green, never a silent change.
- One behavior per commit. Diffs touching >3 files need a stated reason.
- Blocks form a union with a "kind" discriminator. New block types extend the
  union — never hardcode one kind end-to-end.
- Line boxes are POSITIONED facts in the output. Consumers never derive geometry.
- Fragments of a block share its id; lineIndex is continuous across pages.
- A bonded block's placement consumes its successor's first-line height
  (upstream dependence). Resume points and splice endpoints extend
  backward through bonds; a splice never ends on a bonded predecessor.
- Flow precedence tiers: structural forced breaks > orphan/atomic
  start-moves > bond > widow adjust — a bounded re-check loop over the
  R6 floor.
- PARITY LAW (M3): the engine instance may memoize; warm output must
  deep-equal cold output — verified by the parity fuzzer, forever. It
  supersedes M0's `previous?: LayoutResult` PERF HINT parameter (removed in
  M3): a parameter the engine would ignore-or-mistrust violated the
  loud-seams rule, and the instance cache upgrades "may never change the
  correct answer" to "provably identical output," verified mechanically.
- Treat LayoutResult as immutable (M3): the engine shares cached records
  across results (zero-copy) and freezes them; a caller mutating them
  corrupts the cache AND parity.
- engine.lastStats is debug surface, not API.
- Any field encoding a document position declares, in a comment, how it
  survives edits.
- Golden tests live in tests/. Regenerate intentionally, never casually.
