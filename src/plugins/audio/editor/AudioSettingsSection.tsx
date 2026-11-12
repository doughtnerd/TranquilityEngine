// The Project panel's Audio section (ADR 0097): the bus tree with per-bus effects, snapshots, ducking rules and
// the backend. Edits go through the pure functions in `audioSettingsModel.ts` and the panel's undo history.
import { useState } from "preact/hooks";
import type { AudioBackground, AudioClipFormat, AudioSettings, AudioSpatialMode, BusBed, BusEffect, BusSettings } from "../../../engine/audio/settings";
import { AMBISONIC_LIMITS, BED_LIMITS, BED_PRIORITY_LIMITS, BUS_BEDS, OCCLUSION_LIMITS, SPEED_OF_SOUND_LIMITS, ZONE_LIMITS, busBed, busBedPriority } from "../../../engine/audio/settings";
import { MATERIAL_LIMITS, MAX_MATERIALS, type OccluderMaterial } from "../../../engine/audio/occlusionMaterials";
import {
  addMaterial,
  bedPlan,
  isBuiltinMaterial,
  materialIsModified,
  physicsLayerNames,
  removeMaterial,
  renameMaterial,
  resetMaterial,
  setBed,
  setBusBed,
  setBusBedPriority,
  setDoppler,
  setMaterial,
  setMaxClips,
  setOcclusion,
  setZones,
  toggleOcclusionLayer,
  zoneMemory,
  zoneSlots,
  zoneWarnings,
  type BedPlan,
  type MaterialPatch,
  CLIP_MEMORY_LIMITS,
  EFFECT_TYPES,
  MAX_BUSES,
  VOICE_LIMITS,
  VOICE_PRESET_NAMES,
  MAX_PARAMETERS,
  addBus,
  addBusAutomation,
  addParameter,
  removeBusAutomation,
  removeParameter,
  renameParameter,
  setBusAutomationBus,
  setBusAutomationCurve,
  setBusAutomationParameter,
  setBusAutomationTarget,
  setParameterDefaultLabel,
  setParameterLabelled,
  setParameterLabels,
  setParameterRange,
  parameterOf,
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
  setMusicRings,
  setRhythmMode,
  MUSIC_RINGS_LIMITS,
  setVoices,
  voicesPreset,
  LIMITER_LOOKAHEAD_LIMITS,
  type VoicePresetName,
} from "./audioSettingsModel";
import { CurveEditor, TextField, type SettingsDraft } from "../../../editor/sdk";
import { isLabelled, parameterRange } from "../../../engine/audio/eventFormat";
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

