<script>
  // HTML's form defaults and reset, input buttons, a select's value, a control inside text, media `muted`, a disabled
  // control's click() and focus() from a script (the conformance round's renderer and UI core fixes, ADR 0419/0424).
  let { onnodes = () => {}, log = () => {} } = $props();
  let name = $state();
  let agree = $state();
  let pick = $state("b");
  let defaultValue = $state("x");
  let muted = $state(false);
  let nodes = $state({});
  $effect(() => {
    if (nodes.form) onnodes({ ...nodes, setDefault: (v) => (defaultValue = v), setMuted: (m) => (muted = m), state: () => ({ name, agree, pick }) });
  });
</script>

<form bind:this={nodes.form}>
  <input id="name" bind:this={nodes.name} {defaultValue} bind:value={name} />
  <textarea id="notes" bind:this={nodes.notes}>hello</textarea>
  <input id="check" type="checkbox" bind:this={nodes.check} defaultChecked bind:checked={agree} />
  <select id="pick" bind:this={nodes.pick} bind:value={pick}>
    <option value="a">A</option>
    <option value="b">B</option>
    <option value="c" selected>C</option>
  </select>
  <select id="plain" bind:this={nodes.plain}><option value="a">A</option><option value="b">B</option></select>
  <input id="reset" type="reset" value="Start over" bind:this={nodes.reset} />
</form>
<p id="para">Count: <input id="intext" bind:this={nodes.intext} value="7" /></p>
<audio bind:this={nodes.audio} {muted} onvolumechange={() => log(`volumechange ${nodes.audio.muted}`)}></audio>
<button id="off" disabled bind:this={nodes.off} onclick={() => log("clicked disabled")}>Off</button>
<input id="focusme" bind:this={nodes.focusme} onfocus={() => log("focus")} onblur={() => log("blur")} />
