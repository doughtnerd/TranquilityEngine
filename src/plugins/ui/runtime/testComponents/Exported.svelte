<script>
  let { fail = false } = $props();
  let count = $state(0);

  export const label = "exported";
  export function bump() {
    count++;
  }

  function boom() {
    throw new Error("boom");
  }
</script>

<p id="count">{count}</p>
<svelte:boundary>
  <p id="ok">{fail ? boom() : "fine"}</p>
  {#snippet failed(error)}<p id="failed">{String(error)}</p>{/snippet}
</svelte:boundary>