function BusRow(props: { a: AudioSettings; bus: BusSettings; depth: number; plan: BedPlan; draft: SettingsDraft; set: Set }) {
  const { a, bus, depth, plan, draft, set } = props;
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
        <BusBedRow a={a} bus={bus} plan={plan} draft={draft} set={set} />
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

/** ADR 0158 §2: global parameters, numeric (min, max, default, seek speed) or labelled (a label list and a default). */
function Parameters(props: { a: AudioSettings; draft: SettingsDraft; set: Set }) {
  const { a, draft, set } = props;
  return (
    <>
      <div class="project-settings-list-head">
        <span>Parameters</span>
        <span class="project-settings-hint">global values events and bus automation read; labelled ones are states (up to {MAX_PARAMETERS})</span>
      </div>
      {a.parameters.length === 0 && <p class="project-settings-none">None</p>}
      {a.parameters.map((p) => (
        <div key={p.name} class="audio-card" role="group" aria-label={`Parameter ${p.name}`} data-parameter={p.name} data-kind={isLabelled(p) ? "labelled" : "numeric"}>
          <div class="audio-row">
            <TextField class="audio-grow" value={p.name} label={`Parameter ${p.name} name`} onCommit={(v) => set(`Rename parameter ${p.name} to ${v.trim()}`, renameParameter(draft, p.name, v))} />
            <label>
              Kind
              <Choice<"numeric" | "labelled"> label={`${p.name} kind`} value={isLabelled(p) ? "labelled" : "numeric"} options={["numeric", "labelled"]} onChange={(v) => set(`Make ${p.name} ${v}`, setParameterLabelled(draft, p.name, v === "labelled"))} />
            </label>
            <button class="icon audio-remove" aria-label={`Remove parameter ${p.name}`} title="Remove this parameter and the automation that uses it" onClick={() => set(`Remove parameter ${p.name}`, removeParameter(draft, p.name))}>
              ×
            </button>
          </div>
          {isLabelled(p) ? (
            <div class="audio-row">
              <label class="audio-grow" title="Comma-separated; the first is the default unless you pick another">
                Labels
                <TextField class="audio-grow" value={p.labels.join(", ")} label={`${p.name} labels`} onCommit={(v) => set(`Set ${p.name} labels`, setParameterLabels(draft, p.name, v.split(",")))} />
              </label>
              <label>
                Default
                <Choice<string> label={`${p.name} default`} value={p.default} options={p.labels} onChange={(v) => set(`Set ${p.name} default`, setParameterDefaultLabel(draft, p.name, v))} />
              </label>
            </div>
          ) : (
            <div class="audio-row">
              <label>
                Min
                <Num label={`${p.name} min`} value={p.min} step={0.1} onCommit={(n) => set(`Set ${p.name} min`, setParameterRange(draft, p.name, { min: n }))} />
              </label>
              <label>
                Max
                <Num label={`${p.name} max`} value={p.max} step={0.1} onCommit={(n) => set(`Set ${p.name} max`, setParameterRange(draft, p.name, { max: n }))} />
              </label>
              <label>
                Default
                <Num label={`${p.name} default`} value={p.default} step={0.1} onCommit={(n) => set(`Set ${p.name} default`, setParameterRange(draft, p.name, { default: n }))} />
              </label>
              <label title="Units per second the value moves toward its target; 0 jumps at once">
                Seek speed
                <Num label={`${p.name} seek speed`} value={p.seekSpeed} step={0.1} min={0} onCommit={(n) => set(`Set ${p.name} seek speed`, setParameterRange(draft, p.name, { seekSpeed: n }))} />
              </label>
            </div>
          )}
        </div>
      ))}
      <div class="audio-row">
        <button disabled={a.parameters.length >= MAX_PARAMETERS} onClick={() => set("Add parameter", addParameter(draft))}>
          + Parameter
        </button>
        <button disabled={a.parameters.length >= MAX_PARAMETERS} onClick={() => set("Add labelled parameter", addParameter(draft, true))}>
          + Labelled parameter
        </button>
      </div>
    </>
  );
}

const AUTOMATION_Y: Record<"volume" | "lowpass", [number, number]> = { volume: [0, 2], lowpass: [10, 24000] };

/** ADR 0158 §3: a bus's volume or low-pass driven by a global parameter through a curve (x is the parameter's range). */
function Automation(props: { a: AudioSettings; draft: SettingsDraft; set: Set }) {
  const { a, draft, set } = props;
  return (
    <>
      <div class="project-settings-list-head">
        <span>Automation</span>
        <span class="project-settings-hint">drive a bus's volume or low-pass from a parameter; multiplies with snapshots and ducking</span>
      </div>
      {a.automation.length === 0 && <p class="project-settings-none">{a.parameters.length === 0 ? "None (add a parameter first)" : "None"}</p>}
      {a.automation.map((r, i) => {
        const p = parameterOf(a, r.parameter);
        const [lo, hi] = p ? parameterRange(p) : [0, 1];
        return (
          <div key={i} class="audio-card" role="group" aria-label={`Automation ${i + 1}`} data-automation={i}>
            <div class="audio-row">
              <label>
                Bus
                <Choice<string> label={`Automation ${i + 1} bus`} value={r.bus} options={a.buses.map((b) => b.name)} onChange={(v) => set(`Set automation ${i + 1} bus`, setBusAutomationBus(draft, i, v))} />
              </label>
              <label>
                Target
                <Choice<"volume" | "lowpass"> label={`Automation ${i + 1} target`} value={r.target} options={["volume", "lowpass"]} labels={{ lowpass: "low-pass (Hz)" }} onChange={(v) => set(`Set automation ${i + 1} target`, setBusAutomationTarget(draft, i, v))} />
              </label>
              <label>
                Parameter
                <Choice<string> label={`Automation ${i + 1} parameter`} value={r.parameter} options={a.parameters.map((q) => q.name)} onChange={(v) => set(`Set automation ${i + 1} parameter`, setBusAutomationParameter(draft, i, v))} />
              </label>
              <button class="icon audio-remove" aria-label={`Remove automation ${i + 1}`} title="Remove this automation" onClick={() => set(`Remove automation ${i + 1}`, removeBusAutomation(draft, i))}>
                ×
              </button>
            </div>
            <div class="audio-curve">
              <CurveEditor
                curve={r.curve}
                xRange={hi > lo ? [lo, hi] : [lo, lo + 1]}
                yRange={AUTOMATION_Y[r.target]}
                interpolation
                label={`Automation ${i + 1} curve`}
                onChange={(c) => set(`Edit automation ${i + 1} curve`, setBusAutomationCurve(draft, i, c))}
              />
            </div>
          </div>
        );
      })}
      <button disabled={a.parameters.length === 0} onClick={() => set("Add automation", addBusAutomation(draft))}>
        + Automation
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
        <span>Music</span>
        <span class="project-settings-hint">the voices preset sets music rings (8 / 12 / 16); changing them here makes the preset custom</span>
      </div>
      <div class="audio-row">
        <label title={`Streams the core can play at once for streamed music stems (${MUSIC_RINGS_LIMITS[0]}..${MUSIC_RINGS_LIMITS[1]}); each costs about 300 KiB. 0 refuses streamed stems with a warning (decoded stems still play). Applies when the core next starts.`}>
          Music rings
          <Num label="Music rings" value={a.music.rings} step={1} min={MUSIC_RINGS_LIMITS[0]} max={MUSIC_RINGS_LIMITS[1]} onCommit={(n) => set("Set music rings", setMusicRings(draft, n))} />
        </label>
        <label class="audio-bus-check" title="Creates the audio context with the lowest latency the device allows and reads its latency back, for rhythm games. It costs battery and may crackle on slow devices. Applies at the next Play, which rebuilds the audio context.">
          <input type="checkbox" aria-label="Rhythm mode" checked={a.rhythmMode} onChange={(e) => set(`${a.rhythmMode ? "Disable" : "Enable"} rhythm mode`, setRhythmMode(draft, (e.currentTarget as HTMLInputElement).checked))} />
          Rhythm mode
        </label>
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

      <div class="audio-row">
        <label title="Doppler pitch shift treats a relative speed between a sound and the listener above this many world units per second as this speed. A sound opts in with its Doppler level (0 is off). Above 0">
          Doppler max speed
          <Num label="Doppler max speed" value={a.doppler.maxSpeed} step={10} min={1} onCommit={(n) => set("Set Doppler max speed", setDoppler(draft, { maxSpeed: n }))} />
        </label>
        <label title={`How fast sound travels in your world units per second (${SPEED_OF_SOUND_LIMITS[0]}..${SPEED_OF_SOUND_LIMITS[1]}); 343 if one unit is a metre. It sets how strong Doppler is`}>
          Speed of sound
          <Num label="Speed of sound" value={a.speedOfSound} step={1} min={SPEED_OF_SOUND_LIMITS[0]} max={SPEED_OF_SOUND_LIMITS[1]} onCommit={(n) => set("Set speed of sound", setDoppler(draft, { speedOfSound: n }))} />
        </label>
        {a.backend === "babylon" && <span class="audio-note">Babylon backend: Doppler changes the pitch of decoded clips only; streamed clips play flat.</span>}
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
  const plan = bedPlan(a);
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
        <BusRow key={bus.name} a={a} bus={bus} depth={depth} plan={plan} draft={draft} set={set} />
      ))}

      <Parameters a={a} draft={draft} set={set} />
      <Automation a={a} draft={draft} set={set} />

      <Snapshots a={a} draft={draft} set={set} />
      <Ducking a={a} draft={draft} set={set} />

      <Playback a={a} draft={draft} set={set} />

      <Beds a={a} plan={plan} draft={draft} set={set} />
      <Occlusion a={a} draft={draft} set={set} />
      <Zones a={a} draft={draft} set={set} />
    </div>
  );
}

