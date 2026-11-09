// The Project panel's Audio section (ADR 0097): the bus tree with per-bus effects, snapshots, ducking rules and
// the backend. Edits go through the pure functions in `audioSettingsModel.ts` and the panel's undo history.
import { useState } from "preact/hooks";
import type { AudioSettings, BusEffect, BusSettings } from "../../engine/audio/settings";
import {
  EFFECT_TYPES,
  MAX_BUSES,
  addBus,
  addDucking,
  addEffect,
  addSnapshot,
  audioOf,
  busTree,
  descendants,
  removeBus,
  removeDucking,
  removeEffect,
  removeSnapshot,
  renameBus,
  renameSnapshot,
  setBackend,
  setBusParent,
  setBusValue,
  setDuckingValue,
  setEffectValue,
  setFmod,
  setSnapshotLowpass,
  setSnapshotVolume,
} from "../audioSettingsModel";
import type { SettingsDraft } from "../projectSettingsModel";
import { TextField } from "./settingsControls";
import "./audioSettings.css";

type Set = (label: string, next: SettingsDraft) => void;

function Num(props: { label: string; value: number; step?: number; min?: number; max?: number; onCommit: (n: number) => void }) {
  return (
    <input
      type="number"
      aria-label={props.label}
      value={props.value}
      step={props.step ?? "any"}
      min={props.min}
      max={props.max}
      onChange={(e) => {
        const n = (e.currentTarget as HTMLInputElement).valueAsNumber;
        if (Number.isFinite(n) && n !== props.value) props.onCommit(n);
      }}
    />
  );
}

/** A number input where blank means unset. */
function OptionalNum(props: { label: string; value: number | undefined; step?: number; min?: number; max?: number; placeholder?: string; onCommit: (n: number | undefined) => void }) {
  return (
    <input
      type="number"
      aria-label={props.label}
      placeholder={props.placeholder}
      value={props.value ?? ""}
      step={props.step ?? "any"}
      min={props.min}
      max={props.max}
      onChange={(e) => {
        const el = e.currentTarget as HTMLInputElement;
        if (el.value.trim() === "") {
          if (props.value !== undefined) props.onCommit(undefined);
        } else if (Number.isFinite(el.valueAsNumber) && el.valueAsNumber !== props.value) props.onCommit(el.valueAsNumber);
      }}
    />
  );
}

const EFFECT_FIELDS: Record<BusEffect["type"], [key: string, label: string, step: number][]> = {
  lowpass: [["frequency", "Frequency (Hz)", 100], ["q", "Q", 0.1]],
  highpass: [["frequency", "Frequency (Hz)", 10], ["q", "Q", 0.1]],
  compressor: [["threshold", "Threshold (dB)", 1], ["knee", "Knee", 1], ["ratio", "Ratio", 1], ["attack", "Attack (s)", 0.001], ["release", "Release (s)", 0.01]],
  reverb: [["send", "Send (0-1)", 0.05]],
};

function Effects(props: { bus: BusSettings; draft: SettingsDraft; set: Set }) {
  const { bus, draft, set } = props;
  return (
    <>
      {bus.effects.map((fx, i) => (
        <div key={i} class="audio-effect" data-effect={fx.type}>
          <span class="audio-effect-type">{fx.type}</span>
          {EFFECT_FIELDS[fx.type].map(([key, label, step]) => (
            <label key={key}>
              {label}
              <Num label={`${bus.name} ${fx.type} ${label}`} value={(fx as unknown as Record<string, number>)[key]} step={step} onCommit={(n) => set(`Set ${bus.name} ${fx.type} ${key}`, setEffectValue(draft, bus.name, i, key, n))} />
            </label>
          ))}
          <button class="icon audio-remove" aria-label={`Remove ${bus.name} ${fx.type} effect`} title="Remove this effect" onClick={() => set(`Remove ${bus.name} ${fx.type}`, removeEffect(draft, bus.name, i))}>
            ×
          </button>
        </div>
      ))}
      <AddEffect bus={bus} draft={draft} set={set} />
    </>
  );
}

