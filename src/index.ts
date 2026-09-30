export * from './types.js'
// alignOffset is the ONE horizontal-align derivation (M5.13), exported
// so the SHELL's paint and caret IMPORT it, never re-derive: placed[]
// rect.x, painted rects, and caret x agree by construction, not by
// convention. A future shell session must consume this export.
// fitDownImage (E-IMG-2 extraction) joins it for the same reason: the
// ONE aspect-preserving image scale — the shell derives an INLINE
// object's final placed dims by importing this primitive (never a
// forked formula; a shell-side scale would be a second derivation, the
// two-sided law's ban), with the same inputs the breaker used: the
// run's intrinsic dims and the block's BASE wrap width
// (contentBox.width − indentLeft − indentRight — indents apply to
// inline content, unlike block images).
export { createLayoutEngine, alignOffset } from './layout.js'
export { fitDownImage } from './line-breaker.js'