const BED_HELP = "A bed is a shared surround field: distant or ambient sounds on a bus are mixed into one ambisonic bed and decoded to the speakers or headphones once, instead of each sound getting its own costly 3D voice. Only this many beds exist; a bus that asks for its own bed and loses to a higher priority shares the nearest bus above it that has one.";

/** A bus's bed mode and priority, which bed it mixes into, and why it lost (api-and-models section 7). */
function BusBedRow(props: { a: AudioSettings; bus: BusSettings; plan: BedPlan; draft: SettingsDraft; set: Set }) {
  const { a, bus, plan, draft, set } = props;
  const mode = busBed(a, bus.name);
  const host = plan.hostOf[bus.name];
  const lost = plan.lost.find((l) => l.bus === bus.name);
  const where = plan.maxBeds === 0 ? "beds are off" : host === null ? "no bed (mixed flat, equal power)" : host === bus.name ? "has its own bed" : `shares ${host}'s bed`;
  return (
    <div class="audio-row" data-bus-bed={bus.name}>
      <label title={`${BED_HELP} own: this bus gets its own bed (if it wins a slot). parent: its sounds go into the nearest bus above that has a bed. none: this bus is never in a bed.`}>
        Bed
        <Choice<BusBed> label={`${bus.name} bed`} value={mode} options={BUS_BEDS} onChange={(v) => set(`Set ${bus.name} bed ${v}`, setBusBed(draft, bus.name, v))} />
      </label>
      <label title="When more buses ask for their own bed than there are slots, the highest priority gets one (0..255; the root is 255, others 128; ties go to the bus nearest the root)">
        Bed priority
        <Num label={`${bus.name} bed priority`} value={busBedPriority(a, bus.name)} step={1} min={BED_PRIORITY_LIMITS[0]} max={BED_PRIORITY_LIMITS[1]} onCommit={(n) => set(`Set ${bus.name} bed priority`, setBusBedPriority(draft, bus.name, n))} />
      </label>
      <span class="project-settings-hint" data-bed-host>{where}</span>
      {lost && (
        <span class="audio-warning" role="alert" data-lost-bed={bus.name}>
          Asked for its own bed and lost it ({lost.outrankedBy.map((n) => `"${n}"`).join(", ")} outrank it for {plan.maxBeds} slot{plan.maxBeds === 1 ? "" : "s"}). Raise its priority or allow more beds.
        </span>
      )}
    </div>
  );
}

