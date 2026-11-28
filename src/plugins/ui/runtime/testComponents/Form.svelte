<script lang="ts">
  let { log, onnode }: { log: (entry: string) => void; onnode?: (node: unknown) => void } = $props();
  let name = $state("Ada");
  let field: unknown = $state(null);
  $effect(() => {
    if (field) onnode?.(field);
  });
</script>

<div id="form" flex-direction="column">
  <input
    id="name"
    type="text"
    placeholder="Your name"
    bind:value={name}
    bind:this={field}
    oninput={(e: { currentTarget: { value: string } }) => log(`input ${e.currentTarget.value}`)}
    onchange={() => log(`change ${name}`)}
    onsubmit={() => log("submit")}
    onfocus={() => log("focus")}
    onblur={() => log("blur")}
  />
  <p id="echo">Hello {name}</p>
  <button id="reset" onclick={() => (name = "")} onpointerenter={() => log("enter")} onpointerleave={() => log("leave")}>Reset</button>
</div>
