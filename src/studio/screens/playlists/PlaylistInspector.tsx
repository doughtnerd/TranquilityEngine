// The Inspector panel's view (the prototype's right panel; spec 4.2.7): the header (badge, name, type summary), the
// "this voice" cards (what resolves the voice at this level, live at the test values), Parameters (the screen gives
// them), the playlist's effects (the catalogue's chain, ADR 0345, each with its Automate button; a Clip's chain offers
// no Delay or Reverb; "Move to playlist" when every clip has the same effect), Playback (collapsed to its summary; open:
// Output with the Mixer link, Plays, Max instances, When full, Cooldown, Chance, Delay, Priority), the selected entry
// (its gain, pitch, curves, weight or position, what it is, a clip's own effects), Spatial (3D on turns occlusion on,
// ADR 0162), Caption, local parameters, Used by and Linked copies. A view over props: edits are labelled body edits.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ParameterDef } from "../../../engine/audio/parameters";
import { isLabelled } from "../../../engine/audio/parameters";
import type { Effect } from "../../../engine/audio/effects/types";
import type { Entry, PlaylistBody, PlaybackRules } from "../../../engine/audio/playlist/types";
import { FieldRow, NumberBox, SelectBox, Section } from "../../../editor/ui/PanelFields";
import { SegmentedControl } from "../../../editor/ui/SegmentedControl";
import { Checkbox } from "../../components/Checkbox";
import { EffectChain } from "../../components/EffectChain";
import { Icon } from "../../components/Icon";
import { SliderField } from "../../components/SliderField";
import { TypeBadge } from "../../components/TypeBadge";
import { chainNote } from "./chainCost";
import { setCaption } from "./captionEdit";
import { automatedNow } from "./effectAutomation";
import type { BodyEdit } from "./EntryList";
import { dbText, entryMeta, voiceSummary } from "./entryRowModel";
import { AT_ZERO_GLYPHS, CurveGlyph, IconSegments } from "./glyphs";
import { hoistEffect, hoistText, sharedClipEffects } from "./hoistModel";
import { typeSummary, type VoiceCard } from "./liveModel";
import { axisRange } from "./blendPlacement";
import { editAt, entryName, playlistTitle, sampleTitle } from "./playlistPaths";
import { setEffects, setEntryUse, setLevels, setOutput, setParameters, setPlayback, setSpatial, USE_LIMITS, type EditContext } from "./playlistEdits";

export interface PlaylistInspectorProps {
  readonly body: PlaylistBody;
  /** The open playlist's name. */
  readonly name?: string;
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
  /** Files that link this playlist (its linked copies). */
  readonly linkedIn?: readonly string[];
  /** The "this voice" cards. */
  readonly cards?: readonly VoiceCard[];
  /** The Parameters section's content. */
  readonly parameters?: ComponentChildren;
  /** Test values (an automated effect's value now). */
  readonly values?: Readonly<Record<string, number>>;
  bodyOf?(e: Entry): PlaylistBody | null;
  lengthOf?(sample: string): number | null;
  onEdit(label: string, edit: BodyEdit, drag?: boolean): void;
  onEditCurves(index: number): void;
  onOpenBus(bus: string): void;
  onOpenPlaylist(path: string): void;
  onOpenEntry?(index: number): void;
  /** An effect's Automate button, and its curve menu (null for the open playlist's own chain, the entry index for a clip's). */
  onAutomate?(effectId: string, entry: number | null): void;
  onAutomateMenu?(effectId: string, entry: number | null, at: { x: number; y: number }): void;
  /** Unlink this playlist in `file` (each copy there becomes its own playlist). */
  onUnlinkIn?(file: string): void;
  /** Playback is open (controlled when given), and its toggle. */
  readonly playbackOpen?: boolean;
  onPlaybackOpen?(open: boolean): void;
  /** ADR 0357 §6: the captions table's keys (absent: no Caption field), and creating a key there. */
  readonly captionKeys?: readonly string[];
  readonly captionTable?: string;
  onCreateCaptionKey?(key: string): void;
}