function BackendNote(props: { a: AudioSettings; what: string }) {
  return props.a.backend === "babylon" ? <p class="audio-note" role="note">The Babylon backend is selected: {props.what}</p> : null;
}

/** Beds and ambisonic clips (api-and-models section 2.1). */
function Beds(props: { a: AudioSettings; plan: BedPlan; draft: SettingsDraft; set: Set }) {
  const { a, plan, draft, set } = props;
  return (
    <>
      <div class="project-settings-list-head">
        <span>Beds</span>
        <span class="project-settings-hint">distant sounds mixed into one shared surround field, decoded once (core backend)</span>
      </div>
      <p class="project-settings-hint">{BED_HELP}</p>
      <BackendNote a={a} what="it has no beds, so sounds use its own panner and ambisonic clips play their first channel as mono." />
      <div class="audio-row">
        <label title={`How many beds can exist at once (${BED_LIMITS.maxBeds[0]}..${BED_LIMITS.maxBeds[1]}). 0 turns beds off: every sound is panned on its own`}>
          Max beds
          <Num label="Max beds" value={a.bed.maxBeds} step={1} min={BED_LIMITS.maxBeds[0]} max={BED_LIMITS.maxBeds[1]} onCommit={(n) => set("Set max beds", setBed(draft, n))} />
        </label>
        <label title={`How many ambisonic clips (recordings of a whole sound field: 4, 9 or 16 channels) can play at once (${AMBISONIC_LIMITS.maxClips[0]}..${AMBISONIC_LIMITS.maxClips[1]}). 0 refuses them with a warning`}>
          Max ambisonic clips
          <Num label="Max ambisonic clips" value={a.ambisonic.maxClips} step={1} min={AMBISONIC_LIMITS.maxClips[0]} max={AMBISONIC_LIMITS.maxClips[1]} onCommit={(n) => set("Set max ambisonic clips", setMaxClips(draft, n))} />
        </label>
        <span class="project-settings-hint">{plan.maxBeds === 0 ? "beds are off" : `hosts: ${plan.hosts.join(", ") || "none"}${plan.implicitRoot ? " (the root by default: no bus asked for its own)" : ""}`}</span>
      </div>
      {plan.lost.length > 0 && (
        <ul class="audio-problems audio-lost-beds" role="alert" aria-label="Lost beds">
          {plan.lost.map((l) => (
            <li key={l.bus}>
              Bus "{l.bus}" asked for its own bed and lost it to priority ({l.outrankedBy.map((n) => `"${n}"`).join(", ")} outrank it for {plan.maxBeds} slot{plan.maxBeds === 1 ? "" : "s"}); it {l.sharesWith ? `shares ${l.sharesWith}'s bed` : "is mixed flat (no bed above it)"}.
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const fmtMB = (n: number) => `${n.toFixed(1)} MB`;

/** Occlusion: which physics layers block sound, the ray budget, the default material and the material cards (sections 2.1, 2.2). */
function Occlusion(props: { a: AudioSettings; draft: SettingsDraft; set: Set }) {
  const { a, draft, set } = props;
  const o = a.occlusion;
  const layers = physicsLayerNames(draft);
  const off = o.layers !== null && o.layers.length === 0;
  const extra = (o.layers ?? []).filter((l) => !layers.includes(l));
  return (
    <>
      <div class="project-settings-list-head">
        <span>Occlusion</span>
        <span class="project-settings-hint">walls between a sound and the listener muffle it, found by casting rays through physics (core backend)</span>
      </div>
      <BackendNote a={a} what="walls only lower the volume (no muffling), and reverb zones do nothing." />
      <div class="audio-row" role="group" aria-label="Occluding layers">
        <span class="project-settings-hint" title="Physics layers whose colliders can block sound (sensors never do). All ticked is every layer; none ticked turns occlusion off">Layers</span>
        {layers.map((l) => (
          <label key={l} class="audio-bus-check">
            <input type="checkbox" aria-label={`Occlude by layer ${l}`} checked={o.layers === null || o.layers.includes(l)} onChange={(e) => set(`${(e.currentTarget as HTMLInputElement).checked ? "Add" : "Remove"} occluding layer ${l}`, toggleOcclusionLayer(draft, l, (e.currentTarget as HTMLInputElement).checked, layers))} />
            {l}
          </label>
        ))}
        {extra.map((l) => (
          <span key={l} class="audio-warning" role="alert">Layer "{l}" is not a physics layer</span>
        ))}
        {off && <span class="audio-note">Occlusion is off.</span>}
      </div>
      <div class="audio-row">
        <label title={`Ray time per frame in ms (${OCCLUSION_LIMITS.budgetMs[0]}..${OCCLUSION_LIMITS.budgetMs[1]}). More time checks more sounds each frame; fewer rays means a wall takes longer to be noticed`}>
          Budget (ms)
          <Num label="Occlusion budget (ms)" value={o.budgetMs} step={0.05} min={OCCLUSION_LIMITS.budgetMs[0]} max={OCCLUSION_LIMITS.budgetMs[1]} onCommit={(n) => set("Set occlusion budget", setOcclusion(draft, { budgetMs: n }))} />
        </label>
        <label title={`How quickly a sound closes and opens as a wall appears or goes (${OCCLUSION_LIMITS.smoothingMs[0]}..${OCCLUSION_LIMITS.smoothingMs[1]} ms); a material can set its own`}>
          Smoothing (ms)
          <Num label="Occlusion smoothing (ms)" value={o.smoothingMs} step={10} min={OCCLUSION_LIMITS.smoothingMs[0]} max={OCCLUSION_LIMITS.smoothingMs[1]} onCommit={(n) => set("Set occlusion smoothing", setOcclusion(draft, { smoothingMs: n }))} />
        </label>
        <label title="The material an occluder uses when it doesn't name one">
          Default material
          <Choice<string> label="Default material" value={o.defaultMaterial} options={o.materials.map((m) => m.name)} onChange={(v) => set("Set default material", setOcclusion(draft, { defaultMaterial: v }))} />
        </label>
      </div>
      <div class="project-settings-list-head">
        <span>Materials</span>
        <span class="project-settings-hint">what a wall does to sound passing through it; hits on one ray add their dB and take the lowest cutoff (up to {MAX_MATERIALS})</span>
      </div>
      {o.materials.map((m) => (
        <MaterialCard key={m.name} a={a} m={m} draft={draft} set={set} />
      ))}
      <button disabled={o.materials.length >= MAX_MATERIALS} onClick={() => set("Add material", addMaterial(draft))}>
        + Material
      </button>
    </>
  );
}

function MaterialCard(props: { a: AudioSettings; m: OccluderMaterial; draft: SettingsDraft; set: Set }) {
  const { a, m, draft, set } = props;
  const builtin = isBuiltinMaterial(m.name);
  const modified = materialIsModified(a, m.name);
  const patch = (label: string, p: MaterialPatch) => set(`Set ${m.name} ${label}`, setMaterial(draft, m.name, p));
  return (
    <div class="audio-card" role="group" aria-label={`Material ${m.name}`} data-material={m.name} data-kind={builtin ? "builtin" : "custom"}>
      <div class="audio-row">
        {builtin ? <strong class="audio-grow">{m.name}</strong> : <TextField class="audio-grow" value={m.name} label={`Material ${m.name} name`} onCommit={(v) => set(`Rename material ${m.name} to ${v.trim()}`, renameMaterial(draft, m.name, v))} />}
        {builtin && <span class="project-settings-hint">built-in{modified ? ", edited" : ""}</span>}
        {a.occlusion.defaultMaterial === m.name && <span class="audio-hint-accent">default</span>}
        {builtin ? (
          <button disabled={!modified} aria-label={`Reset material ${m.name}`} title="Put this material back to its built-in values" onClick={() => set(`Reset material ${m.name}`, resetMaterial(draft, m.name))}>
            Reset
          </button>
        ) : (
          <button class="icon audio-remove" aria-label={`Remove material ${m.name}`} title="Remove this material (occluders that name it use the default)" onClick={() => set(`Remove material ${m.name}`, removeMaterial(draft, m.name))}>
            ×
          </button>
        )}
      </div>
      <div class="audio-row">
        <label title={`How much quieter sound is after passing through, in dB (${MATERIAL_LIMITS.transmissionDb[0]}..${MATERIAL_LIMITS.transmissionDb[1]}); 0 is no change`}>
          Transmission (dB)
          <Num label={`${m.name} transmission dB`} value={m.transmissionDb} step={1} min={MATERIAL_LIMITS.transmissionDb[0]} max={MATERIAL_LIMITS.transmissionDb[1]} onCommit={(n) => patch("transmission", { transmissionDb: n })} />
        </label>
        <label title={`Muffling: sound through the wall is low-passed at this frequency (${MATERIAL_LIMITS.cutoffHz[0]}..${MATERIAL_LIMITS.cutoffHz[1]} Hz); 20000 and above is no muffling`}>
          Cutoff (Hz)
          <Num label={`${m.name} cutoff Hz`} value={m.cutoffHz} step={100} min={MATERIAL_LIMITS.cutoffHz[0]} max={MATERIAL_LIMITS.cutoffHz[1]} onCommit={(n) => patch("cutoff", { cutoffHz: n })} />
        </label>
        <label title="How much of the reverb a sound sends is removed behind the wall (0..1)">
          Wet occlusion
          <Num label={`${m.name} wet occlusion`} value={m.wetOcclusion} step={0.05} min={MATERIAL_LIMITS.wetOcclusion[0]} max={MATERIAL_LIMITS.wetOcclusion[1]} onCommit={(n) => patch("wet occlusion", { wetOcclusion: n })} />
        </label>
        <label title="Milliseconds to close when the wall appears (0..2000); blank uses the smoothing time">
          Attack (ms)
          <OptionalNum label={`${m.name} attack ms`} value={m.attackMs} step={10} min={0} max={MATERIAL_LIMITS.attackMs[1]} placeholder={String(a.occlusion.smoothingMs)} onCommit={(n) => patch("attack", { attackMs: n ?? null })} />
        </label>
        <label title="Milliseconds to open when the wall goes (0..2000); blank uses the smoothing time">
          Release (ms)
          <OptionalNum label={`${m.name} release ms`} value={m.releaseMs} step={10} min={0} max={MATERIAL_LIMITS.releaseMs[1]} placeholder={String(a.occlusion.smoothingMs)} onCommit={(n) => patch("release", { releaseMs: n ?? null })} />
        </label>
      </div>
    </div>
  );
}

/** Reverb zones: slots, tail slot and IR length, with the memory they cost and the layout warnings (section 2.1; C6). */
function Zones(props: { a: AudioSettings; draft: SettingsDraft; set: Set }) {
  const { a, draft, set } = props;
  const mem = zoneMemory(a);
  return (
    <>
      <div class="project-settings-list-head">
        <span>Reverb zones</span>
        <span class="project-settings-hint">volumes that give the room's reverb to sounds and the listener inside (core backend)</span>
      </div>
      <BackendNote a={a} what="reverb zones are ignored (one warning is logged)." />
      <div class="audio-row">
        <label title={`How many zones can be heard at once (${ZONE_LIMITS.maxActive[0]}..${ZONE_LIMITS.maxActive[1]}). 0 turns zones off`}>
          Active zones
          <Num label="Zones active" value={a.zones.maxActive} step={1} min={ZONE_LIMITS.maxActive[0]} max={ZONE_LIMITS.maxActive[1]} onCommit={(n) => set("Set active zones", setZones(draft, { maxActive: n }))} />
        </label>
        <label title="A spare slot where the zone you just left rings out its tail while the next one fades in (0 or 1)">
          Tail slot
          <Num label="Zones standby" value={a.zones.standby} step={1} min={ZONE_LIMITS.standby[0]} max={ZONE_LIMITS.standby[1]} onCommit={(n) => set("Set zone tail slot", setZones(draft, { standby: n }))} />
        </label>
        <label title={`The longest reverb tail kept, in seconds (${ZONE_LIMITS.maxIrSeconds[0]}..${ZONE_LIMITS.maxIrSeconds[1]}); longer impulse responses are cut with a 50 ms fade`}>
          Max IR length (s)
          <Num label="Zones max IR seconds" value={a.zones.maxIrSeconds} step={0.5} min={ZONE_LIMITS.maxIrSeconds[0]} max={ZONE_LIMITS.maxIrSeconds[1]} onCommit={(n) => set("Set zone IR length", setZones(draft, { maxIrSeconds: n }))} />
        </label>
      </div>
      <p class="project-settings-hint" data-zone-memory>
        {zoneSlots(a.zones) === 0 ? "No zone slots reserved." : `${mem.slots} slot${mem.slots === 1 ? "" : "s"}: about ${fmtMB(mem.totalMB)} at 48 kHz (${fmtMB(mem.stateMB)} state, ${fmtMB(mem.kernelMB)} kernels, outside the clip memory ceiling; double at 96 kHz).`}
      </p>
      {zoneWarnings(a).map((w) => (
        <p key={w.code} class="audio-warning" role="alert" data-zone-warning={w.code}>
          {w.code === "zonesOff"
            ? "Zones are off: every Audio Reverb Zone is ignored."
            : `No tail slot: a zone beyond ${w.maxActive} cuts off a ringing slot with a ${w.fadeMs} ms fade, and the new zone's reverb arrives 50 to 200 ms later.`}
        </p>
      ))}
    </>
  );
}
