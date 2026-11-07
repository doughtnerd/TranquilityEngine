// A context in a system (ADR 0060): a coloured header carrying the context's settings inline
// (Spawn's cycle; the system's capacity and space on Initialize, as in VFX Graph; Output's type,
// material or texture and blending), then its stack of blocks and a "+" to add one.
import { Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ContextKind, OutputContext, OutputSettings, ParticleGraphSystem, SimulationChoice } from "../../../engine/scene/particleGraph";
import { OUTPUT_TYPES } from "../../../engine/scene/particleGraph";
import { BUILTIN_MESHES } from "../../../engine/scene/models";
import { NO_DRAG } from "../../graph";
import { contextOf, outputCount, removeOutput, setOutputSettings, setOutputSoftness, setOutputType, setSeed, setSimulation, setSpawnSettings, setSystemSettings } from "../../particleGraph/graphEdit";
import { NumField } from "../particles/valueInputs";
import { BlockView, Port } from "./BlockView";
import { useGraphEditor } from "./editorContext";
import { CONTEXT_TITLES, OUTPUT_LABELS } from "./layout";
import { AssetValue, BoolValue, ChoiceValue } from "./valueFields";

const BLENDINGS: OutputSettings["blending"][] = ["additive", "alpha", "premultiplied"];

function Setting(props: { label: string; title?: string; children: preact.ComponentChildren }) {
  return (
    <label class="pg-setting" title={props.title}>
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

function SpawnSettings(props: { system: ParticleGraphSystem }) {
  const { graph, readOnly, commit, eventTargets } = useGraphEditor();
  const s = props.system.spawn.settings;
  const id = props.system.id;
  const set = (patch: Partial<typeof s>) => commit(setSpawnSettings(graph, id, patch));
  return (
    <>
      <div class="pg-events">
        <span class="pg-event-in">
          <Port owner={id} port="start" side="input" type="event" label="Start" filled={eventTargets.has(`${id}.start`)} title="Start: an event wired here starts this system (a Trigger Event spawns it from each particle)" />
          Start
        </span>
        <span class="pg-event-in">
          <Port owner={id} port="stop" side="input" type="event" label="Stop" filled={eventTargets.has(`${id}.stop`)} title="Stop: an event wired here stops this system spawning" />
          Stop
        </span>
      </div>
      <div class="pg-settings">
        <Setting label="Duration" title="Seconds per spawn cycle">
          <NumField label="Duration" value={s.duration} min={0} disabled={readOnly} onCommit={(n) => set({ duration: n })} />
        </Setting>
        <Setting label="Looping">
          <BoolValue label="Looping" value={s.looping} readOnly={readOnly} onChange={(v) => set({ looping: v })} />
        </Setting>
        <Setting label="Start delay" title="Seconds before spawning starts">
          <NumField label="Start delay" value={s.startDelay} min={0} disabled={readOnly} onCommit={(n) => set({ startDelay: n })} />
        </Setting>
        <Setting label="Prewarm" title="Start as if a full cycle had already run">
          <BoolValue label="Prewarm" value={s.prewarm} readOnly={readOnly} onChange={(v) => set({ prewarm: v })} />
        </Setting>
      </div>
    </>
  );
}

const SIMULATIONS: SimulationChoice[] = ["auto", "cpu", "gpu"];
const SIMULATION_LABELS: Record<string, string> = { auto: "Auto", cpu: "CPU", gpu: "GPU" };

/** An integer seed; empty means the component's seed. */
function SeedField(props: { value: number | null | undefined; disabled: boolean; onCommit: (seed: number | null) => void }) {
  const shown = props.value === null || props.value === undefined ? "" : String(props.value);
  const [draft, setDraft] = useState(shown);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(shown);
  }, [shown]);
  return (
    <input
      type="text"
      inputMode="numeric"
      class="num-input pe-num"
      aria-label="Seed"
      placeholder="Component's"
      disabled={props.disabled}
      value={draft}
      onFocus={() => (focused.current = true)}
      onInput={(e) => {
        const text = (e.currentTarget as HTMLInputElement).value;
        setDraft(text);
        if (text.trim() === "") props.onCommit(null);
        else if (/^-?\d+$/.test(text.trim())) props.onCommit(Number(text.trim()));
      }}
      onBlur={() => {
        focused.current = false;
        setDraft(shown);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" || e.key === "Escape") (e.currentTarget as HTMLInputElement).blur();
      }}
    />
  );
}

