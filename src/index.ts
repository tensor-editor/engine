export * from './types.js'
// alignOffset is the ONE horizontal-align derivation (M5.13), exported
// so the SHELL's paint and caret IMPORT it, never re-derive: placed[]
// rect.x, painted rects, and caret x agree by construction, not by
// convention. A future shell session must consume this export.
export { createLayoutEngine, alignOffset } from './layout.js'
