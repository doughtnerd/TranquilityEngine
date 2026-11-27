<script>
  // HTML's `inert` on a UI element (an outroing element gets it from Svelte): its subtree takes no pointer or focus.
  let { log = () => {}, inert = true } = $props();
</script>

<div id="wrap" {inert}>
  <button id="inner" onclick={() => log("inner")}>Inner</button>
</div>
<button id="outer" onclick={() => log("outer")}>Outer</button>