function InitializeSettings(props: { system: ParticleGraphSystem }) {
  const { graph, readOnly, commit } = useGraphEditor();
  const s = props.system.settings;
  return (
    <div class="pg-settings">
      <Setting label="Capacity" title="The most particles alive at once">
        <NumField label="Capacity" value={s.capacity} min={1} integer disabled={readOnly} onCommit={(n) => commit(setSystemSettings(graph, props.system.id, { capacity: n }))} />
      </Setting>
      <Setting label="Space" title="World: particles stay where they were born as the node moves. Local: they move with it.">
        <ChoiceValue label="Space" value={s.space} choices={["world", "local"]} readOnly={readOnly} onChange={(v) => commit(setSystemSettings(graph, props.system.id, { space: v as "world" | "local" }))} />
      </Setting>
      <Setting label="Simulation" title="Auto runs on the GPU when the system needs it (per-particle operators, Set Attribute, several outputs, GPU events, depth collision) or has 4096+ particles. CPU and GPU force one.">
        <ChoiceValue label="Simulation" value={s.simulation ?? "auto"} choices={SIMULATIONS} labels={SIMULATION_LABELS} readOnly={readOnly} onChange={(v) => commit(setSimulation(graph, props.system.id, v === "auto" ? undefined : (v as SimulationChoice)))} />
      </Setting>
      <Setting label="Seed" title="This system's random seed (an integer). Empty uses the component's seed. Only kernel (GPU) simulation uses per-system seeds.">
        <SeedField value={s.seed} disabled={readOnly} onCommit={(n) => commit(setSeed(graph, props.system.id, n))} />
      </Setting>
    </div>
  );
}

function OutputSettingsView(props: { system: ParticleGraphSystem; output: number }) {
  const { graph, readOnly, commit, assets } = useGraphEditor();
  const out = contextOf(props.system, "output", props.output) as OutputContext;
  const s = out.settings;
  const id = props.system.id;
  const o = props.output;
  const set = (patch: Partial<OutputSettings>) => commit(setOutputSettings(graph, id, patch, o));
  return (
    <div class="pg-settings">
      <Setting label="Type">
        <ChoiceValue label="Output type" value={out.type} choices={OUTPUT_TYPES} labels={OUTPUT_LABELS} readOnly={readOnly} onChange={(v) => commit(setOutputType(graph, id, v as typeof out.type, o))} />
      </Setting>
      <Setting label="Material" title="A material asset; with none, an unlit material using the texture and blending">
        <AssetValue label="Material" value={s.material} assets={assets.materials} none="(none)" readOnly={readOnly} onChange={(v) => set({ material: v })} />
      </Setting>
      {!s.material && (
        <>
          <Setting label="Texture">
            <AssetValue label="Texture" value={s.texture} assets={assets.images} none="Soft dot" readOnly={readOnly} onChange={(v) => set({ texture: v })} />
          </Setting>
          <Setting label="Blending">
            <ChoiceValue label="Blending" value={s.blending} choices={BLENDINGS} readOnly={readOnly} onChange={(v) => set({ blending: v as OutputSettings["blending"] })} />
          </Setting>
        </>
      )}
      <Setting label="Softness" title="Soft particles fade near surfaces (metres, 0 = off). Kernel (GPU) outputs only.">
        <NumField label="Softness" value={s.softness ?? 0} min={0} disabled={readOnly} onCommit={(n) => commit(setOutputSoftness(graph, id, n, o))} />
      </Setting>
      <Setting label="Render order" title="Higher draws later">
        <NumField label="Render order" value={s.renderOrder} integer disabled={readOnly} onCommit={(n) => set({ renderOrder: n })} />
      </Setting>
      {out.type === "mesh" && (
        <Setting label="Mesh">
          <AssetValue label="Mesh" value={s.mesh} builtins={BUILTIN_MESHES.map((m) => `builtin:${m}`)} assets={assets.meshes} none="(none)" readOnly={readOnly} onChange={(v) => set({ mesh: v })} />
        </Setting>
      )}
      {out.type === "stretched" && (
        <>
          <Setting label="Speed scale" title="Stretch by speed">
            <NumField label="Speed scale" value={s.speedScale} disabled={readOnly} onCommit={(n) => set({ speedScale: n })} />
          </Setting>
          <Setting label="Length scale" title="Stretch by size">
            <NumField label="Length scale" value={s.lengthScale} disabled={readOnly} onCommit={(n) => set({ lengthScale: n })} />
          </Setting>
        </>
      )}
      {out.type === "trail" && (
        <Setting label="Trail length" title="Length in points">
          <NumField label="Trail length" value={s.trailLength} min={2} integer disabled={readOnly} onCommit={(n) => set({ trailLength: n })} />
        </Setting>
      )}
    </div>
  );
}

