<script lang="ts">
  // ADR 0426: inline SVG under the engine's renderer: the subtree kept as an SVG document on the <svg>'s element, its
  // shapes' geometry (getTotalLength) and pointer events on shapes.
  let {
    r = 20,
    log = () => {},
    onnode = () => {},
  }: { r?: number; log?: (s: string) => void; onnode?: (key: string, node: unknown) => void } = $props();

  let circle: unknown = $state(null);
  let path: unknown = $state(null);
  $effect(() => onnode("circle", circle));
  $effect(() => onnode("path", path));
</script>

<div class="row">
  <svg id="icon" class="icon" width="200" height="100" viewBox="0 0 100 50" onclick={(e) => log(`svg click ${(e.target as { localName: string }).localName}`)}>
    <g transform="translate(10, 0)" onclick={() => log("g click")}>
      <circle bind:this={circle} cx="15" cy="25" r={r} fill="currentColor" onclick={(e) => log(`circle click ${(e.currentTarget as { localName: string }).localName}`)} />
    </g>
    <path bind:this={path} d="M60 10 h30 v30 h-30 z" fill="none" stroke="red" stroke-width="4" pointer-events="stroke" onclick={() => log("path click")} />
    <text x="50" y="45">Hi</text>
  </svg>
</div>

<style>
  .icon {
    color: #00ff00;
  }
</style>
