<script lang="ts">
  // ADR 0422 wave 4 through Svelte: a class change starts a stylesheet transition; `ontransitionend` hears its end.
  let { on = false, ended }: { on?: boolean; ended: (name: string) => void } = $props();
</script>

<div id="box" class:on ontransitionend={(e) => ended(e.propertyName ?? "")}></div>

<style>
  div {
    width: 100px;
    height: 20px;
    opacity: 0;
    transition: opacity 0.1s linear;
  }
  div.on {
    opacity: 1;
  }
</style>
