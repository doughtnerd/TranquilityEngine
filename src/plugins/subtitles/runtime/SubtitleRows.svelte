<script lang="ts">
  // The built-in subtitle and caption display's view (ADR 0357 §5, 0419 wave B), `@myco/ui/Subtitles.svelte`:
  // `SubtitleDisplay` passes in the rows on screen and their placement each frame; this draws them. A replacement
  // component (`SubtitleDisplay.component`) gets the same props. Themes set the `--subtitle-*` variables in a global
  // rule of any of the game's components (`:global(:root) { --subtitle-color: … }`); the values below are the fallbacks.
  interface Row {
    id: number;
    kind: "speech" | "caption";
    /** The shown speaker name (formatted), or "" when names aren't shown. */
    speaker: string;
    text: string;
    /** The fade, 0 to 1. */
    opacity: number;
    /** The speaker's colour (CSS), or null for the theme's. */
    color: string | null;
  }

  let {
    rows = [],
    position = "bottom",
    margin = 8,
    maxWidth = 70,
    fontSize = 28.8,
    background = 0.6,
  }: { rows?: Row[]; position?: "bottom" | "top"; margin?: number; maxWidth?: number; fontSize?: number; background?: number } = $props();
</script>

<div
  id="subtitles"
  style:flex-direction={position === "top" ? "column-reverse" : "column"}
  style:top={position === "top" ? `${margin}%` : "auto"}
  style:bottom={position === "top" ? "auto" : `${margin}%`}
  style:left={`${(100 - maxWidth) / 2}%`}
  style:width={`${maxWidth}%`}
>
  {#each rows as row (row.id)}
    <div class={`row ${row.kind}`} style:opacity={row.opacity}>
      <div class="box" style:opacity={background}></div>
      <span class="speaker" style:display={row.speaker === "" ? "none" : null} style:font-size={`${fontSize}px`} style:color={row.color}>{row.speaker}</span>
      <span class="line" style:font-size={`${fontSize}px`}>{row.text}</span>
    </div>
  {/each}
</div>

<style>
  #subtitles {
    position: absolute;
    align-items: center;
    gap: 6px;
  }
  .row {
    flex-direction: row;
    align-items: flex-start;
    gap: 8px;
    padding: var(--subtitle-padding, 8px);
  }
  .box {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    background-color: var(--subtitle-background, #000000);
    border-radius: var(--subtitle-radius, 6px);
  }
  .speaker,
  .line {
    font: var(--subtitle-font);
  }
  .speaker {
    color: var(--subtitle-speaker-color, #ffd75e);
    font-weight: bold;
  }
  .line {
    color: var(--subtitle-color, #ffffff);
    text-align: center;
  }
  .caption .line {
    color: var(--subtitle-caption-color, #c9d3de);
  }
</style>