/** ADR 0357 §4, §6: the Caption field: a key picked from the captions table (or created there) and the repeat gap. */
function CaptionSection(props: { body: PlaylistBody; keys: readonly string[]; table: string; writable: boolean; onEdit: PlaylistInspectorProps["onEdit"]; onCreate?(key: string): void }) {
  const c = props.body.caption;
  const [key, setKey] = useState(c?.key ?? "");
  useEffect(() => setKey(c?.key ?? ""), [c?.key]);
  const commit = () => key.trim() !== (c?.key ?? "") && props.onEdit(key.trim() ? "Caption" : "No caption", (b) => setCaption(b, key));
  const missing = c && !props.keys.includes(c.key);
  return (
    <Section title="Caption" open={!!c} hint="Shown by subtitle displays when the player turns captions on (important sounds only).">
      <FieldRow label="Key">
        <input type="text" class="kit-num" aria-label="Caption key" list="pl-caption-keys" placeholder="cc.door_slams" value={key} disabled={!props.writable}
          onInput={(e) => setKey((e.currentTarget as HTMLInputElement).value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
        <datalist id="pl-caption-keys">{props.keys.map((k) => <option key={k} value={k} />)}</datalist>
      </FieldRow>
      {c && (
        <FieldRow label="Not again within" unit="s">
          <NumberBox label="Caption gap" value={c.minGap} min={0} max={60} step={0.5} digits={1} disabled={!props.writable} onValue={(v) => props.onEdit("Caption gap", (b) => setCaption(b, c.key, v))} />
        </FieldRow>
      )}
      {missing && (
        <p class="pl-note">
          {c.key} isn't in {props.table}.{" "}
          {props.onCreate && <button type="button" class="pl-link" disabled={!props.writable} onClick={() => props.onCreate!(c.key)}>Create it</button>}
        </p>
      )}
    </Section>
  );
}

const WHEN_FULL: { value: PlaybackRules["whenFull"]; label: string }[] = [
  { value: "stealOldest", label: "Steal oldest" },
  { value: "stealQuietest", label: "Steal quietest" },
  { value: "stealFarthest", label: "Steal farthest" },
  { value: "refuse", label: "Don't play" },
];

/** Playback's one-line summary ("Every trigger plays", "→ Music · Max 4 · steal oldest · cooldown 0.2 s"). */
function playbackSummary(p: PlaybackRules, ownBus: string | null): string {
  const parts: string[] = [];
  if (ownBus) parts.push(`→ ${ownBus}`);
  if (p.maxInstances > 0) parts.push(`Max ${p.maxInstances} · ${WHEN_FULL.find((w) => w.value === p.whenFull)!.label.toLowerCase()}`);
  if (p.cooldown > 0) parts.push(`cooldown ${p.cooldown} s`);
  if (p.chance < 1) parts.push(`${Math.round(p.chance * 100)}% chance`);
  if (p.delay > 0) parts.push(`delay ${Math.round(p.delay * 1000)} ms`);
  if (p.plays === "untilStopped") parts.push("until stopped");
  return parts.length ? parts.join(" · ") : "Every trigger plays";
}

/** A clip's effect chain excludes these (decisions.md: Delay and Reverb aren't offered on clips; existing data still plays). */
const NOT_ON_CLIPS = ["delay", "reverb"];

const AT_ZERO = [
  { value: "stop" as const, label: "Stop", title: "Stop: stops, and restarts from the top when its weight returns", glyph: AT_ZERO_GLYPHS.stop },
  { value: "continue" as const, label: "Continue", title: "Continue: keeps its time silently", glyph: AT_ZERO_GLYPHS.continue },
];

export function PlaylistInspector(props: PlaylistInspectorProps) {
  const { body, writable, onEdit } = props;
  const p = body.playback;
  const e = props.selected !== null ? body.entries[props.selected] : undefined;
  const i = props.selected ?? -1;
  const ranges = body.blend?.axes.map((a) => axisRange(a, props.ctx.parameters)) ?? [];
  const pb = (label: string, patch: Partial<PlaybackRules>, drag = false) => onEdit(label, (b) => setPlayback(b, patch), drag);
  const spatial = body.spatial;
  const presetValue = typeof spatial?.attenuation === "string" ? spatial.attenuation : spatial?.attenuation ? "__inline" : "";
  const isClip = body.type === "clip";
  const shared = sharedClipEffects(body);
  const values = props.values ?? {};
  const inner = e ? (e.kind === "embedded" ? e.embedded : e.kind === "linked" ? (props.bodyOf?.(e) ?? null) : null) : null;
  const entryClip = e?.kind === "embedded" && e.embedded.type === "clip" ? e.embedded : null;
  const chain = (effects: readonly Effect[], level: "playlist" | "clip", edit: (next: Effect[]) => BodyEdit, entry: number | null, automation: PlaylistBody["automation"]) => (
    <EffectChain effects={effects} level="instance" readOnly={!writable} title={level === "clip" ? "Clip effects" : "Playlist effects"}
      note={chainNote(level === "clip" ? "clipPlaylist" : "playlist", effects)} exclude={level === "clip" ? NOT_ON_CLIPS : undefined}
      automated={automatedNow(effects, automation, values, props.ctx.parameters)}
      onAutomate={props.onAutomate ? (id) => props.onAutomate!(id, entry) : undefined}
      onAutomateMenu={props.onAutomateMenu ? (id, at) => props.onAutomateMenu!(id, entry, at) : undefined}
      onEdit={(r, label, drag) => onEdit(label, (b) => ("refused" in r ? r : edit(r.next)(b)), drag)} />
  );

  return (
    <div class="pl-inspector">
      <div class="pl-ph">
        <TypeBadge playlist={body.type} axes={body.blend?.axes.length === 2 ? 2 : 1} />
        <b class="pl-nm">{props.name ?? ""}</b>
        <span class="pl-u pl-nm">{typeSummary(body)}</span>
      </div>
      {props.cards && props.cards.length > 0 && (
        <div class="pl-axrs">
          {props.cards.map((c, k) => (
            <div key={k} class="pl-axr">
              <span class={`pl-ax ${c.badge === "D" ? "d" : c.badge === "S" ? "s" : "t"}`} title={c.badge === "D" ? "A discrete pick" : c.badge === "S" ? "A scalar input" : "Voice time"}>{c.badge}</span>
              <div class="pl-axb">
                <div class="pl-axl"><span class="pl-faint">{c.label}</span> <b>{c.value}</b></div>
                {c.sub && <div class="pl-faint">{c.sub}</div>}
                {c.rows && c.rows.map((r) => (
                  <div key={r.name} class={`pl-wr${r.weight > 1e-3 ? " hot" : ""}`}>
                    <span class="pl-nm">{r.name}</span>
                    <span class="pl-wb"><em style={{ width: `${Math.round(r.weight * 100)}%` }} /></span>
                    <b>{Math.round(r.weight * 100)}%</b>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {props.parameters && <Section title="Parameters" hint="Test values of the game parameters this playlist uses: everything re-resolves live. They're never saved.">{props.parameters}</Section>}
      <div class="pl-isec">
        {shared.map((f) => (
          <div key={f.id} class="pl-fxmv">
            <span>{hoistText(f)}</span>
            <button type="button" class="pl-small" disabled={!writable} onClick={() => onEdit("Move to playlist", (b) => hoistEffect(b, f))}>Move to playlist</button>
          </div>
        ))}
        {chain(body.effects, isClip ? "clip" : "playlist", (next) => (b) => setEffects(b, next), null, body.automation)}
      </div>
      <details class="pl-pb" open={props.playbackOpen} onToggle={(ev) => props.onPlaybackOpen?.((ev.currentTarget as HTMLDetailsElement).open)}>
        <summary class="pl-pbh">
          <Icon name="chevronRight" size={11} />
          <span class="pl-cap">Playback</span>
          <span class="pl-flex" />
          <span class="pl-u pl-nm" title="When a trigger plays and what happens when too many play">{playbackSummary(p, body.output)}</span>
        </summary>
        <div class="pl-pbf">
          <span class="pl-k">Output</span>
          <span class="pl-inline">
            <SelectBox label="Output bus" value={body.output ?? ""} disabled={!writable}
              title={body.output ? `Overridden: plays into ${body.output}. An output of its own takes its audio out of its parent's mix: the parent's playlist effects don't apply to it.` : `Inherits ${props.output.bus}${props.output.from ? ` from ${props.output.from}` : ""}`}
              options={[{ value: "", label: `Inherit · ${props.output.own ? "Master" : props.output.bus}` }, ...props.buses.map((b) => ({ value: b, label: b }))]}
              onValue={(v) => onEdit(`Output: ${v || "inherit"}`, (b) => setOutput(b, v || null, props.buses))} />
            <button type="button" class="pl-ib" aria-label={`Open ${props.output.bus} in the Mixer`} title="Open the bus in the Mixer" onClick={() => props.onOpenBus(props.output.bus)}><Icon name="chevronRight" size={12} /></button>
          </span>
          <span class="pl-k">Plays</span>
          <SegmentedControl<PlaybackRules["plays"]> size="small" label="Plays" value={p.plays} onChange={(v) => writable && pb("Change setting", { plays: v })}
            options={[{ value: "oneShot", label: "One-shot" }, { value: "untilStopped", label: "Until stopped", title: "Keeps playing until the game stops or releases it" }]} />
        </div>
        <div class="pl-pbs">
          <SliderField label="Max instances" value={p.maxInstances} min={0} max={32} step={1} title="0: no limit" disabled={!writable} onValue={(v, drag) => pb("Max instances", { maxInstances: Math.round(v) }, drag)} />
          <FieldRow label="When full"><SelectBox label="When full" value={p.whenFull} options={WHEN_FULL} disabled={!writable || p.maxInstances === 0} title={p.maxInstances === 0 ? "No limit: set Max instances first" : undefined} onValue={(v) => pb("When full", { whenFull: v })} /></FieldRow>
          <SliderField label="Cooldown" value={p.cooldown} min={0} max={5} step={0.05} unit="s" disabled={!writable} onValue={(v, drag) => pb("Cooldown", { cooldown: v }, drag)} />
          <SliderField label="Chance" value={Math.round(p.chance * 100)} min={0} max={100} step={1} unit="%" disabled={!writable} onValue={(v, drag) => pb("Chance", { chance: v / 100 }, drag)} />
          <SliderField label="Delay" value={Math.round(p.delay * 1000)} min={0} max={2000} step={10} unit="ms" disabled={!writable} onValue={(v, drag) => pb("Delay", { delay: v / 1000 }, drag)} />
          <FieldRow label="Priority" title="0..255; higher keeps its voice when the engine runs out"><NumberBox label="Priority" value={p.priority} min={0} max={255} step={1} digits={0} disabled={!writable} onValue={(v) => pb("Change setting", { priority: v })} /></FieldRow>
        </div>
      </details>
      {isClip && (
        <Section title="Clip level" hint="The clip's own gain and pitch, on top of its sample's prepared level">
          <FieldRow label="Gain" unit="dB"><NumberBox label="Clip gain" value={body.volume} min={-96} max={24} step={0.5} digits={1} disabled={!writable} onValue={(v) => onEdit("Gain", (b) => setLevels(b, { volume: v }))} /></FieldRow>
          <FieldRow label="Pitch" unit="st"><NumberBox label="Clip pitch" value={body.pitch} min={-48} max={48} step={1} digits={2} disabled={!writable} onValue={(v) => onEdit("Pitch", (b) => setLevels(b, { pitch: v }))} /></FieldRow>
        </Section>
      )}
      {e && !isClip && (
        <div class="pl-entry-sec" aria-label={`Entry ${entryName(e, i)}`} role="group">
          <div class="pl-ph">
            {inner ? <TypeBadge playlist={inner.type} axes={inner.blend?.axes.length === 2 ? 2 : 1} /> : <TypeBadge sample />}
            <b class="pl-nm pl-caps">{entryName(e, i)}</b>
            <span class="pl-flex" />
            {e.kind !== "sample" && props.onOpenEntry && <button type="button" class="pl-small" onClick={() => props.onOpenEntry!(i)}>Open <Icon name="chevronRight" size={11} /></button>}
          </div>
          <div class="pl-kv2s">
            <FieldRow label="Gain" unit="dB" title="Relative to the level prepared in Samples (0 dB = unchanged); gains add up along the playlists that contain this one"><NumberBox label="Entry gain" value={e.volume} min={USE_LIMITS.volume[0]} max={USE_LIMITS.volume[1]} step={0.5} digits={1} disabled={!writable} onValue={(v) => onEdit("Gain", (b) => setEntryUse(b, i, { volume: v }))} /></FieldRow>
            <FieldRow label="Pitch" unit="st"><NumberBox label="Entry pitch" value={e.pitch} min={USE_LIMITS.pitch[0]} max={USE_LIMITS.pitch[1]} step={1} digits={2} disabled={!writable} onValue={(v) => onEdit("Pitch", (b) => setEntryUse(b, i, { pitch: v }))} /></FieldRow>
            <div class="kit-field">
              <span class="kit-field-label">Over time</span>
              <span class="kit-field-control">
                <span>{curvesText(e)}</span>
                <button type="button" class="pl-ib" aria-label={`Edit ${entryName(e, i)} voice curves`} title={voiceSummary(e).title} disabled={!writable} onClick={() => props.onEditCurves(i)}><CurveGlyph /></button>
              </span>
            </div>
            {body.type === "queue" && body.queue?.pick === "random" && (
              <FieldRow label="Weight" title="0 never plays"><NumberBox label="Entry weight" value={e.weight} min={0} max={100} step={1} digits={0} disabled={!writable} onValue={(v) => onEdit("Weight", (b) => setEntryUse(b, i, { weight: v }))} /></FieldRow>
            )}
            {body.type === "blend" && ranges[0] && (
              <>
                <FieldRow label={ranges.length === 2 ? "X" : "Position"}><NumberBox label="Entry x" value={e.x ?? ranges[0][0]} min={ranges[0][0]} max={ranges[0][1]} step={(ranges[0][1] - ranges[0][0]) / 100} digits={3} disabled={!writable} onValue={(v) => onEdit(`Move ${entryName(e, i)}`, (b) => setEntryUse(b, i, { x: v }))} /></FieldRow>
                {ranges.length === 2 && <FieldRow label="Y"><NumberBox label="Entry y" value={e.y ?? ranges[1]![0]} min={ranges[1]![0]} max={ranges[1]![1]} step={(ranges[1]![1] - ranges[1]![0]) / 100} digits={3} disabled={!writable} onValue={(v) => onEdit(`Move ${entryName(e, i)}`, (b) => setEntryUse(b, i, { y: v }))} /></FieldRow>}
                <div class="kit-field">
                  <span class="kit-field-label">At weight 0</span>
                  <span class="kit-field-control">
                    <IconSegments label="At weight 0" value={e.atZeroWeight} options={AT_ZERO} disabled={!writable} onChange={(v) => onEdit(`At weight 0: ${v === "stop" ? "Stop" : "Continue"}`, (b) => setEntryUse(b, i, { atZeroWeight: v }))} />
                  </span>
                </div>
              </>
            )}
            <div class="kit-field">
              <span class="kit-field-label">{e.kind === "sample" ? "Sample" : "Playlist"}</span>
              <span class="kit-field-control pl-faint">{e.kind === "sample" ? `${sampleTitle(e.sample)} · ${entryMeta(e, null, props.lengthOf ?? (() => null)) || "length unknown"}` : `${entryMeta(e, inner, props.lengthOf ?? (() => null))}${e.kind === "linked" ? ` · linked: ${playlistTitle(e.playlist)}` : ""}`}</span>
            </div>
          </div>
          {entryClip && (
            <div class="pl-isec">
              {chain(entryClip.effects, "clip", (next) => (b) => editAt(b, [i], (x) => setEffects(x, next)), i, entryClip.automation)}
            </div>
          )}
          {Object.keys(e.curves).length > 0 && (
            <ul class="pl-curves" aria-label="Voice curves">
              {Object.entries(e.curves).map(([k, c]) => c && (
                <li key={k} class={c.bypass ? "off" : undefined}>
                  <svg viewBox="0 0 40 14" aria-hidden="true"><polyline points={miniCurve(c.curve)} /></svg>
                  <span>{k}</span>
                  <span class="pl-faint">over {typeof c.input === "string" ? "voice time" : c.input.parameter}{c.bypass ? " · off" : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <Section title="Spatial" open={!!spatial}>
        <FieldRow label="3D" title="Off: plays flat (2D). On: positioned in the world, occlusion on (ADR 0162)">
          <Checkbox ariaLabel="Spatial (3D)" checked={!!spatial} disabled={!writable} onChange={(on) => onEdit(on ? "3D on" : "3D off", (b) => setSpatial(b, on ? {} : null))} />
        </FieldRow>
        {spatial && (
          <>
            <FieldRow label="Attenuation">
              <SelectBox label="Attenuation" value={presetValue} disabled={!writable}
                options={[{ value: "", label: "Engine default" }, { value: "__inline", label: "Inline distances" }, ...props.presets.map((x) => ({ value: x, label: x.slice(x.lastIndexOf("/") + 1).replace(/\.attenuation\.json$/i, "") }))]}
                onValue={(v) => onEdit("Change setting", (b) => setSpatial(b, { attenuation: v === "" ? null : v === "__inline" ? { minDistance: 1, maxDistance: 50, curves: {} } : v }))} />
            </FieldRow>
            {spatial.attenuation && typeof spatial.attenuation === "object" && (
              <>
                <FieldRow label="Min distance" unit="m"><NumberBox label="Min distance" value={spatial.attenuation.minDistance} min={0} max={spatial.attenuation.maxDistance} step={0.5} digits={2} disabled={!writable} onValue={(v) => onEdit("Change setting", (b) => setSpatial(b, { attenuation: { ...(b.spatial!.attenuation as object), minDistance: v } as never }))} /></FieldRow>
                <FieldRow label="Max distance" unit="m"><NumberBox label="Max distance" value={spatial.attenuation.maxDistance} min={spatial.attenuation.minDistance} max={100000} step={1} digits={1} disabled={!writable} onValue={(v) => onEdit("Change setting", (b) => setSpatial(b, { attenuation: { ...(b.spatial!.attenuation as object), maxDistance: v } as never }))} /></FieldRow>
              </>
            )}
            <FieldRow label="Occlusion" title="Walls between the source and the listener muffle it (ADR 0162, 0347)"><Checkbox ariaLabel="Occlusion" checked={spatial.occlusion} disabled={!writable} onChange={(on) => onEdit("Change setting", (b) => setSpatial(b, { occlusion: on }))} /></FieldRow>
            <FieldRow label="Doppler" title="0: none; 1: physical"><NumberBox label="Doppler" value={spatial.doppler} min={0} max={5} step={0.1} digits={1} disabled={!writable} onValue={(v) => onEdit("Change setting", (b) => setSpatial(b, { doppler: v }))} /></FieldRow>
          </>
        )}
      </Section>
      {props.captionKeys && (
        <CaptionSection body={body} keys={props.captionKeys} table={props.captionTable ?? "the captions table"} writable={writable} onEdit={onEdit} onCreate={props.onCreateCaptionKey} />
      )}
      <Section title="Local parameters" open={body.parameters.length > 0} hint="Parameters of this playlist's instances (the game sets them per sound); global ones live in audio.json.">
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
      {props.linkedIn && props.linkedIn.length > 0 && (
        <Section title="Linked copies" hint="Other playlists link this one: an edit here changes every one of them. Unlink there to give that playlist its own copy.">
          <ul class="pl-used">
            {props.linkedIn.map((f) => (
              <li key={f} class="pl-linked-row">
                <button type="button" class="pl-link" onClick={() => props.onOpenPlaylist(f)}>{playlistTitle(f)}</button>
                {props.onUnlinkIn && <button type="button" class="pl-small" disabled={!writable} title={`Turn the link in ${playlistTitle(f)} into a copy of its own there`} onClick={() => props.onUnlinkIn!(f)}>Unlink there</button>}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

/** An entry's curves in words ("None", "Gain, Pitch", with "off" for bypassed ones). */
function curvesText(e: Entry): string {
  const list = Object.entries(e.curves).filter(([, c]) => c);
  if (list.length === 0) return `None${e.volume ? ` · ${dbText(e.volume)}` : ""}`;
  return list.map(([k, c]) => `${k.charAt(0).toUpperCase()}${k.slice(1)}${c!.bypass ? " (off)" : ""}`).join(", ");
}

/** A curve as a 40 × 14 polyline. */
function miniCurve(curve: readonly (readonly [number, number, ...unknown[]])[]): string {
  if (curve.length === 0) return "0,7 40,7";
  const xs = curve.map((k) => k[0]), ys = curve.map((k) => k[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return curve.map((k) => `${(((k[0] - x0) / (x1 - x0 || 1)) * 40).toFixed(1)},${(13 - ((k[1] - y0) / (y1 - y0 || 1)) * 12).toFixed(1)}`).join(" ");
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
              <NumberBox class="pl-n56" label={`${p.name} min`} value={p.min} digits={3} disabled={!writable} onValue={(v) => set(k, { ...p, min: Math.min(v, p.max), default: Math.max(Math.min(v, p.max), p.default) })} />
              <span class="pl-faint">to</span>
              <NumberBox class="pl-n56" label={`${p.name} max`} value={p.max} digits={3} disabled={!writable} onValue={(v) => set(k, { ...p, max: Math.max(v, p.min), default: Math.min(Math.max(v, p.min), p.default) })} />
              <span class="pl-faint">default</span>
              <NumberBox class="pl-n56" label={`${p.name} default`} value={p.default} min={p.min} max={p.max} digits={3} disabled={!writable} onValue={(v) => set(k, { ...p, default: v })} />
            </span>
          )}
          <button type="button" class="pl-ib" aria-label={`Remove ${p.name}`} title="Remove parameter" disabled={!writable} onClick={() => props.onChange(list.filter((_, i) => i !== k), "Change setting")}><Icon name="trash" size={12} /></button>
        </div>
      ))}
      <button type="button" class="pl-small" disabled={!writable} onClick={() => props.onChange([...list, { name: freeName(), min: 0, max: 1, default: 0, seekSpeed: 0 }], "Change setting")}><Icon name="plus" size={12} /> Parameter</button>
    </div>
  );
}
