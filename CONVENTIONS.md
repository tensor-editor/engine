# tensor-engine conventions (for humans and AI contributors)
- TypeScript only. No new runtime dependency without explicit approval.
- The layout core is PURE: no DOM/window/canvas in src/. All measurement goes
  through an injected metrics port (added in M1).
- Test-first: every bug fix lands with a test that failed before the fix.
  Never weaken a test to make it pass.
- One behavior per commit. Diffs touching >3 files need a stated reason.
- Blocks form a union with a "kind" discriminator. New block types extend the
  union — never hardcode one kind end-to-end.
- Line boxes are POSITIONED facts in the output. Consumers never derive geometry.
- Fragments of a block share its id; lineIndex is continuous across pages.
- layout() accepts previous?: LayoutResult as a PERF HINT only. Consulting it
  may never change the correct answer — only how fast we get there.
- Any field encoding a document position declares, in a comment, how it
  survives edits.
- Golden tests live in tests/. Regenerate intentionally, never casually.
