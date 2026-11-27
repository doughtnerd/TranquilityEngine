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

<panel id="shop" class="shop" flex-direction="column" gap="4">
  <text id="title" class="title" font-size={24}>{title} ({left} left)</text>
  {#if selected === null}
    <text id="hint" class="hint">Pick something</text>
  {/if}
  {#each items as item (item.id)}
    <button id={`item-${item.id}`} class="row" class:picked={item.id === selected} class:dear={item.price > coins} onclick={() => (selected = item.id)}>
      {item.label}
      <Price value={item.price} />
    </button>
  {/each}
  <button id="buy" class="buy" style:width={`${80 + bought * 10}px`} onclick={() => bought++}>Buy</button>
  {@render footer?.(bought)}
</panel>
