<script lang="ts">
  import type { Snippet } from "svelte";
  import Price from "./Price.svelte";

  interface Item { id: string; label: string; price: number }
  let { title, items, coins = 10, footer }: { title: string; items: Item[]; coins?: number; footer?: Snippet<[number]> } = $props();

  let selected = $state<string | null>(null);
  let bought = $state(0);
  let spent = $derived(items.filter((i) => i.id === selected).reduce((n, i) => n + i.price, 0));
  let left = $derived(coins - spent);
</script>

<section id="shop" class="shop" flex-direction="column" gap="4">
  <h1 id="title" class="title" font-size={24}>{title} ({left} left)</h1>
  {#if selected === null}
    <p id="hint">Pick <b>something</b></p>
  {/if}
  {#each items as item (item.id)}
    <button id={`item-${item.id}`} class="row" class:picked={item.id === selected} class:dear={item.price > coins} onclick={() => (selected = item.id)}>
      {item.label}
      <Price value={item.price} />
    </button>
  {/each}
  <button id="buy" style:width={`${80 + bought * 10}px`} onclick={() => bought++}>Buy</button>
  {@render footer?.(bought)}
</section>

<style>
  .shop { background-color: #112233; padding: 8px; }
  .shop .title { color: #ffcc00; }
  .row { background-color: #333333; width: 200px; height: 40px; }
  .row:hover { background-color: #444444; }
  .row.picked { background-color: #00ff00; }
  .row.dear :global(span) { color: #ff0000; }
  button { height: 40px; }
  :global(:root) { --accent: #abcdef; }
  :global(.themed) { color: var(--accent); }
</style>
