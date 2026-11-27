<script lang="ts">
  // ADR 0428 through the renderer: HTML's form elements on UI core kinds, and their Svelte bindings (bind:checked,
  // bind:group for radios and checkboxes, bind:value with number coercion on range and number inputs, on selects and
  // text areas), labels, a form's submit and reset, and an <input> whose type changes.
  let { log, onapi }: { log: (entry: string) => void; onapi: (api: { setKind(kind: string): void; setColour(c: string): void; setLevel(n: number): void }) => void } = $props();
  let agree = $state(false);
  let size = $state("m");
  let toppings = $state<string[]>(["ham"]);
  let volume = $state(30);
  let count = $state<number | null>(2);
  let colour = $state("g");
  let level = $state(1);
  let notes = $state("");
  let kind = $state("checkbox");
  onapi({ setKind: (k) => (kind = k), setColour: (c) => (colour = c), setLevel: (n) => (level = n) });
</script>

<form
  id="form"
  align-items="flex-start"
  gap="4"
  onsubmit={(e: { preventDefault(): void }) => {
    e.preventDefault();
    log("submit");
  }}
  onreset={() => log("reset")}
>
  <label id="agree-label"><input id="agree" type="checkbox" bind:checked={agree} onchange={() => log(`agree ${agree}`)} />I agree</label>
  <div id="sizes" flex-direction="row" gap="4">
    <input id="s" type="radio" name="size" value="s" bind:group={size} />
    <input id="m" type="radio" name="size" value="m" bind:group={size} />
  </div>
  <div id="toppings" flex-direction="row" gap="4">
    <input id="ham" type="checkbox" value="ham" bind:group={toppings} />
    <input id="egg" type="checkbox" value="egg" bind:group={toppings} />
  </div>
  <input id="volume" type="range" min="0" max="100" bind:value={volume} />
  <input id="count" type="number" bind:value={count} />
  <select id="colour" bind:value={colour}>
    <option value="r">Red</option>
    <option value="g">Green</option>
  </select>
  <select id="level" bind:value={level}>
    <option value={1}>One</option>
    <option value={2}>Two</option>
  </select>
  <textarea id="notes" rows="2" bind:value={notes}></textarea>
  <progress id="bar" value={volume / 100}></progress>
  <meter id="gauge" value={0.5}></meter>
  <input id="morph" type={kind} />
  <button id="go" width="80" height="30">Go</button>
  <button id="clear" type="reset" width="80" height="30">Clear</button>
  <p id="echo">{agree} {size} {toppings.join(",")} {volume} {typeof count}:{count} {colour} {typeof level}:{level} {notes}</p>
</form>
