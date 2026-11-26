<script lang="ts">
  // The Element subset on renderer nodes (ADR 0419) as Svelte's conformance fixtures use it: `click()` with HTML's
  // activation, namespaces, reflected attributes, `stepUp`, the tag and class queries, and an <input> changing type.
  let { log = () => {}, onnode = () => {}, prevent = false }: { log?: (s: string) => void; onnode?: (node: unknown) => void; prevent?: boolean } = $props();
  let agreed = $state(false);
  let kind = $state("text");
  let amount = $state("7");
  let root: unknown = $state(null);
  $effect(() => {
    if (root) onnode(root);
  });
</script>

<div id="root" bind:this={root}>
  <form id="form" onsubmit={(e: { preventDefault(): void }) => (e.preventDefault(), log("submit"))}>
    <input
      id="agree"
      type="checkbox"
      bind:checked={agreed}
      onclick={(e: { currentTarget: { checked: boolean }; preventDefault(): void }) => {
        log(`click ${e.currentTarget.checked}`);
        if (prevent) e.preventDefault();
      }}
      oninput={() => log(`input ${agreed}`)}
      onchange={() => log(`change ${agreed}`)}
    />
    <button id="send">Send</button>
    <button id="plain" type="button">Plain</button>
  </form>
  <p id="state">{agreed}</p>
  <input id="amount" type={kind} min="0" max="10" step="2" bind:value={amount} />
  <button id="kind" onclick={() => (kind = kind === "text" ? "range" : "text")}>Kind</button>
  <svg id="icon" width="10" height="10"><g class="shape"><circle cx="5" cy="5" r="4" /></g><foreignObject><span class="shape">in svg</span></foreignObject></svg>
  <math><mrow id="row"></mrow></math>
  <div id="flags" hidden translate={false} draggable="true" tabindex="3"></div>
  <span id="plainspan" data-open={true} aria-hidden={false}></span>
  <svg id="ro" readonly={false} width="4" height="4"></svg>
  <select id="pick"><option value="a">A</option><option value="b" selected>B</option></select>
</div>
