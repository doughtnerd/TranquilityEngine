// The Inspector panel's view (the prototype's right panel): the selected entry's use settings (volume, pitch, weight,
// position, at weight 0, "Edit voice curves…"), then the open playlist's Playback rules, Output (its own bus or the one
// it inherits, › to open it in the Mixer), Effects (the catalogue's chain, ADR 0331), Spatial (an attenuation preset or
// inline distances; curves are M7's), local parameters, and Used by. A view over props: edits are labelled body edits.
import type { ParameterDef } from "../../../engine/audio/parameters";
import { isLabelled } from "../../../engine/audio/parameters";
import type { PlaylistBody, PlaybackRules } from "../../../engine/audio/playlist/types";
import { SegmentedControl } from "../../../editor/ui/SegmentedControl";
import { EffectChain } from "../../components/EffectChain";
import { chainNote } from "./chainCost";
import type { BodyEdit } from "./EntryList";
import { FieldRow, NumberBox, SelectBox, Section } from "./fields";
import { setEffects, setEntryUse, setOutput, setParameters, setPlayback, setSpatial, USE_LIMITS, type EditContext } from "./playlistEdits";
import { axisRange } from "./blendPlacement";
import { entryName, playlistTitle } from "./playlistPaths";

export interface PlaylistInspectorProps {
  readonly body: PlaylistBody;
  readonly selected: number | null;
  readonly writable: boolean;
  readonly ctx: EditContext;
  readonly buses: readonly string[];
  /** The bus it plays on and whether it is its own (else inherited from `from`). */
  readonly output: { readonly bus: string; readonly own: boolean; readonly from: string | null };
  /** Attenuation preset files. */
  readonly presets: readonly string[];
  /** Playlists that use this one (files linking it, or the parent of an embedded one). */
  readonly usedBy: readonly string[];
  onEdit(label: string, edit: BodyEdit, drag?: boolean): void;
  onEditCurves(index: number): void;
  onOpenBus(bus: string): void;
  onOpenPlaylist(path: string): void;
}

const WHEN_FULL: { value: PlaybackRules["whenFull"]; label: string }[] = [
  { value: "stealOldest", label: "Steal oldest" },
  { value: "stealQuietest", label: "Steal quietest" },
  { value: "stealFarthest", label: "Steal farthest" },
  { value: "refuse", label: "Don't play" },
];

