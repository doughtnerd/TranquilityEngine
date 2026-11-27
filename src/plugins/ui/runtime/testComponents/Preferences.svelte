<script lang="ts">
  // ADR 0431: the player's UI preferences as user-preference media features: canvas `@media`, Svelte's
  // `prefersReducedMotion` and `MediaQuery`.
  import { prefersReducedMotion } from "svelte/motion";
  import { MediaQuery } from "svelte/reactivity";

  const reduce = new MediaQuery("prefers-reduced-motion: reduce");
  const dark = new MediaQuery("(prefers-color-scheme: dark)");
</script>

<p id="state">{prefersReducedMotion.current ? "reduce" : "motion"} {reduce.current ? "reduce" : "motion"} {dark.current ? "dark" : "light"}</p>
<div id="box" class="box"></div>

<style>
  .box { opacity: 1; gap: 0; }
  @media (prefers-reduced-motion: reduce) { .box { opacity: 0.5; } }
  @media (prefers-color-scheme: dark) { .box { gap: 3; } }
  @media (prefers-reduced-motion) and (prefers-color-scheme: light) { .box { padding: 2px; } }
</style>
