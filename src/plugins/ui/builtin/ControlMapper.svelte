<script lang="ts">
  // The built-in rebinding screen's view (ADR 0337, 0419 wave B): `UIControlMapper` works out what it shows and passes
  // it in as `model`; this draws it. Every button has an id the mapper finds it by (its public `UIButton`s, whose
  // explicit navigation neighbours it sets), and the look comes from the mapper's colour and size fields, as CSS
  // custom properties.
  interface Glyph { asset: string; width: number; height: number }
  interface Cell { id: string; label: string; glyphs: Glyph[]; tone: "text" | "muted" | "warning"; waiting: boolean; interactable: boolean }
  interface Row { key: string; label: string; keyboard: Cell | null; gamepad: Cell | null }
  interface SettingButton { id: string; interactable: boolean }
  interface Setting { key: string; label: string; value: string; enabled: boolean; toggle: SettingButton | null; decrease: SettingButton | null; increase: SettingButton | null }
  interface Model {
    title: string;
    headers: { action: string; keyboard: string | null; gamepad: string | null };
    rows: Row[];
    accessibility: string | null;
    settings: Setting[];
    decrease: string;
    increase: string;
    status: string;
    statusWarning: boolean;
    unbind: { label: string; enabled: boolean };
    reset: string;
    save: string;
    look: { width: string; fontSize: number; glyphSize: number; colors: Record<string, string> };
  }

  let { model }: { model: Model | null } = $props();

  let look = $derived(model?.look ?? { width: "auto", fontSize: 18, glyphSize: 30, colors: {} });
  let vars = $derived(Object.entries(look.colors).map(([k, v]) => `--${k}: ${v}`).join("; "));
  let height = $derived(look.glyphSize + 14);
</script>

{#snippet cell(c: Cell)}
  <button id={c.id} class="cell" class:waiting={c.waiting} interactable={String(c.interactable)} height={height}>
    {#each c.glyphs as g, i (i)}
      <img src={g.asset} height={look.glyphSize} width={Math.round((look.glyphSize * g.width) / g.height)} />
    {/each}
    <span class={`label ${c.tone}`} word-break="keep-all">{c.label}</span>
  </button>
{/snippet}

{#snippet side(b: SettingButton, label: string, enabled: boolean)}
  <button id={b.id} class="side" interactable={String(b.interactable)} width={height} height={height}>
    <span class:muted={!enabled}>{label}</span>
  </button>
{/snippet}

{#if model}
<div class="screen" style={vars}>
  <div id="panel" class="panel" style:width={look.width} style:font-size={`${look.fontSize}px`}>
    <span id="title" class="title" style:font-size={`${Math.round(look.fontSize * 1.5)}px`}>{model.title}</span>
    <div class="header">
      <span class="name muted">{model.headers.action}</span>
      {#if model.headers.keyboard !== null}<span class="column muted">{model.headers.keyboard}</span>{/if}
      {#if model.headers.gamepad !== null}<span class="column muted">{model.headers.gamepad}</span>{/if}
    </div>
    <div id="rows" class="list">
      {#each model.rows as r (r.key)}
        <div class="row">
          <span class="name">{r.label}</span>
          {#if r.keyboard}{@render cell(r.keyboard)}{/if}
          {#if r.gamepad}{@render cell(r.gamepad)}{/if}
        </div>
      {/each}
    </div>
    {#if model.accessibility !== null}
      <span id="accessibility" class="title" style:font-size={`${Math.round(look.fontSize * 1.2)}px`}>{model.accessibility}</span>
      <div id="settings" class="list">
        {#each model.settings as s (s.key)}
          <div class="row">
            <span class="name">{s.label}</span>
            {#if s.toggle}
              <button id={s.toggle.id} class="toggle" interactable={String(s.toggle.interactable)} height={height}>
                <span class:muted={!s.enabled}>{s.value}</span>
              </button>
            {:else if s.decrease && s.increase}
              {@render side(s.decrease, model.decrease, s.enabled)}
              <span class="value" class:muted={!s.enabled}>{s.value}</span>
              {@render side(s.increase, model.increase, s.enabled)}
            {/if}
          </div>
        {/each}
      </div>
    {/if}
    {#if model.status}
      <span id="status" class={model.statusWarning ? "warning" : "muted"}>{model.status}</span>
    {/if}
    <div class="buttons">
      <button id="unbind" interactable={String(model.unbind.enabled)}><span class:muted={!model.unbind.enabled}>{model.unbind.label}</span></button>
      <button id="reset"><span>{model.reset}</span></button>
      <button id="save"><span>{model.save}</span></button>
    </div>
  </div>
</div>
{/if}

<style>
  .screen {
    width: 100%;
    height: 100%;
    justify-content: center;
    align-items: center;
  }
  .panel {
    flex-direction: column;
    padding: 24px;
    gap: 10px;
    border-radius: 12px;
    background-color: var(--background);
    color: var(--text);
  }
  .title {
    font-weight: bold;
  }
  .header,
  .row {
    gap: 8px;
    align-items: center;
  }
  .list {
    flex-direction: column;
    gap: 6px;
  }
  .name {
    width: 34%;
  }
  .column,
  .value {
    flex-grow: 1;
    width: 0;
  }
  .value {
    text-align: center;
  }
  .buttons {
    gap: 8px;
    justify-content: flex-end;
  }
  button {
    border-width: 2px;
    background-color: var(--cell);
    hover-color: var(--hover);
    pressed-color: var(--pressed);
    focus-color: var(--hover);
    border-color: var(--cell);
  }
  /* The focused button shows the accent border, after mouse use too: Delete, Backspace and Unbind act on what has focus. */
  button:focus {
    border-color: var(--accent);
  }
  .cell {
    flex-grow: 1;
    width: 0;
    padding: 6px;
    gap: 8px;
    justify-content: flex-start;
  }
  .toggle {
    flex-grow: 1;
    width: 0;
    padding: 6px;
    justify-content: center;
    align-items: center;
  }
  .side {
    justify-content: center;
    align-items: center;
  }
  /* The cell waiting for a press. */
  .cell.waiting {
    background-color: var(--accent);
    hover-color: var(--accent);
    focus-color: var(--accent);
    border-color: var(--accent);
  }
  .muted {
    color: var(--muted);
  }
  .warning {
    color: var(--warning);
  }
</style>
