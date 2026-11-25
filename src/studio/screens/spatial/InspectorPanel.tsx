// The Inspector (the prototype's inspector by selection, B.3): the selected object's fields, each change one labelled
// undo step on the scene. A 2D sound: sound, volume, output bus. An emitter: sound, volume, speed and place on its path
// for a moving one, X/Y/Z, how it is heard now (from the player's readout; a moving emitter's speed and distance live), its attenuation in a line and Edit
// attenuation…. A listener; an obstacle (material from `audio.json`, box); an audio zone (sound, heard from its edge or
// inside only, feather, its depth at the listener, box); a reverb zone (preset, priority, wet, level default, box). The
// Height block keeps a box's bottom at least 0.5 m below its top.
import { useRef, useState } from "preact/hooks";
import type { AudioTestScene, SceneBox } from "../../../engine/audio/spatial/testSceneTypes";
import type { TestSceneMotionRow, TestSceneVoiceRow } from "../../../plugins/audio/runtime/testScene/player";
import { ZONE_PRESETS } from "../../../plugins/audio/runtime/reverbPresets";
import { Icon } from "../../components/Icon";
import { SoundPicker } from "../../components/SoundPicker";
import type { SoundItem } from "../../components/soundPickerModel";
import { soundName } from "../../components/soundPickerModel";
import { TypeBadge } from "../../components/TypeBadge";
import { FieldRow, NumberBox, Section, SelectBox } from "../../../editor/ui/PanelFields";
import { ROLLOFF_PRESETS } from "./attenuationModel";
import type { AttenuationPreset } from "../../../engine/audio/attenuation/types";
import { depthIn } from "./geometry";
import { FIELDS, bottomValue, fieldValue, topValue, zoneState, type FieldId } from "./inspectorFields";
import { SegmentedControl } from "../../../editor/ui/SegmentedControl";
import { editLabel } from "./pointerModel";
import {
  activeListener, aKind, findObject, setBaseScene, moveObjectTo, patchAudioZone, patchEmitter, patchListener, patchObstacle, patchReverbZone, patchSound2d, positionOf, renameObject, setBox, setBoxHeights, setHeight, type EditResult, type SceneObject,
} from "./sceneEdits";
import { dopplerRatioText, liveDistanceText, livePlace, speedText } from "./liveMotion";
import { distanceText, occlusionText, RENDERED_LABEL } from "./voicesTable";

/** The Inspector header's badge for each kind. */
const KIND_TITLE: Readonly<Record<SceneObject["kind"], string>> = { listener: "Listener", emitter: "Emitter", obstacle: "Obstacle", reverbZone: "Reverb zone", audioZone: "Audio zone", sound2d: "2D sound" };

