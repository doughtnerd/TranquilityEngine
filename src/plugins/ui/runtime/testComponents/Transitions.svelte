<script lang="ts">
  // ADR 0419 wave Y2: Svelte transitions under the engine's renderer (the patch's `animate` and `measure` hooks).
  import { fade, fly, scale, slide, blur, draw } from "svelte/transition";
  import { cubicOut } from "svelte/easing";

  let {
    show = false,
    kind = "fade",
    log = () => {},
    onnode = () => {},
  }: { show?: boolean; kind?: string; log?: (s: string) => void; onnode?: (node: unknown) => void } = $props();

  // The `probe` kind hands its node (`bind:this`) to the test, which measures it through the renderer's `measure` hook.
  let probe: unknown = $state(null);
  $effect(() => onnode(probe));

  // A `tick` transition: it runs a function each frame instead of CSS.
  function typewriter(node: { textContent: string }, { duration = 100 }: { duration?: number } = {}) {
    const full = "Hello";
    return {
      duration,
      tick: (t: number) => {
        node.textContent = full.slice(0, Math.round(full.length * t));
      },
    };
  }
</script>

{#if show && kind === "fade"}
  <div id="box" transition:fade={{ duration: 100 }} onintrostart={() => log("introstart")} onintroend={() => log("introend")} onoutrostart={() => log("outrostart")} onoutroend={() => log("outroend")}></div>
{:else if show && kind === "fly"}
  <div id="box" in:fly={{ x: 100, y: -20, duration: 100, easing: cubicOut }} out:fade={{ duration: 50 }}></div>
{:else if show && kind === "scale"}
  <div id="box" transition:scale={{ start: 0.5, duration: 100 }}></div>
{:else if show && kind === "slide"}
  <div id="box" class="padded" transition:slide={{ duration: 100 }}><p>Sliding</p></div>
{:else if show && kind === "delay"}
  <div id="box" in:fade={{ delay: 50, duration: 50 }}></div>
{:else if show && kind === "blur"}
  <div id="box" transition:blur={{ duration: 100 }}></div>
{:else if show && kind === "draw"}
  <path id="box" in:draw={{ duration: 100 }}></path>
{:else if show && kind === "tick"}
  <p id="box" in:typewriter={{ duration: 100 }}>Hello</p>
{:else if show && kind === "probe"}
  <div id="box" class="probe" bind:this={probe}></div>
{/if}

<style>
  div {
    width: 100px;
    height: 40px;
    opacity: 0.8;
  }
  .padded {
    padding: 10px;
    height: auto;
  }
  p {
    height: 20px;
  }
  .probe {
    padding: 4px 6px;
    border: 2px solid red;
    transform: translate(10px, 5px) rotate(90deg) scale(2);
    transform-origin: left top;
  }
</style>
