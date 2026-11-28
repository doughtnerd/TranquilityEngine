<script lang="ts">
  // ADR 0423 wave Y2: `animate:flip`, `crossfade` between two lists, and local versus `|global` transitions.
  import { flip } from "svelte/animate";
  import { crossfade, fade } from "svelte/transition";

  let {
    items = [] as string[],
    done = [] as string[],
    open = true,
    inner = true,
  }: { items?: string[]; done?: string[]; open?: boolean; inner?: boolean } = $props();

  const [send, receive] = crossfade({ duration: 100 });
</script>

<div id="lists">
  <div id="todo" class="list">
    {#each items as item (item)}
      <div id={`item-${item}`} class="item" animate:flip={{ duration: 100 }} in:receive={{ key: item }} out:send={{ key: item }}></div>
    {/each}
  </div>
  <div id="done" class="list">
    {#each done as item (item)}
      <div id={`done-${item}`} class="item" animate:flip={{ duration: 100 }} in:receive={{ key: item }} out:send={{ key: item }}></div>
    {/each}
  </div>
</div>

{#if open}
  <div id="outer">
    {#if inner}
      <div id="local" transition:fade={{ duration: 100 }}></div>
      <div id="global" transition:fade|global={{ duration: 100 }}></div>
    {/if}
  </div>
{/if}

<style>
  #lists {
    flex-direction: row;
    gap: 100px;
  }
  .list {
    flex-direction: column;
    width: 100px;
  }
  .item {
    width: 100px;
    height: 20px;
    margin-bottom: 10px;
  }
  #local,
  #global {
    width: 10px;
    height: 10px;
  }
</style>
