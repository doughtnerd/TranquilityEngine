<script lang="ts">
  // A replacement subtitle display (`SubtitleDisplay.component`): it gets the same props as the built-in one.
  let { rows = [] }: { rows?: { id: number; text: string }[] } = $props();
</script>

<div id="mine">
  {#each rows as row (row.id)}
    <span class="line">{row.text}</span>
  {/each}
</div>
