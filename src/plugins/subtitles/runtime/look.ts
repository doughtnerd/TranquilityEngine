/**
 * The built-in subtitle look's values (ADR 0357 §5), declared once: the built-in component's (`SubtitleRows.svelte`)
 * fallbacks for its `--subtitle-*` variables are these (its test checks they match), and previews without a renderer (the
 * editor, the Studio) draw with them.
 */
export const SUBTITLE_LOOK = Object.freeze({
  color: "#ffffff",
  background: "#000000",
  speakerColor: "#ffd75e",
  captionColor: "#c9d3de",
  /** UI pixels. */
  padding: 8,
  radius: 6,
  /** Between rows, and between a speaker's name and the line. */
  gap: 6,
  nameGap: 8,
});
