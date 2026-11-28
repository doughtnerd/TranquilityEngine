<script lang="ts">
  // No bind:value / bind:this with a custom renderer (compile error): value + oninput, and an attachment for the element.
  let name = $state("Ada");
  let { onelement }: { onelement: (node: unknown) => void } = $props();
</script>

<panel>
  <input-field id="name" value={name} oninput={(e: { element: { value: string } }) => (name = e.element.value)} {@attach onelement} />
  <text id="echo">Hello {name}</text>
</panel>
