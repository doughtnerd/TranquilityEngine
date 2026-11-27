<script lang="ts">
  // Legacy `on:` directives (Svelte 4 syntax), with modifiers, on elements and on <svelte:window>.
  let { log }: { log: (entry: string) => void } = $props();
  let clicks = $state(0);
</script>

<svelte:window on:keyup={(e: { key: string }) => log(`keyup ${e.key}`)} />

<div id="legacy">
  <!-- svelte-ignore event_directive_deprecated -->
  <button id="once" on:click|once={() => clicks++}>{clicks}</button>
  <!-- svelte-ignore event_directive_deprecated -->
  <button id="stop" on:click|stopPropagation|preventDefault={(e: { defaultPrevented: boolean }) => log(`stop ${e.defaultPrevented}`)}>Stop</button>
</div>
