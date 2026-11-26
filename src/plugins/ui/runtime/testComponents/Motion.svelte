<script lang="ts">
  // ADR 0419: `svelte/motion` (Tween, Spring) drive UI fields through `style:` like any state.
  import { Spring, Tween } from "svelte/motion";
  import { linear } from "svelte/easing";

  let { target = 0 }: { target?: number } = $props();

  const width = Tween.of(() => target, { duration: 100, easing: linear });
  const height = Spring.of(() => target, { stiffness: 0.2, damping: 0.5 });
</script>

<div id="tween" style:width={`${width.current}px`}></div>
<div id="spring" style:height={`${height.current}px`}></div>
