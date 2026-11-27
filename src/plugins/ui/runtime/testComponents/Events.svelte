<script lang="ts">
  // ADR 0426 and 0427 through the renderer: propagation, capture, the window hearing what bubbles out of the view,
  // pointer and key events, and a scrolling list with the DOM's scrolling members.
  type Ev = { target: { id: string } | null; currentTarget: { id: string } | null; eventPhase: number; stopPropagation(): void; preventDefault(): void; defaultPrevented: boolean; key?: string };
  let { log, onnode }: { log: (entry: string) => void; onnode: (name: string, node: unknown) => void } = $props();
  let picked = $state("none");
  const id = (n: { id: string } | null | undefined) => n?.id || "-";

  function grab(node: unknown, key: string) {
    onnode(key, node);
  }
</script>

<svelte:window onclick={(e: Ev) => log(`window click ${id(e.target)}`)} onkeydown={(e: Ev) => log(`window keydown ${e.key}`)} />

<div id="root" flex-direction="column" align-items="flex-start">
  <div
    id="list"
    flex-direction="column"
    background-color="#222222"
    onclickcapture={(e: Ev) => log(`capture ${id(e.target)} at ${id(e.currentTarget)} ${e.eventPhase}`)}
    onclick={(e: Ev) => {
      log(`bubble ${id(e.target)} at ${id(e.currentTarget)} ${e.eventPhase}`);
      picked = id(e.target);
    }}
    onpointerdown={(e: Ev) => log(`down ${id(e.target)}`)}
    onkeydown={(e: Ev) => log(`keydown ${e.key} on ${id(e.target)}`)}
  >
    <button id="a" width="200" height="40" onclick={() => log("a")}>A</button>
    <button id="b" width="200" height="40" onclick={(e: Ev) => (log("b"), e.stopPropagation())}>B</button>
    <span id="picked">{picked}</span>
  </div>
  <div id="scroller" use:grab={"scroller"} style="overflow-y: auto; width: 200px; height: 100px; flex-direction: column" onscroll={() => log("scroll")}>
    {#each Array.from({ length: 10 }, (_, i) => i) as i (i)}
      <button id={`r${i}`} use:grab={`r${i}`} style="height: 40px; width: 180px; flex-shrink: 0">R{i}</button>
    {/each}
  </div>
</div>