function AddEffect(props: { bus: BusSettings; draft: SettingsDraft; set: Set }) {
  const { bus, draft, set } = props;
  const [chosen, setChosen] = useState<string>(EFFECT_TYPES[0]);
  return (
    <div class="audio-add-effect">
      <select aria-label={`${bus.name} new effect type`} value={chosen} onChange={(e) => setChosen((e.currentTarget as HTMLSelectElement).value)}>
        {EFFECT_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <button aria-label={`Add effect to ${bus.name}`} onClick={() => set(`Add ${chosen} to ${bus.name}`, addEffect(draft, bus.name, chosen as (typeof EFFECT_TYPES)[number]))}>
        Add effect
      </button>
    </div>
  );
}

function BusRow(props: { a: AudioSettings; bus: BusSettings; depth: number; draft: SettingsDraft; set: Set }) {
  const { a, bus, depth, draft, set } = props;
  const isRoot = bus === a.buses[0];
  const banned = new globalThis.Set([bus.name, ...descendants(a, bus.name)]);
  return (
    <details class="audio-bus" data-bus={bus.name} style={{ marginLeft: `${depth * 16}px`, width: `calc(100% - ${depth * 16}px)` }}>
      <summary>
        <TextField class="audio-bus-name" value={bus.name} label={`Bus ${bus.name} name`} onCommit={(v) => set(`Rename bus ${bus.name} to ${v.trim()}`, renameBus(draft, bus.name, v))} />
        <Num label={`${bus.name} volume`} value={bus.volume} step={0.05} min={0} max={2} onCommit={(n) => set(`Set ${bus.name} volume`, setBusValue(draft, bus.name, "volume", Math.min(2, Math.max(0, n))))} />
        <label class="audio-bus-check">
          <input type="checkbox" aria-label={`Mute ${bus.name}`} checked={bus.mute} onChange={(e) => set(`${bus.mute ? "Unmute" : "Mute"} ${bus.name}`, setBusValue(draft, bus.name, "mute", (e.currentTarget as HTMLInputElement).checked))} />
          Mute
        </label>
        {!isRoot && (
          <select aria-label={`${bus.name} parent`} value={bus.parent} onChange={(e) => set(`Move ${bus.name} under ${(e.currentTarget as HTMLSelectElement).value}`, setBusParent(draft, bus.name, (e.currentTarget as HTMLSelectElement).value))}>
            {a.buses.filter((b) => !banned.has(b.name)).map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
        )}
        <button aria-label={`Add child bus to ${bus.name}`} disabled={a.buses.length >= MAX_BUSES} onClick={() => set(`Add bus under ${bus.name}`, addBus(draft, bus.name))}>
          + child
        </button>
        {!isRoot && (
          <button class="icon audio-remove" aria-label={`Remove bus ${bus.name}`} title="Remove this bus and everything under it" onClick={() => set(`Remove bus ${bus.name}`, removeBus(draft, bus.name))}>
            ×
          </button>
        )}
      </summary>
      <div class="audio-bus-body">
        <span class="project-settings-hint">Effects{bus.effects.length === 0 ? ": none" : ""}</span>
        <Effects bus={bus} draft={draft} set={set} />
      </div>
    </details>
  );
}

function Snapshots(props: { a: AudioSettings; draft: SettingsDraft; set: Set }) {
  const { a, draft, set } = props;
  return (
    <>
      <div class="project-settings-list-head">
        <span>Snapshots</span>
        <span class="project-settings-hint">named mixes the mixer fades to; blank volume = unchanged</span>
      </div>
      {a.snapshots.length === 0 && <p class="project-settings-none">None</p>}
      {a.snapshots.map((s, i) => (
        <div key={i} class="audio-card" role="group" aria-label={`Snapshot ${s.name}`}>
          <div class="audio-row">
            <TextField class="audio-grow" value={s.name} label={`Snapshot ${i + 1} name`} onCommit={(v) => set(`Rename snapshot to ${v.trim()}`, renameSnapshot(draft, i, v))} />
            <button class="icon audio-remove" aria-label={`Remove snapshot ${s.name}`} title="Remove this snapshot" onClick={() => set(`Remove snapshot ${s.name}`, removeSnapshot(draft, i))}>
              ×
            </button>
          </div>
          {a.buses.map((b) => (
            <div key={b.name} class="audio-row">
              <span class="audio-grow">{b.name}</span>
              <label>
                Volume ×
                <OptionalNum label={`${s.name} ${b.name} volume`} value={s.volumes[b.name]} step={0.05} min={0} max={2} placeholder="1" onCommit={(n) => set(`Set ${s.name} ${b.name} volume`, setSnapshotVolume(draft, i, b.name, n === undefined ? undefined : Math.min(2, Math.max(0, n))))} />
              </label>
              <label>
                Low-pass Hz
                <OptionalNum label={`${s.name} ${b.name} low-pass`} value={s.lowpass[b.name]} step={100} min={10} max={24000} placeholder="off" onCommit={(n) => set(`Set ${s.name} ${b.name} low-pass`, setSnapshotLowpass(draft, i, b.name, n === undefined ? undefined : Math.min(24000, Math.max(10, n))))} />
              </label>
            </div>
          ))}
        </div>
      ))}
      <button onClick={() => set("Add snapshot", addSnapshot(draft))}>+ Snapshot</button>
    </>
  );
}

function Ducking(props: { a: AudioSettings; draft: SettingsDraft; set: Set }) {
  const { a, draft, set } = props;
  const BusSelect = (p: { label: string; value: string; index: number; field: "target" | "trigger" }) => (
    <select aria-label={p.label} value={p.value} onChange={(e) => set(`Set ducking ${p.field}`, setDuckingValue(draft, p.index, p.field, (e.currentTarget as HTMLSelectElement).value))}>
      {a.buses.map((b) => (
        <option key={b.name} value={b.name}>
          {b.name}
        </option>
      ))}
    </select>
  );
  return (
    <>
      <div class="project-settings-list-head">
        <span>Ducking</span>
        <span class="project-settings-hint">lower the target while the trigger bus has sounds playing</span>
      </div>
      {a.ducking.length === 0 && <p class="project-settings-none">None</p>}
      {a.ducking.map((r, i) => (
        <div key={i} class="audio-card" role="group" aria-label={`Ducking rule ${i + 1}`}>
          <div class="audio-row">
            <label>
              Target
              <BusSelect label={`Ducking ${i + 1} target`} value={r.target} index={i} field="target" />
            </label>
            <label>
              Trigger
              <BusSelect label={`Ducking ${i + 1} trigger`} value={r.trigger} index={i} field="trigger" />
            </label>
            <label>
              Amount
              <Num label={`Ducking ${i + 1} amount`} value={r.amount} step={0.05} min={0} max={1} onCommit={(n) => set("Set ducking amount", setDuckingValue(draft, i, "amount", Math.min(1, Math.max(0, n))))} />
            </label>
            <label>
              Attack (s)
              <Num label={`Ducking ${i + 1} attack`} value={r.attack} step={0.05} min={0} onCommit={(n) => set("Set ducking attack", setDuckingValue(draft, i, "attack", Math.max(0, n)))} />
            </label>
            <label>
              Release (s)
              <Num label={`Ducking ${i + 1} release`} value={r.release} step={0.05} min={0} onCommit={(n) => set("Set ducking release", setDuckingValue(draft, i, "release", Math.max(0, n)))} />
            </label>
            <button class="icon audio-remove" aria-label={`Remove ducking rule ${i + 1}`} title="Remove this rule" onClick={() => set("Remove ducking rule", removeDucking(draft, i))}>
              ×
            </button>
          </div>
        </div>
      ))}
      <button disabled={a.buses.length < 2} onClick={() => set("Add ducking rule", addDucking(draft))}>
        + Ducking rule
      </button>
    </>
  );
}

/** The Audio section's contents. `problems` are the section's parse problems. */
export function AudioSettingsSection(props: { draft: SettingsDraft; problems: readonly string[]; set: Set }) {
  const { draft, set } = props;
  const a = audioOf(draft);
  return (
    <div class={`project-settings-list audio-settings${props.problems.length ? " invalid" : ""}`} role="group" aria-label="Audio settings">
      {props.problems.length > 0 && (
        <ul class="audio-problems" role="alert" aria-label="Audio problems">
          {props.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div class="project-settings-list-head">
        <span>Buses</span>
        <span class="project-settings-hint">a tree feeding Master; expand a bus for its effects (up to {MAX_BUSES})</span>
      </div>
      {busTree(a).map(({ bus, depth }) => (
        <BusRow key={bus.name} a={a} bus={bus} depth={depth} draft={draft} set={set} />
      ))}

      <Snapshots a={a} draft={draft} set={set} />
      <Ducking a={a} draft={draft} set={set} />

      <div class="project-settings-list-head">
        <span>Backend</span>
      </div>
      <div class="audio-row">
        <select aria-label="Audio backend" value={a.backend} onChange={(e) => set("Set audio backend", setBackend(draft, (e.currentTarget as HTMLSelectElement).value as "howler" | "fmod"))}>
          <option value="howler">howler</option>
          <option value="fmod">fmod</option>
        </select>
      </div>
      {a.backend === "fmod" && (
        <>
          <div class="audio-row">
            <label class="audio-grow">
              SDK path
              <TextField class="audio-grow" value={a.fmod?.sdkPath ?? ""} label="FMOD SDK path" onCommit={(v) => set("Set FMOD SDK path", setFmod(draft, v.trim(), a.fmod?.banks ?? []))} />
            </label>
            <label class="audio-grow">
              Banks
              <TextField class="audio-grow" value={(a.fmod?.banks ?? []).join(", ")} label="FMOD banks" placeholder="Master.bank, Master.strings.bank" onCommit={(v) => set("Set FMOD banks", setFmod(draft, a.fmod?.sdkPath ?? "", v.split(",").map((b) => b.trim()).filter((b) => b !== "")))} />
            </label>
          </div>
          <p class="project-settings-hint">Experimental (ADR 0099): see docs/guide/fmod.md; the FMOD SDK isn't bundled.</p>
        </>
      )}
    </div>
  );
}