/** "smallStone" → "Small stone". */
export const presetLabel = (id: string): string => {
  const words = id.replace(/([A-Z])/g, " $1").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export interface AttenuationInfo {
  /** "Min 2.0 m · Max 40.0 m · ∿ Volume", or null when there's none to show. */
  readonly summary: string | null;
  /** Whose it is, in words. */
  readonly owner: string;
  /** Why Edit attenuation… can't open (its tooltip), or null when it opens the curves or offers Create preset / Inline. */
  readonly whyNotEdit: string | null;
  /** A rolloff preset can be applied (there's an attenuation to apply it to). */
  readonly rolloff: boolean;
  /** "Make it 3D" is offered: the emitter plays a playlist that plays flat (J9.2). */
  readonly makeSpatial?: boolean;
}

export interface InspectorProps {
  readonly scene: AudioTestScene;
  readonly selected: string | null;
  readonly readOnly: boolean;
  readonly voices: readonly TestSceneVoiceRow[];
  /** Where each emitter is now while playing (`liveMotion.ts`): a moving emitter's speed and distance follow it. */
  readonly motion?: readonly TestSceneMotionRow[];
  readonly playing: boolean;
  readonly buses: readonly string[];
  readonly materials: readonly string[];
  /** What a material does to sound through it ("−12 dB · low-pass 800 Hz"), or null when it isn't in audio.json. */
  blocks?(material: string): string | null;
  readonly attenuation: AttenuationInfo | null;
  readonly solo: string | null;
  silenced(id: string): boolean;
  sounds(): readonly SoundItem[];
  onEdit(label: string, edit: (s: AudioTestScene) => EditResult<AudioTestScene>, drag?: boolean): boolean;
  onEndDrag(): void;
  onSolo(id: string): void;
  onMute(id: string): void;
  onEditAttenuation(id: string): void;
  onRolloff(id: string, preset: AttenuationPreset): void;
  /** Give the flat playlist the emitter plays a spatial block (J9.2). */
  onMakeSpatial?(id: string): void;
  /** Whether the emitter's sound is traced for occlusion (false: its playlist turns occlusion off); default true. */
  occlusionOn?(id: string): boolean;
  onListenHere(id: string): void;
  onEditPath(id: string): void;
  onDelete(id: string): void;
  onOpenSound(path: string): void;
  /** The project's game scenes (`*.scene.json`), offered as the base level. */
  readonly gameScenes?: readonly string[];
  /** The base scene as imported: what it brought in, or why it's missing (the scene section's note). */
  readonly baseNote?: string | null;
}

export function InspectorPanel(props: InspectorProps) {
  const o = props.selected ? findObject(props.scene, props.selected) : null;
  if (!o) {
    return (
      <div class="sp-inspector">
        <SceneSettings {...props} />
        <p class="sp-note" title="Tools on the left of the scene place new objects.">Select something in the scene or outline to edit it here.</p>
      </div>
    );
  }
  return <ObjectInspector key={o.obj.id} {...props} o={o} />;
}

const NO_BASE = "";

/**
 * The scene itself, with nothing selected (ADR 0347): its base game scene, a level of the project played underneath, so
 * a sound designer tries sounds in an actual level: its audio sources, zones and colliders are drawn read-only and heard.
 */
function SceneSettings(props: InspectorProps) {
  const base = props.scene.base ?? null;
  const scenes = props.gameScenes ?? [];
  const options = [{ value: NO_BASE, label: "None" }, ...scenes.map((p) => ({ value: p, label: p }))];
  if (base !== null && !scenes.includes(base)) options.push({ value: base, label: `${base} (missing)` });
  return (
    <Section title="Scene" hint="Base game scene: a level from the project, drawn read-only under this scene. Its audio sources and zones play with yours and its colliders occlude, so you hear your sounds in the actual level.">
      <FieldRow label="Base game scene">
        <SelectBox
          label="Base game scene"
          title={scenes.length === 0 ? "The project has no game scenes (.scene.json) to play under this one" : "Play this scene over a level of the project"}
          value={base ?? NO_BASE}
          options={options}
          disabled={props.readOnly || (scenes.length === 0 && base === null)}
          onValue={(v) => props.onEdit(v === NO_BASE ? "Remove base game scene" : "Set base game scene", (s) => setBaseScene(s, v === NO_BASE ? null : v))}
        />
      </FieldRow>
      {props.baseNote && <p class="sp-note">{props.baseNote}</p>}
    </Section>
  );
}

function ObjectInspector(props: InspectorProps & { o: SceneObject }) {
  const { o, scene, readOnly: ro } = props;
  const id = o.obj.id;
  const label = editLabel(o.kind);
  /** A typed number through the field's check, then the edit. */
  const num = (field: FieldId, apply: (s: AudioTestScene, v: number) => EditResult<AudioTestScene>) => (raw: number) =>
    props.onEdit(label, (s) => {
      const v = fieldValue(field, raw);
      return "refused" in v ? v : apply(s, v.next);
    });
  const numberRow = (field: FieldId, value: number, apply: (s: AudioTestScene, v: number) => EditResult<AudioTestScene>, disabled = ro) => {
    const f = FIELDS[field];
    return (
      <FieldRow label={f.label} unit={f.unit}>
        <NumberBox label={f.label} value={value} min={f.min} max={f.max} step={f.step} digits={f.digits} disabled={disabled} onValue={num(field, apply)} />
      </FieldRow>
    );
  };
  const slider = (field: FieldId, value: number, apply: (s: AudioTestScene, v: number) => EditResult<AudioTestScene>) => {
    const f = FIELDS[field];
    const [lo, hi] = "slider" in f && f.slider ? f.slider : [f.min, f.max];
    return (
      <FieldRow label={f.label} unit={f.unit}>
        <input type="range" class="sp-range" aria-label={`${f.label} slider`} min={lo} max={hi} step={f.step} value={Math.min(hi, Math.max(lo, value))} disabled={ro}
          onInput={(e) => props.onEdit(label, (s) => apply(s, Number((e.currentTarget as HTMLInputElement).value)), true)}
          onChange={() => props.onEndDrag()} />
        <NumberBox label={f.label} value={value} min={f.min} max={f.max} step={f.step} digits={f.digits} disabled={ro} onValue={num(field, apply)} />
      </FieldRow>
    );
  };
  const listener = activeListener(scene);
  const row = props.voices.find((v) => v.id === id);
  const box = "box" in o.obj ? (o.obj as { box: SceneBox }).box : null;
  const sound = "sound" in o.obj ? (o.obj as { sound: string }).sound : null;
  const locked = o.obj.locked;
  const pos = positionOf(o);
  const live = props.playing ? livePlace(o, props.motion ?? []) : null;

  return (
    <div class="sp-inspector">
      <div class="sp-insp-head">
        <span class="sp-kind-badge">{o.kind === "emitter" && o.obj.kind === "moving" ? "Moving emitter" : KIND_TITLE[o.kind]}</span>
        <input class="sp-name" aria-label="Name" value={o.obj.name} disabled={ro}
          onChange={(e) => {
            const v = (e.currentTarget as HTMLInputElement).value;
            if (v.trim() && v.trim() !== o.obj.name) props.onEdit(`Rename ${o.obj.name}`, (s) => renameObject(s, id, v));
            else (e.currentTarget as HTMLInputElement).value = o.obj.name;
          }} />
        {locked && <span class="sp-tag" title="Locked: unlock it in the Outline to move it">Locked</span>}
      </div>

      {sound !== null && (
        <Section title="Plays">
          <SoundField value={sound} disabled={ro} sounds={props.sounds} onPick={(path) => props.onEdit(`${editLabel(o.kind)}`, (s) => patchSound(s, o, { sound: path }))} onOpen={props.onOpenSound} />
          {slider("volume", (o.obj as { volume: number }).volume, (s, v) => patchSound(s, o, { volume: v }))}
          {o.kind === "sound2d" && (
            <FieldRow label="Output" title="The Mixer bus it plays into, so ducking and snapshots apply (routing is edited in the Mixer)">
              <SelectBox label="Output bus" value={o.obj.output} disabled={ro}
                options={[...new Set([...props.buses, o.obj.output])].map((b) => ({ value: b, label: props.buses.includes(b) ? b : `${b} (missing)` }))}
                onValue={(b) => props.onEdit("Edit 2D sound", (s) => patchSound2d(s, id, { output: b }))} />
            </FieldRow>
          )}
          {o.kind === "emitter" && (
            <FieldRow label="Output" title="The Mixer bus it plays into, so ducking and snapshots apply (routing is edited in the Mixer)">
              <SelectBox label="Output bus" value={o.obj.output ?? ""} disabled={ro}
                options={[
                  { value: "", label: "Its sound's own" },
                  ...[...new Set([...props.buses, ...(o.obj.output ? [o.obj.output] : [])])].map((b) => ({ value: b, label: props.buses.includes(b) ? b : `${b} (missing)` })),
                ]}
                onValue={(b) => props.onEdit("Edit emitter", (s) => patchEmitter(s, id, { output: b }))} />
            </FieldRow>
          )}
          <div class="sp-row-actions">
            <button type="button" class={`sp-small${props.solo === id ? " on" : ""}`} aria-pressed={props.solo === id} onClick={() => props.onSolo(id)}><Icon name="play" size={12} /> {props.solo === id ? "Hear all" : "Play solo"}</button>
            <button type="button" class={`sp-small${props.silenced(id) && props.solo === null ? " on" : ""}`} onClick={() => props.onMute(id)}>{props.silenced(id) && props.solo === null ? "Unmute" : "Mute"}</button>
          </div>
        </Section>
      )}

      {o.kind === "emitter" && o.obj.kind === "moving" && (
        <Section title="Path">
          {slider("speed", o.obj.speed, (s, v) => patchEmitter(s, id, { speed: v }))}
          {numberRow("start", Math.round(o.obj.start * 100), (s, v) => patchEmitter(s, id, { start: v / 100 }), ro || locked)}
          <FieldRow label="Loop">
            <input type="checkbox" aria-label="Loop the path" checked={o.obj.loop} disabled={ro} onChange={(e) => props.onEdit("Edit emitter", (s) => patchEmitter(s, id, { loop: (e.currentTarget as HTMLInputElement).checked }))} />
          </FieldRow>
          <div class="sp-row-actions">
            <button type="button" class="sp-small" disabled={ro || locked} onClick={() => props.onEditPath(id)}>Edit path</button>
          </div>
        </Section>
      )}

      {(o.kind === "listener" || (o.kind === "emitter" && o.obj.kind === "static")) && pos && (
        <Section title="Place">
          {numberRow("x", pos.x, (s, v) => moveObjectTo(s, id, { x: v, z: pos.z }), ro || locked)}
          {numberRow("z", pos.z, (s, v) => moveObjectTo(s, id, { x: pos.x, z: v }), ro || locked)}
          {o.kind === "listener" && numberRow("listenerYaw", o.obj.yaw, (s, v) => patchListener(s, id, { yaw: v }), ro || locked)}
        </Section>
      )}

      {o.kind === "listener" && (
        <Section title="Listening" hint="Only one listener hears the scene at a time. During a take replay, the listening player follows the game's camera instead.">
          <div class="sp-state">{listener.id === id ? "Listening: the whole scene is heard from here." : "Not listening."}</div>
          <div class="sp-row-actions">
            <button type="button" class="sp-small" disabled={ro || listener.id === id} onClick={() => props.onListenHere(id)}>Listen here</button>
          </div>
        </Section>
      )}

      {(o.kind === "emitter" || o.kind === "audioZone") && (
        <Section title="Heard as">
          <dl class="sp-readout">
            <dt>Heard as</dt>
            <dd>{props.playing ? (props.silenced(id) ? "Muted" : row?.playing && row.rendered ? RENDERED_LABEL[row.rendered] : "Not playing") : "Play the scene to hear it"}</dd>
            <dt>Distance</dt>
            <dd>{live ? liveDistanceText(live.position, listener.position) : row ? distanceText(row) : pos ? `${Math.hypot(pos.x - listener.position.x, pos.y - listener.position.y, pos.z - listener.position.z).toFixed(1)} m` : "—"}</dd>
            <dt>Occlusion</dt>
            <dd>{row ? occlusionText(row, props.occlusionOn?.(id) ?? true) : "—"}</dd>
            {live && <dt>Speed</dt>}
            {live && <dd>{speedText(live.speed)}</dd>}
            {o.kind === "emitter" && <dt>Doppler</dt>}
            {o.kind === "emitter" && <dd title="The pitch ratio Doppler gives it now: above 1 approaching, below 1 going away">{dopplerRatioText(row)}</dd>}
          </dl>
        </Section>
      )}

      {o.kind === "emitter" && props.attenuation && (
        <Section title="Attenuation">
          {props.attenuation.summary && <p class="sp-summary">{props.attenuation.summary}</p>}
          <p class="sp-owner">{props.attenuation.owner}</p>
          <div class="sp-row-actions">
            {props.attenuation.makeSpatial && (
              <button type="button" class="sp-small" disabled={ro} title="Give the playlist a spatial block: heard in place, with distance, occlusion and Doppler" onClick={() => props.onMakeSpatial?.(id)}>Make it 3D</button>
            )}
            <button type="button" class="sp-small" disabled={props.attenuation.whyNotEdit !== null} title={props.attenuation.whyNotEdit ?? undefined} onClick={() => props.onEditAttenuation(id)}>Edit attenuation…</button>
            {props.attenuation.rolloff && (
              <select class="pl-select" aria-label="Rolloff preset" value="" disabled={ro} onChange={(e) => {
                const v = (e.currentTarget as HTMLSelectElement).value as AttenuationPreset;
                (e.currentTarget as HTMLSelectElement).value = "";
                if (v) props.onRolloff(id, v);
              }}>
                <option value="">Rolloff preset…</option>
                {ROLLOFF_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            )}
          </div>
        </Section>
      )}

      {o.kind === "obstacle" && (
        <Section title="Blocks" hint="Sound through it loses the material's level and highs (the materials are in Scene settings). Several obstacles on one ray add up.">
          <FieldRow label="Material">
            <SelectBox label="Material" value={o.obj.material} disabled={ro}
              options={[...new Set([...props.materials, o.obj.material])].map((m) => ({ value: m, label: props.materials.includes(m) ? m : `${m} (not in audio.json)` }))}
              onValue={(m) => props.onEdit("Edit obstacle", (s) => patchObstacle(s, id, { material: m }))} />
          </FieldRow>
          {(() => {
            const text = props.blocks?.(o.obj.material);
            return <div class="sp-state">{text ? <>Blocks <b>{text}</b></> : `${o.obj.material} isn't in audio.json: it blocks as the default material`}</div>;
          })()}
        </Section>
      )}

      {o.kind === "audioZone" && (
        <Section title="Zone">
          {/* A row like FieldRow's, but not a <label>: a label would name the first segment "Heard". */}
          <div class="kit-field" title={o.obj.heard === "edge" ? "Outside, it plays from the nearest point of the box, wider the closer you are; inside, it surrounds you." : "Inside, it plays around you; outside, it fades out over the feather."}>
            <span class="kit-field-label">Heard</span>
            <span class="kit-field-control">
              <SegmentedControl label="Heard" look="fill" size="small" value={o.obj.heard} options={[{ value: "edge", label: "From its edge", disabled: ro }, { value: "inside", label: "Inside only", disabled: ro }]}
                onChange={(h) => props.onEdit("Edit audio zone", (s) => patchAudioZone(s, id, { heard: h }))} />
            </span>
          </div>
          {slider("feather", o.obj.feather, (s, v) => patchAudioZone(s, id, { feather: v }))}
          <div class="sp-state">
            <div>{zoneState(o.obj, listener.position)}</div>
            <div title="The playlist's built-in zoneDepth parameter at the listener: 0 at the edge, 1 at the centre. Drag it onto any knob in the Mixer.">
              Zone depth (local parameter): <b class="sp-depth">{depthIn(o.obj.box, listener.position).toFixed(2)}</b>
            </div>
          </div>
        </Section>
      )}

      {o.kind === "reverbZone" && (
        <Section title="Reverb" hint="Where zones overlap, the higher priority wins; zones blend as the engine does. Send is how loud the zone's reverb is.">
          <FieldRow label="Preset">
            <SelectBox label="Reverb preset" value={o.obj.preset} disabled={ro}
              options={[...new Set<string>([...ZONE_PRESETS, o.obj.preset])].map((p) => ({ value: p, label: presetLabel(p) }))}
              onValue={(p) => props.onEdit("Edit reverb zone", (s) => patchReverbZone(s, id, { preset: p }))} />
          </FieldRow>
          {numberRow("priority", o.obj.priority, (s, v) => patchReverbZone(s, id, { priority: v }))}
          {slider("wet", o.obj.wet, (s, v) => patchReverbZone(s, id, { wet: v }))}
          <FieldRow label="Level default" title="The reverb wherever no other zone holds the listener">
            <input type="checkbox" aria-label="The level's default reverb" checked={o.obj.levelDefault} disabled={ro} onChange={(e) => props.onEdit("Edit reverb zone", (s) => patchReverbZone(s, id, { levelDefault: (e.currentTarget as HTMLInputElement).checked }))} />
          </FieldRow>
        </Section>
      )}

      {box && (
        <Section title="Box">
          {numberRow("x", box.center.x, (s, v) => setBox(s, id, { ...box, center: { ...box.center, x: v } }), ro || locked)}
          {numberRow("z", box.center.z, (s, v) => setBox(s, id, { ...box, center: { ...box.center, z: v } }), ro || locked)}
          {numberRow("width", box.width, (s, v) => setBox(s, id, { ...box, width: v }), ro || locked)}
          {numberRow("depth", box.depth, (s, v) => setBox(s, id, { ...box, depth: v }), ro || locked)}
          {numberRow("yaw", box.yaw, (s, v) => setBox(s, id, { ...box, yaw: v }), ro || locked)}
        </Section>
      )}

      {o.kind !== "sound2d" && (
        <Section title="Height" hint={!box && o.kind === "emitter" && o.obj.kind === "moving" ? "The path height: the emitter travels at this height above its route." : undefined}>
          {box ? (
            <>
              <FieldRow label="Bottom" unit="m">
                <NumberBox label="Bottom" value={box.bottom} step={0.5} digits={1} disabled={ro || locked}
                  onValue={(raw) => props.onEdit(label, (s) => { const v = bottomValue(raw, box.top); return "refused" in v ? v : setBoxHeights(s, id, v.next, box.top); })} />
              </FieldRow>
              <FieldRow label="Top" unit="m">
                <NumberBox label="Top" value={box.top} step={0.5} digits={1} disabled={ro || locked}
                  onValue={(raw) => props.onEdit(label, (s) => { const v = topValue(raw, box.bottom); return "refused" in v ? v : setBoxHeights(s, id, box.bottom, v.next); })} />
              </FieldRow>
            </>
          ) : (
            pos && numberRow("height", pos.y, (s, v) => setHeight(s, id, v), ro || locked)
          )}
        </Section>
      )}

      <div class="sp-row-actions end">
        <button type="button" class="sp-small danger" disabled={ro || (o.kind === "listener" && scene.listeners.length <= 1)} title={o.kind === "listener" && scene.listeners.length <= 1 ? "A scene needs a listener" : undefined} onClick={() => props.onDelete(id)}>
          <Icon name="trash" size={14} /> Delete {aKind(o.kind).replace(/^an? /, "")}
        </button>
      </div>
    </div>
  );
}

function patchSound(s: AudioTestScene, o: SceneObject, patch: { sound?: string; volume?: number }): EditResult<AudioTestScene> {
  if (o.kind === "emitter") return patchEmitter(s, o.obj.id, patch);
  if (o.kind === "audioZone") return patchAudioZone(s, o.obj.id, patch);
  if (o.kind === "sound2d") return patchSound2d(s, o.obj.id, patch);
  return { refused: "it plays no sound" };
}

/** The sound chip: badge and name; a click opens the sound picker; › opens it in Playlists. */
function SoundField(props: { value: string; disabled: boolean; sounds(): readonly SoundItem[]; onPick(path: string): void; onOpen(path: string): void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const item = props.value ? props.sounds().find((s) => s.path === props.value) : undefined;
  const name = props.value ? soundName(item ?? { path: props.value, kind: "sample", badge: "SMP" }) : "Pick a sound…";
  return (
    <FieldRow label="Sound">
      <span class="sp-sound-row">
        <button ref={ref} type="button" class="sp-sound" disabled={props.disabled} aria-haspopup="dialog" aria-label={`Sound: ${name}`} title={props.value || "Pick a playlist or a sample for this test scene"} onClick={() => setOpen(true)}>
          {item ? <TypeBadge code={item.badge} /> : <TypeBadge placeholder />}
          <span class="sp-sound-name">{name}</span>
          {props.value && !item && <span class="sp-warn" title="Not in the project">missing</span>}
          <Icon name="chevronDown" size={12} class="sp-sound-chev" />
        </button>
        {props.value.toLowerCase().endsWith(".playlist.json") && (
          <button type="button" class="sp-icon" aria-label="Open in Playlists" title="Open in Playlists" onClick={() => props.onOpen(props.value)}><Icon name="chevronRight" size={14} /></button>
        )}
        {props.value && !props.disabled && (
          <button type="button" class="sp-icon" aria-label="Clear the sound" title="Play nothing" onClick={() => props.onPick("")}><Icon name="close" size={14} /></button>
        )}
      </span>
      {open && ref.current && <SoundPicker at={ref.current} list={props.sounds} title="Pick a sound" onPick={props.onPick} onClose={() => setOpen(false)} />}
    </FieldRow>
  );
}