const DropLine = () => <div class="pg-drop-line" aria-hidden="true" />;

/** A context of a system. `output` picks the Output context (0 = the main one, 1 and up = extra outputs). */
export function ContextView(props: { system: ParticleGraphSystem; kind: ContextKind; output?: number }) {
  const api = useGraphEditor();
  const { system, kind } = props;
  const output = kind === "output" ? (props.output ?? 0) : 0;
  const extra = kind === "output" && output > 0;
  const blocks = contextOf(system, kind, output)!.blocks;
  const base = CONTEXT_TITLES[kind];
  const title = kind === "output" && outputCount(system) > 1 ? `${base} ${output + 1}` : base;
  const drop = api.blockDrop && api.blockDrop.system === system.id && api.blockDrop.kind === kind && api.blockDrop.output === output ? api.blockDrop.index : -1;
  return (
    <section class={`pg-context k-${kind}`} data-context={kind === "output" ? `${system.id}:output:${output}` : `${system.id}:${kind}`} aria-label={title}>
      <header class="pg-context-head">
        <div class="pg-context-title" title={kind === "update" ? "Blocks apply in order, top first." : undefined}>
          {title}
          {kind === "output" && <span class="pg-context-sub"> {OUTPUT_LABELS[(contextOf(system, "output", output) as OutputContext).type]}</span>}
          {extra && (
            <button type="button" class={`pg-x pg-output-x ${NO_DRAG}`} aria-label={`Remove ${title}`} title="Remove this output" disabled={api.readOnly} onClick={() => api.commit(removeOutput(api.graph, system.id, output))}>
              ×
            </button>
          )}
        </div>
        {kind === "spawn" && <SpawnSettings system={system} />}
        {kind === "initialize" && <InitializeSettings system={system} />}
        {kind === "output" && <OutputSettingsView system={system} output={output} />}
      </header>
      <div class={`pg-blocks ${NO_DRAG}`}>
        {blocks.map((b, i) => (
          <Fragment key={b.id}>
            {drop === i && <DropLine />}
            <BlockView system={system} kind={kind} block={b} />
          </Fragment>
        ))}
        {drop === blocks.length && <DropLine />}
        {blocks.length === 0 && drop < 0 && <p class="pg-blocks-empty">No blocks</p>}
        <button
          type="button"
          class="pg-add-block"
          aria-label={`Add block to ${title}`}
          title={`Add a block to ${title} (or press Space over it)`}
          disabled={api.readOnly}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            api.openBlockSearch(system.id, kind, output, { x: r.left, y: r.bottom });
          }}
        >
          +
        </button>
      </div>
    </section>
  );
}
