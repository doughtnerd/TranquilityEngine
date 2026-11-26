<script lang="ts">
  // ADR 0418 wave 5: structural, attribute and sibling selectors, `calc()` and canvas `@media` on hosted elements, and
  // Svelte's `MediaQuery` following the canvas.
  import { MediaQuery } from "svelte/reactivity";

  let { items, flag }: { items: string[]; flag: string } = $props();
  const wide = new MediaQuery("min-width: 1000px");
  const portrait = new MediaQuery("(orientation: portrait)");
</script>

<ul id="list">
  {#each items as item (item)}
    <li id={item} class="row">{item}</li>
  {/each}
</ul>
<div id="flag" class="flag" data-state={flag}></div>
<span id="after">after</span>
<p id="media">{wide.current ? "wide" : "narrow"} {portrait.current ? "portrait" : "landscape"}</p>
<div id="calc" class="calc"><div id="inner" class="inner">x</div></div>

<style>
  .row { gap: 1; }
  .row:first-child { gap: 2; }
  .row:last-child { flex-grow: 5; }
  .row:nth-child(even) { opacity: 0.5; }
  .row + .row { flex-shrink: 3; }
  .row:not(:first-child, :last-child) { padding: 6px; }
  .flag[data-state="open"] { gap: 7; }
  .flag[data-state^="op"] + span { font-size: 30px; }
  div:empty { opacity: 0.25; }
  .calc { width: calc(50% - 40px); height: calc(10px * 3); padding: 0; }
  .inner { width: calc(100% - 20px); height: 10px; }
  @media (min-width: 1000px) { .calc { gap: 9; } }
  @media (max-width: 999px) { .calc { gap: 4; } }
</style>
