<script lang="ts">
  import Shop from "./Shop.svelte";

  let { shop }: { shop: { title: string; coins: number; items: { id: string; label: string; price: number }[] } } = $props();
</script>

{#snippet footer(bought: number)}
  <p id="footer" class="themed">Bought {bought}</p>
{/snippet}

<Shop title={shop.title} items={shop.items} coins={shop.coins} {footer} />
