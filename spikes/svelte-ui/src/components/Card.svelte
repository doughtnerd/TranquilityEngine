<script lang="ts">
  let { label, tags }: { label: string; tags: string[] } = $props();
  let open = $state(true);
</script>

<panel id="card" class="card" gap="2">
  <text id="label" class="label">{label}</text>
  {#if open}
    <panel id="tags" class="tags">
      {#each tags as tag (tag)}
        <text class="tag">{tag}</text>
      {/each}
    </panel>
  {/if}
  <button id="toggle" onclick={() => (open = !open)}>Toggle</button>
</panel>

<style>
  .card { background-color: #202020; padding: 4px; }
  .card text { color: #eeeeee; }
  .tags > .tag { font-size: 12px; }
  button:hover { background-color: #333333; }
  .card :global(.external) { gap: 1px; }
  @media (max-width: 600px) { .card { padding: 0; } }
  .label::before { content: "x"; }
  .tag:first-child { color: red; }
  .card { transition: opacity 0.2s; transform: scale(1.1); }
</style>
