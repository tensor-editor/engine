import type { TextMetrics } from '../src/types.js'

/**
 * Pure test helper (never in src/): 10px per character, ascent/descent
 * scaled by fontSize. With this, maxWidth 100 gives 10 chars of headroom.
 * DELIBERATELY IGNORES TextStyle.fontVariant (M-STYLES): width is a
 * function of text length only, so small-caps runs measure identically
 * to their full-case twins — tests that need width divergence use the
 * shell's real-metrics test seams instead.
 */
export const FakeMetrics: TextMetrics = {
  measure: (text) => text.length * 10,
  ascent: (style) => 0.85 * style.fontSize,
  descent: (style) => 0.25 * style.fontSize,
}
