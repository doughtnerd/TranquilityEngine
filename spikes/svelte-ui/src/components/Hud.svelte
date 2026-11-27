<script lang="ts">
  import Shop from "./Shop.svelte";
  let { shop }: { shop: { title: string; items: { id: string; label: string; price: number }[]; coins: number } } = $props();
</script>

{#snippet footer(bought: number)}
  <text id="footer" class="footer">Bought {bought}</text>
{/snippet}

<Shop title={shop.title} items={shop.items} coins={shop.coins} {footer} />
