// The Project panel's Audio section (ADR 0097): the bus tree with per-bus effects, snapshots, ducking rules and
// the backend. Edits go through the pure functions in `audioSettingsModel.ts` and the panel's undo history.
import { useState } from "preact/hooks";
import type { AudioBackground, AudioClipFormat, AudioSettings, AudioSpatialMode, BusEffect, BusSettings } from "../../../engine/audio/settings";
import {
  CLIP_MEMORY_LIMITS,
  EFFECT_TYPES,
  MAX_BUSES,
  VOICE_LIMITS,
  VOICE_PRESET_NAMES,
  addBus,
  addDucking,
  addEffect,
  addSnapshot,
  applyVoicesPreset,
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
  setBackground,
  setBusMaxVoices,
  setBusParent,
  setBusValue,
  setClipFormat,
  setClipMemory,
  setCodec,
  setDuckingValue,
  setLimiterLookahead,
  setEffectValue,
  setSnapshotLowpass,
  setSnapshotVolume,
  setSpatial,
  setVoices,
  voicesPreset,
  LIMITER_LOOKAHEAD_LIMITS,
  type VoicePresetName,
} from "./audioSettingsModel";
import { TextField, type SettingsDraft } from "../../../editor/sdk";
import { BusMeters } from "./BusMeters";
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
        <label class="audio-bus-check" title="At most this many sounds play on the bus at once; blank is unlimited">
          Max voices
          <OptionalNum label={`${bus.name} max voices`} value={bus.maxVoices} step={1} min={1} max={a.voices.logical} placeholder="∞" onCommit={(n) => set(`Set ${bus.name} max voices`, setBusMaxVoices(draft, bus.name, n))} />
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

function Choice<T extends string>(props: { label: string; value: T; options: readonly T[]; labels?: Record<string, string>; onChange: (v: T) => void }) {
  return (
    <select aria-label={props.label} value={props.value} onChange={(e) => props.onChange((e.currentTarget as HTMLSelectElement).value as T)}>
      {props.options.map((o) => (
        <option key={o} value={o}>
          {props.labels?.[o] ?? o}
        </option>
      ))}
    </select>
  );
}

/** Voices, clip memory, formats, spatial sound, backgrounding and the backend (api-and-models §2). */
function Playback(props: { a: AudioSettings; draft: SettingsDraft; set: Set }) {
  const { a, draft, set } = props;
  const preset = voicesPreset(a);
  const voices = (key: "mixed" | "logical" | "hrtf", label: string, hint: string) => (
    <label title={hint}>
      {label}
      <Num label={`Voices ${key}`} value={a.voices[key]} step={1} min={VOICE_LIMITS[key][0]} max={VOICE_LIMITS[key][1]} onCommit={(n) => set(`Set voices ${key}`, setVoices(draft, { [key]: n }))} />
    </label>
  );
  return (
    <>
      <div class="project-settings-list-head">
        <span>Voices</span>
        <span class="project-settings-hint">how many sounds the core mixes, tracks and spatialises (core backend)</span>
      </div>
      <div class="audio-row">
        <label>
          Preset
          <select aria-label="Voices preset" value={preset} onChange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; if (v !== "custom") set(`Apply ${v} voices preset`, applyVoicesPreset(draft, v as VoicePresetName)); }}>
            {VOICE_PRESET_NAMES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            {preset === "custom" && <option value="custom">custom</option>}
          </select>
        </label>
        {voices("mixed", "Mixed", "Sounds mixed at once (8..512)")}
        {voices("logical", "Logical", "Sounds tracked, including silent virtual ones (mixed..8192)")}
        {voices("hrtf", "HRTF", "Spatial sounds rendered with HRTF (0..32); 0 is equal-power only")}
      </div>

      <div class="project-settings-list-head">
        <span>Playback</span>
      </div>
      <div class="audio-row">
        <label>
          Spatial
          <Choice<AudioSpatialMode> label="Spatial mode" value={a.spatial} options={["hrtf", "equalPower"]} labels={{ equalPower: "equal power" }} onChange={(v) => set("Set spatial mode", setSpatial(draft, v))} />
        </label>
        <label title="What the page being hidden does to sound">
          In background
          <Choice<AudioBackground> label="Audio background" value={a.background} options={["mute", "pause", "play"]} onChange={(v) => set("Set audio background", setBackground(draft, v))} />
        </label>
        <label title="The master limiter looks this far ahead (0..5 ms) so it can lower the gain smoothly before a peak; it delays all core output by as much. 0 is no delay and an instant attack. Applies when the core next starts.">
          Limiter look-ahead (ms)
          <Num label="Limiter look-ahead (ms)" value={a.limiterLookaheadMs} step={0.5} min={LIMITER_LOOKAHEAD_LIMITS[0]} max={LIMITER_LOOKAHEAD_LIMITS[1]} onCommit={(n) => set("Set limiter look-ahead", setLimiterLookahead(draft, n))} />
        </label>
      </div>
      <div class="audio-row">
        <label title="Ceiling for decoded clips in MB (16..1024); blank uses the device preset's">
          Clip memory (MB)
          <OptionalNum label="Clip memory MB" value={a.clipMemoryMB} step={16} min={CLIP_MEMORY_LIMITS[0]} max={CLIP_MEMORY_LIMITS[1]} placeholder="auto" onCommit={(n) => set("Set clip memory", setClipMemory(draft, n))} />
        </label>
        <label title="Sample format of decoded clips: 16-bit integer halves the memory">
          Clip format
          <Choice<AudioClipFormat> label="Clip format" value={a.clipFormat} options={["i16", "f32"]} labels={{ i16: "16-bit", f32: "32-bit float" }} onChange={(v) => set("Set clip format", setClipFormat(draft, v))} />
        </label>
        <label class="audio-bus-check" title="Also decode AAC (.m4a, .mp4, .aac) on the audio core: the core then loads its larger AAC decoder (about 1 MB instead of 0.7 MB). Off, AAC assets don't play on the core (one warning each); the Babylon backend plays them wherever the browser does">
          <input type="checkbox" aria-label="AAC codec" checked={a.codecs.aac} onChange={(e) => set(`${a.codecs.aac ? "Disable" : "Enable"} AAC`, setCodec(draft, "aac", (e.currentTarget as HTMLInputElement).checked))} />
          AAC
        </label>
      </div>

      <div class="project-settings-list-head">
        <span>Backend</span>
        <span class="project-settings-hint">core (the default) is the Rust mixer; babylon is the fallback without effects or voice limits. macOS desktop builds default to babylon until macOS passes its gate</span>
      </div>
      <div class="audio-row">
        <Choice<"babylon" | "core"> label="Audio backend" value={a.backend} options={["core", "babylon"]} onChange={(v) => set("Set audio backend", setBackend(draft, v))} />
      </div>
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
      <BusMeters names={a.buses.map((b) => b.name)} />
      <div class="project-settings-list-head">
        <span>Buses</span>
        <span class="project-settings-hint">a tree feeding Master; expand a bus for its effects (up to {MAX_BUSES})</span>
      </div>
      {busTree(a).map(({ bus, depth }) => (
        <BusRow key={bus.name} a={a} bus={bus} depth={depth} draft={draft} set={set} />
      ))}

      <Snapshots a={a} draft={draft} set={set} />
      <Ducking a={a} draft={draft} set={set} />

      <Playback a={a} draft={draft} set={set} />
    </div>
  );
}