export function PlaylistInspector(props: PlaylistInspectorProps) {
  const { body, writable, onEdit } = props;
  const p = body.playback;
  const e = props.selected !== null ? body.entries[props.selected] : undefined;
  const i = props.selected ?? -1;
  const ranges = body.blend?.axes.map((a) => axisRange(a, props.ctx.parameters)) ?? [];
  const pb = (label: string, patch: Partial<PlaybackRules>) => onEdit(label, (b) => setPlayback(b, patch));
  const spatial = body.spatial;
  const presetValue = typeof spatial?.attenuation === "string" ? spatial.attenuation : spatial?.attenuation ? "__inline" : "";

  return (
    <div class="pl-inspector">
      {e && (
        <Section title={`Entry · ${entryName(e, i)}`} note={e.kind === "linked" ? `Linked: ${e.playlist}. These settings belong to this use only.` : "These settings belong to this use of the entry."}>
          <FieldRow label="Volume" unit="dB"><NumberBox label="Entry volume" value={e.volume} min={USE_LIMITS.volume[0]} max={USE_LIMITS.volume[1]} step={0.5} digits={1} disabled={!writable} onValue={(v) => onEdit("Change setting", (b) => setEntryUse(b, i, { volume: v }))} /></FieldRow>
          <FieldRow label="Pitch" unit="st"><NumberBox label="Entry pitch" value={e.pitch} min={USE_LIMITS.pitch[0]} max={USE_LIMITS.pitch[1]} step={1} digits={2} disabled={!writable} onValue={(v) => onEdit("Change setting", (b) => setEntryUse(b, i, { pitch: v }))} /></FieldRow>
          {body.type === "queue" && body.queue?.pick === "random" && (
            <FieldRow label="Weight" title="0 never plays"><NumberBox label="Entry weight" value={e.weight} min={0} max={100} step={1} digits={0} disabled={!writable} onValue={(v) => onEdit("Weight", (b) => setEntryUse(b, i, { weight: v }))} /></FieldRow>
          )}
          {body.type === "blend" && (
            <>
              <FieldRow label={ranges.length === 2 ? "X" : "Position"}><NumberBox label="Entry x" value={e.x ?? ranges[0]![0]} min={ranges[0]![0]} max={ranges[0]![1]} step={(ranges[0]![1] - ranges[0]![0]) / 100} digits={3} disabled={!writable} onValue={(v) => onEdit(`Move ${entryName(e, i)}`, (b) => setEntryUse(b, i, { x: v }))} /></FieldRow>
              {ranges.length === 2 && <FieldRow label="Y"><NumberBox label="Entry y" value={e.y ?? ranges[1]![0]} min={ranges[1]![0]} max={ranges[1]![1]} step={(ranges[1]![1] - ranges[1]![0]) / 100} digits={3} disabled={!writable} onValue={(v) => onEdit(`Move ${entryName(e, i)}`, (b) => setEntryUse(b, i, { y: v }))} /></FieldRow>}
              <div class="pl-kv">
                <span class="pl-field-label">At weight 0</span>
                <SegmentedControl<"stop" | "continue"> size="small" label="At weight 0" value={e.atZeroWeight} onChange={(v) => writable && onEdit(`At weight 0: ${v === "stop" ? "Stop" : "Continue"}`, (b) => setEntryUse(b, i, { atZeroWeight: v }))}
                  options={[{ value: "stop", label: "Stop", title: "Stops, and restarts from the top when its weight returns" }, { value: "continue", label: "Continue", title: "Keeps its time silently" }]} />
              </div>
            </>
          )}
          <button type="button" class="pl-small" disabled={!writable} onClick={() => props.onEditCurves(i)}>
            Edit voice curves…{Object.keys(e.curves).length ? ` (${Object.keys(e.curves).length})` : ""}
          </button>
        </Section>
      )}
      <Section title="Playback" note="When a trigger plays and what happens when too many play.">
        <div class="pl-kv">
          <span class="pl-field-label">Plays</span>
          <SegmentedControl<PlaybackRules["plays"]> size="small" label="Plays" value={p.plays} onChange={(v) => writable && pb("Change setting", { plays: v })}
            options={[{ value: "oneShot", label: "One-shot" }, { value: "untilStopped", label: "Until stopped", title: "Keeps playing until the game stops or releases it" }]} />
        </div>
        <FieldRow label="Max instances" title="0: no limit"><NumberBox label="Max instances" value={p.maxInstances} min={0} max={32} step={1} digits={0} disabled={!writable} onValue={(v) => pb("Max instances", { maxInstances: v })} /></FieldRow>
        <FieldRow label="When full"><SelectBox label="When full" value={p.whenFull} options={WHEN_FULL} disabled={!writable || p.maxInstances === 0} onValue={(v) => pb("When full", { whenFull: v })} /></FieldRow>
        <FieldRow label="Cooldown" unit="s"><NumberBox label="Cooldown" value={p.cooldown} min={0} max={5} step={0.05} digits={2} disabled={!writable} onValue={(v) => pb("Cooldown", { cooldown: v })} /></FieldRow>
        <FieldRow label="Chance" unit="%"><NumberBox label="Chance" value={Math.round(p.chance * 100)} min={0} max={100} step={1} digits={0} disabled={!writable} onValue={(v) => pb("Chance", { chance: v / 100 })} /></FieldRow>
        <FieldRow label="Delay" unit="ms"><NumberBox label="Delay" value={Math.round(p.delay * 1000)} min={0} max={2000} step={10} digits={0} disabled={!writable} onValue={(v) => pb("Delay", { delay: v / 1000 })} /></FieldRow>
        <FieldRow label="Priority" title="0..255; higher keeps its voice when the engine runs out"><NumberBox label="Priority" value={p.priority} min={0} max={255} step={1} digits={0} disabled={!writable} onValue={(v) => pb("Change setting", { priority: v })} /></FieldRow>
      </Section>
      <Section title="Output" note="An output of its own takes its audio out of its parent's mix: the parent's playlist effects don't apply to it; its own effects and the bus's still do.">
        <div class="pl-kv">
          <span class="pl-field-label">Bus</span>
          <span class="pl-inline">
            <SelectBox label="Output bus" value={body.output ?? ""} disabled={!writable}
              options={[{ value: "", label: `Inherit (${props.output.own ? "Master" : props.output.bus}${props.output.from ? ` from ${props.output.from}` : ""})` }, ...props.buses.map((b) => ({ value: b, label: b }))]}
              onValue={(v) => onEdit(`Output: ${v || "inherit"}`, (b) => setOutput(b, v || null, props.buses))} />
            <button type="button" class="pl-icon" aria-label={`Open ${props.output.bus} in the Mixer`} title="Open the bus in the Mixer" onClick={() => props.onOpenBus(props.output.bus)}>›</button>
          </span>
        </div>
      </Section>
      <Section title={body.type === "clip" ? "Clip effects" : "Playlist effects"}>
        <EffectChain effects={body.effects} level="instance" readOnly={!writable}
          note={chainNote("playlist", body.effects)}
          onEdit={(r, label, drag) => onEdit(label, (b) => ("refused" in r ? r : setEffects(b, r.next)), drag)} />
      </Section>
      <Section title="Spatial" open={!!spatial}>
        <FieldRow label="3D" title="Off: plays flat (2D)">
          <input type="checkbox" aria-label="Spatial (3D)" checked={!!spatial} disabled={!writable} onChange={(ev) => onEdit("Change setting", (b) => setSpatial(b, (ev.currentTarget as HTMLInputElement).checked ? {} : null))} />
        </FieldRow>
        {spatial && (
          <>
            <FieldRow label="Attenuation">
              <SelectBox label="Attenuation" value={presetValue} disabled={!writable}
                options={[{ value: "", label: "Engine default" }, { value: "__inline", label: "Inline distances" }, ...props.presets.map((p) => ({ value: p, label: p.slice(p.lastIndexOf("/") + 1).replace(/\.attenuation\.json$/i, "") }))]}
                onValue={(v) => onEdit("Change setting", (b) => setSpatial(b, { attenuation: v === "" ? null : v === "__inline" ? { minDistance: 1, maxDistance: 50, curves: {} } : v }))} />
            </FieldRow>
            {spatial.attenuation && typeof spatial.attenuation === "object" && (
              <>
                <FieldRow label="Min distance" unit="m"><NumberBox label="Min distance" value={spatial.attenuation.minDistance} min={0} max={spatial.attenuation.maxDistance} step={0.5} digits={2} disabled={!writable} onValue={(v) => onEdit("Change setting", (b) => setSpatial(b, { attenuation: { ...(b.spatial!.attenuation as object), minDistance: v } as never }))} /></FieldRow>
                <FieldRow label="Max distance" unit="m"><NumberBox label="Max distance" value={spatial.attenuation.maxDistance} min={spatial.attenuation.minDistance} max={100000} step={1} digits={1} disabled={!writable} onValue={(v) => onEdit("Change setting", (b) => setSpatial(b, { attenuation: { ...(b.spatial!.attenuation as object), maxDistance: v } as never }))} /></FieldRow>
              </>
            )}
            <button type="button" class="pl-small" disabled title="Attenuation curves are edited on the Spatial screen (M7)">Edit curves…</button>
            <FieldRow label="Occlusion"><input type="checkbox" aria-label="Occlusion" checked={spatial.occlusion} disabled={!writable} onChange={(ev) => onEdit("Change setting", (b) => setSpatial(b, { occlusion: (ev.currentTarget as HTMLInputElement).checked }))} /></FieldRow>
            <FieldRow label="Doppler" title="0: none; 1: physical"><NumberBox label="Doppler" value={spatial.doppler} min={0} max={5} step={0.1} digits={1} disabled={!writable} onValue={(v) => onEdit("Change setting", (b) => setSpatial(b, { doppler: v }))} /></FieldRow>
          </>
        )}
      </Section>
      <Section title="Local parameters" note="Parameters of this playlist's instances (the game sets them per sound); global ones live in audio.json.">
        <LocalParameters list={body.parameters} writable={writable} onChange={(next, label) => onEdit(label, (b) => setParameters(b, next))} />
      </Section>
      <Section title="Used by">
        {props.usedBy.length === 0 ? (
          <p class="pl-note">No playlist uses it; the game plays it by its path.</p>
        ) : (
          <ul class="pl-used">
            {props.usedBy.map((u) => (
              <li key={u}><button type="button" class="pl-link" onClick={() => props.onOpenPlaylist(u)}>{playlistTitle(u)}</button></li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/** A compact list of local parameters: name, kind, range or labels, default; add and remove. */
export function LocalParameters(props: { readonly list: readonly ParameterDef[]; readonly writable: boolean; onChange(next: ParameterDef[], label: string): void }) {
  const { list, writable } = props;
  const set = (k: number, p: ParameterDef) => props.onChange(list.map((x, i) => (i === k ? p : x)), "Change setting");
  const freeName = () => {
    for (let n = 1; ; n++) if (!list.some((p) => p.name === `param${n}`)) return `param${n}`;
  };
  return (
    <div class="pl-params">
      {list.map((p, k) => (
        <div key={k} class="pl-param">
          <input class="pl-text" aria-label="Parameter name" value={p.name} disabled={!writable} onChange={(e) => set(k, { ...p, name: (e.currentTarget as HTMLInputElement).value.trim() })} />
          <SelectBox label={`${p.name} kind`} value={isLabelled(p) ? "labels" : "number"} disabled={!writable}
            options={[{ value: "number", label: "Number" }, { value: "labels", label: "Labels" }]}
            onValue={(v) => set(k, v === "labels" ? { name: p.name, labels: ["a", "b"], default: "a" } : { name: p.name, min: 0, max: 1, default: 0, seekSpeed: 0 })} />
          {isLabelled(p) ? (
            <input class="pl-text" aria-label={`${p.name} labels`} title="Labels, comma-separated; the first is the default" value={p.labels.join(", ")} disabled={!writable}
              onChange={(e) => {
                const labels = (e.currentTarget as HTMLInputElement).value.split(",").map((s) => s.trim()).filter(Boolean);
                if (labels.length) set(k, { ...p, labels, default: labels.includes(p.default) ? p.default : labels[0]! });
              }} />
          ) : (
            <span class="pl-inline">
              <NumberBox label={`${p.name} min`} value={p.min} digits={3} disabled={!writable} onValue={(v) => set(k, { ...p, min: Math.min(v, p.max), default: Math.max(Math.min(v, p.max), p.default) })} />
              <span class="pl-faint">to</span>
              <NumberBox label={`${p.name} max`} value={p.max} digits={3} disabled={!writable} onValue={(v) => set(k, { ...p, max: Math.max(v, p.min), default: Math.min(Math.max(v, p.min), p.default) })} />
              <span class="pl-faint">default</span>
              <NumberBox label={`${p.name} default`} value={p.default} min={p.min} max={p.max} digits={3} disabled={!writable} onValue={(v) => set(k, { ...p, default: v })} />
            </span>
          )}
          <button type="button" class="pl-icon" aria-label={`Remove ${p.name}`} disabled={!writable} onClick={() => props.onChange(list.filter((_, i) => i !== k), "Change setting")}>×</button>
        </div>
      ))}
      <button type="button" class="pl-small" disabled={!writable} onClick={() => props.onChange([...list, { name: freeName(), min: 0, max: 1, default: 0, seekSpeed: 0 }], "Change setting")}>+ Parameter</button>
    </div>
  );
}
