// The Event editor's field descriptors (ADR 0158 §1, §7): for the selected node (and for the event itself), the
// ordered list of fields the properties panel renders, each with its kind, label, limits, default and help. The
// limits match `parseAudioEvent`'s, so whatever the panel writes reads back unchanged. Pure: no Preact, no editor state.
// `readField` / `writeField` / `coerceField` read and write a descriptor's value on a node or the event, immutably.
import { REVERB_SEND_KEY, sustainReleaseFade, type AudioEventAsset, type EventNode, type SustainNode } from "../../../../engine/audio/eventFormat";
import { IF_TOO_LATE, type StingerAt, type StingerDef } from "../../../../engine/audio/musicRules";
import { MAX_GRID_OFFSET, MAX_PLAYLIST_ROUNDS, MUSIC_LIMITS, PLAYLIST_MODES, type MusicNode } from "../../../../engine/audio/musicFormat";
import type { Curve } from "../../../../engine/core/curve";

/**
 * What a field edits, which decides its widget:
 * - `number`: a number input (`min`/`max`/`step`, `integer` rounds).
 * - `range`: a `[low, high]` pair of numbers; `optional` ones may be absent (the key removed).
 * - `select`: one of `options`.
 * - `text`: a string; `optional` ones may be absent (an empty input removes the key).
 * - `asset`: an asset path of `assetKind` (the audio clip picker, which also accepts a drop from the asset browser).
 * - `boolean`: a checkbox.
 * - `parameter`: a parameter name (the event's local parameters and the project's global ones); `labelled` lists only
 *   labelled parameters.
 * - `bus`: a bus name from the project's audio settings (`""` is Master).
 * - `curves`: an automation list (`Automation[]`), edited with the shared curve widget.
 * - `curve`: one curve (`Curve`) edited with the shared curve widget (ADR 0162 `reverbSendCurve`).
 * - `aux`: the event's one aux send (ADR 0162 §2.5), a `{ bus, level }` over the `sends` object's non-`reverb` keys.
 * - `group`: an object whose own `fields` are named relative to it; an `optional` group may be absent (a checkbox
 *   adds it with `default` or removes the key); an `implicit` one has no checkbox and exists only while it has a key.
 */
export type FieldKind = "number" | "range" | "select" | "text" | "asset" | "boolean" | "parameter" | "bus" | "curves" | "curve" | "aux" | "group";

interface FieldBase {
  /** The key on the node or event (or, inside a group, on the group's object). */
  name: string;
  /** The row's label, sentence case ("Volume random"). */
  label: string;
  /** One sentence for the row's tooltip, with the unit ("dB added per play, uniform in the range."). */
  help: string;
}

export interface NumberField extends FieldBase {
  kind: "number";
  min: number;
  max: number;
  step: number;
  /** Round to whole numbers (priority, avoidRepeat, maxInstances). */
  integer?: boolean;
  /**
   * The key may be absent (the ADR 0162 §2.5 keys): writing `undefined`, the `default` or an "off" value removes it, so
   * a file only holds what was set. The widget shows `default` (or `offLabel`, when set) while absent.
   */
  optional?: boolean;
  /** A value at or above this is "off": it removes the key (a low-pass at 20 kHz or more). */
  offAtOrAbove?: number;
  /** A value at or below this is "off": it removes the key (a high-pass at 20 Hz or less). */
  offAtOrBelow?: number;
  /** What the empty input says while the key is absent ("off"); the widget is then a bare number input with no slider. */
  offLabel?: string;
  default: number;
}

export interface RangeField extends FieldBase {
  kind: "range";
  min: number;
  max: number;
  step: number;
  /** May be absent (`range` on a blend child, `loopRegion` on a clip). */
  optional?: boolean;
  /** The value when absent and not optional, or the value the panel fills in when an optional range is turned on. */
  default: [number, number];
}

export interface SelectField extends FieldBase {
  kind: "select";
  options: readonly string[];
  /** The key may be absent (a segment's `entry` and `exit`): the widget adds an `emptyLabel` choice that removes it. */
  optional?: boolean;
  /** The choice that leaves an optional select unset ("(default)"). */
  emptyLabel?: string;
  default: string;
}

export interface TextField extends FieldBase {
  kind: "text";
  /** May be absent (a switch child's `value`, a switch's `default`). */
  optional?: boolean;
  default: string;
}

export interface AssetField extends FieldBase {
  kind: "asset";
  /** The asset kind the picker lists. */
  assetKind: "audio";
  default: string;
}

export interface BooleanField extends FieldBase {
  kind: "boolean";
  /** The key may be absent: writing `undefined` or the `default` removes it (`spatial.occlusion`). */
  optional?: boolean;
  default: boolean;
}

export interface ParameterField extends FieldBase {
  kind: "parameter";
  /** Only labelled parameters make sense here (a switch's). */
  labelled?: boolean;
  default: string;
}

export interface BusField extends FieldBase {
  kind: "bus";
  default: string;
}

export interface CurvesField extends FieldBase {
  kind: "curves";
}

/** One curve (`reverbSendCurve`): absent, or equal to `default`, means the engine's default curve. */
export interface CurveField extends FieldBase {
  kind: "curve";
  /** The x values the graph spans. */
  xRange: [number, number];
  /** Bounds for key values. */
  yRange: [number, number];
  /** Written back as absent when the curve equals this. */
  default: Curve;
}

/** The value of an `aux` field: the bus an event sends to and the send level. */
export interface AuxSend { bus: string; level: number }

/** The event's single aux send, kept in the `sends` object beside `reverb`. */
export interface AuxField extends FieldBase {
  kind: "aux";
  /** The level a freshly picked bus starts at. */
  default: number;
  min: number;
  max: number;
  step: number;
}

export interface GroupField extends FieldBase {
  kind: "group";
  /** May be absent (`spatial`: absent plays flat). */
  optional?: boolean;
  /** No on/off checkbox: the object is absent while empty and appears with its first key (`filter`, `sends`). */
  implicit?: boolean;
  /** The object written when an optional group is turned on (a fresh copy each time). */
  default: Record<string, unknown>;
  fields: FieldDescriptor[];
}

export type FieldDescriptor =
  | NumberField | RangeField | SelectField | TextField | AssetField | BooleanField | ParameterField | BusField | CurvesField | CurveField | AuxField | GroupField;

// --- descriptor factories: a fresh object per call, with parseAudioEvent's limits and defaults ----------------------

const volumeField = (): NumberField => ({ kind: "number", name: "volume", label: "Volume", help: "Linear gain multiplier (1 is unchanged).", min: 0, max: 4, step: 0.01, default: 1 });
const pitchField = (): NumberField => ({ kind: "number", name: "pitch", label: "Pitch", help: "Pitch ratio (2 is an octave up).", min: 0.0625, max: 16, step: 0.01, default: 1 });
const volumeRandomField = (): RangeField => ({ kind: "range", name: "volumeRandom", label: "Volume random", help: "dB added per play, uniform in the range.", min: -96, max: 24, step: 0.5, default: [0, 0] });
const pitchRandomField = (): RangeField => ({ kind: "range", name: "pitchRandom", label: "Pitch random", help: "Semitones added per play, uniform in the range.", min: -48, max: 48, step: 0.1, default: [0, 0] });
const delayField = (): NumberField => ({ kind: "number", name: "delay", label: "Delay", help: "Seconds before the node starts.", min: 0, max: 60, step: 0.01, default: 0 });
const automationField = (): CurvesField => ({ kind: "curves", name: "automation", label: "Automation", help: "Curves that drive volume, pitch or lowpass from parameters." });
const commonFields = (): FieldDescriptor[] => [volumeField(), pitchField(), volumeRandomField(), pitchRandomField(), delayField()];

const clipAssetField = (): AssetField => ({ kind: "asset", name: "clip", label: "Clip", help: "The audio clip this node plays.", assetKind: "audio", default: "" });
const loopField = (help: string): BooleanField => ({ kind: "boolean", name: "loop", label: "Loop", help, default: false });
const startOffsetField = (): NumberField => ({ kind: "number", name: "startOffset", label: "Start offset", help: "Seconds into the clip to start at.", min: 0, max: 1e6, step: 0.01, default: 0 });
const loopRegionField = (): RangeField => ({ kind: "range", name: "loopRegion", label: "Loop region", help: "Seconds: loop only this part of the clip; absent loops the clip's own points.", min: 0, max: 1e6, step: 0.01, optional: true, default: [0, 1] });
const sustainFlagField = (): BooleanField => ({ kind: "boolean", name: "sustain", label: "Sustain", help: "Loop the region until release, then play the rest of the clip.", default: false });

const avoidRepeatField = (children: number): NumberField => ({ kind: "number", name: "avoidRepeat", label: "Avoid repeat", help: "Skip the last n picks (at most children minus 1).", min: 0, max: Math.max(0, children - 1), step: 1, integer: true, default: 0 });
const modeField = (): SelectField => ({ kind: "select", name: "mode", label: "Mode", help: "Step plays one child per play; continuous keeps picking back to back until stopped.", options: ["step", "continuous"], default: "step" });
const gapField = (): NumberField => ({ kind: "number", name: "gap", label: "Gap", help: "Seconds between one child's end and the next's start; negative overlaps.", min: -10, max: 60, step: 0.01, default: 0 });
const resetField = (): NumberField => ({ kind: "number", name: "reset", label: "Reset", help: "Seconds idle before a step sequence starts over; 0 never.", min: 0, max: 1e6, step: 0.01, default: 0 });

const switchParameterField = (): ParameterField => ({ kind: "parameter", name: "parameter", label: "Parameter", help: "The labelled parameter that picks the child.", labelled: true, default: "" });
const switchDefaultField = (): TextField => ({ kind: "text", name: "default", label: "Default", help: "The label to play when no child matches; empty plays the first child.", optional: true, default: "" });
const onChangeField = (): SelectField => ({ kind: "select", name: "onChange", label: "On change", help: "What a change while playing does: keep, restart or crossfade.", options: ["keep", "restart", "crossfade"], default: "keep" });
const switchCrossfadeField = (): NumberField => ({ kind: "number", name: "crossfade", label: "Crossfade", help: "Seconds to crossfade to the new child.", min: 0, max: 10, step: 0.01, default: 0.1 });

const blendParameterField = (): ParameterField => ({ kind: "parameter", name: "parameter", label: "Parameter", help: "The parameter whose value the children's ranges are on.", default: "" });

const releaseField = (): SelectField => ({ kind: "select", name: "release", label: "Release", help: "On release: now crossfades into end, loopEnd finishes the current loop pass first.", options: ["now", "loopEnd"], default: "loopEnd" });
/** The release crossfade; its default is the node's current release crossfade, so showing the row changes nothing. */
const releaseFadeField = (node: SustainNode): NumberField => ({ kind: "number", name: "releaseFade", label: "Release crossfade", help: "seconds of crossfade from the loop into the end on release", min: 0, max: 1e6, step: 0.01, default: sustainReleaseFade(node) });

const weightField = (): NumberField => ({ kind: "number", name: "weight", label: "Weight", help: "Relative chance of this child being picked.", min: 0, max: 1e6, step: 0.1, default: 1 });
const valueField = (): TextField => ({ kind: "text", name: "value", label: "Value", help: "The label this child plays for.", optional: true, default: "" });
const rangeField = (): RangeField => ({ kind: "range", name: "range", label: "Range", help: "The parameter range where this child is at full level.", min: -1e6, max: 1e6, step: 0.01, optional: true, default: [0, 1] });
const blendFadeField = (): NumberField => ({ kind: "number", name: "fade", label: "Fade", help: "Width, in parameter units, of the fade in and out at the range edges.", min: 0, max: 1e6, step: 0.01, default: 0 });

const DEFAULT_SEND_CURVE: Curve = [[0, 1], [1, 0.5]];

const occlusionField = (): BooleanField => ({ kind: "boolean", name: "occlusion", label: "Occlusion", help: "Walls and objects between the sound and the listener muffle it (needs colliders in the scene).", optional: true, default: true });
const dopplerLevelField = (): NumberField => ({ kind: "number", name: "dopplerLevel", label: "Doppler level", help: "How strongly the pitch shifts as the sound and listener move; 0 is off, 1 is realistic, up to 5.", min: 0, max: 5, step: 0.05, optional: true, default: 0 });
const reverbSendCurveField = (): CurveField => ({
  kind: "curve", name: "reverbSendCurve", label: "Reverb send curve",
  help: "How much of the sound goes to the reverb zone it is in as it gets farther away: left is at the min distance, right at the max distance.",
  xRange: [0, 1], yRange: [0, 2], default: DEFAULT_SEND_CURVE.map((k) => [...k]) as unknown as Curve,
});
const lowpassField = (): NumberField => ({ kind: "number", name: "lowpass", label: "Low-pass (Hz)", help: "Cuts the highs above this frequency, for a muffled sound; empty (or 20000 and up) is off.", min: 10, max: 24000, step: 10, optional: true, offAtOrAbove: 20000, offLabel: "off", default: 24000 });
const highpassField = (): NumberField => ({ kind: "number", name: "highpass", label: "High-pass (Hz)", help: "Cuts the lows below this frequency, for a thin sound; empty (or 20 and below) is off.", min: 10, max: 24000, step: 10, optional: true, offAtOrBelow: 20, offLabel: "off", default: 10 });
const reverbSendField = (): NumberField => ({ kind: "number", name: REVERB_SEND_KEY, label: "Reverb send", help: "How much of the sound goes to reverb: 0 none, 1 normal, up to 2.", min: 0, max: 2, step: 0.05, optional: true, default: 1 });
const auxSendField = (): AuxField => ({ kind: "aux", name: "aux", label: "Aux send", help: "Also send the sound to one other bus (an echo or a radio effect, say) at this level, 0 to 2; an event has one aux send.", default: 1, min: 0, max: 2, step: 0.05 });

const spatialGroupDefault = (): Record<string, unknown> => ({ minDistance: 1, maxDistance: 100, rolloff: "inverse" });
const limitGroupDefault = (): Record<string, unknown> => ({ maxInstances: 0, steal: "oldest" });

/** The fields a node type owns, in panel order, with the mode-dependent ones left out. */
function ownFields(node: EventNode): FieldDescriptor[] {
  switch (node.type) {
    case "clip":
      return [
        clipAssetField(), loopField("Loop the clip until the instance stops."), startOffsetField(), loopRegionField(), sustainFlagField(),
      ];
    case "random":
      return [avoidRepeatField(node.children.length), modeField(), ...(node.mode === "continuous" ? [gapField()] : [])];
    case "sequence":
      return [
        modeField(),
        ...(node.mode === "continuous" ? [loopField("Start over after the last child."), gapField()] : []),
        ...(node.mode === "step" ? [resetField()] : []),
      ];
    case "switch":
      return [
        switchParameterField(), switchDefaultField(), onChangeField(),
        ...(node.onChange === "crossfade" ? [switchCrossfadeField()] : []),
      ];
    case "blend":
      return [blendParameterField()];
    case "layer":
      return [];
    case "sustain":
      return [releaseField(), ...(node.release === "now" ? [releaseFadeField(node)] : [])];
  }
}

/** Whether a field's key may be absent (its widget can clear it). */
function isOptional(field: FieldDescriptor): boolean {
  switch (field.kind) {
    case "range": case "text": case "group": case "number": case "boolean": case "select": return field.optional === true;
    case "curve": case "aux": return true;
    default: return false;
  }
}

/** Structural equality for the plain values a field holds (numbers, strings, booleans, arrays). */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  return a === b;
}

/** A fresh copy of a field's default, for writing a required field given `undefined`. */
function defaultOf(field: FieldDescriptor): unknown {
  switch (field.kind) {
    case "curves": return [];
    case "range": return [field.default[0], field.default[1]];
    case "group": return { ...field.default };
    case "curve": return field.default.map((k) => [...k]);
    case "aux": return undefined;
    default: return field.default;
  }
}

/** A finite number from a widget's raw value (a number, or a numeric string), else `undefined`. */
function toFiniteNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The fields of `node`, in panel order, given its parent (`null` for the root):
 * 1. The type's own fields (the `clip` asset first for a clip; `parameter` first for switch and blend), with the fields
 *    that mean nothing in the node's current mode left out: `gap` only for `mode: "continuous"`; a sequence's `loop`
 *    only for continuous and `reset` only for step; a switch's `crossfade` only for `onChange: "crossfade"`; a
 *    sustain's `releaseFade` only for `release: "now"`. `avoidRepeat`'s `max` is `max(0, children.length - 1)`.
 * 2. The common fields: `volume`, `pitch`, `volumeRandom`, `pitchRandom`, `delay`.
 * 3. The fields the parent gives meaning to: `weight` under a random; `value` (optional text) under a switch; `range`
 *    (optional) and `fade` under a blend, whatever the node (a sustain under a blend also lists its `releaseFade` when
 *    `release` is "now").
 * 4. `automation` (curves) last.
 * Limits are `parseAudioEvent`'s (see the spec in the brief).
 */
export function nodeFields(node: EventNode, parent: EventNode | null): FieldDescriptor[] {
  const out: FieldDescriptor[] = [...ownFields(node), ...commonFields()];
  if (parent?.type === "random") out.push(weightField());
  if (parent?.type === "switch") out.push(valueField());
  if (parent?.type === "blend") {
    out.push(rangeField(), blendFadeField());
  }
  out.push(automationField());
  return out;
}

// --- music nodes (ADR 0166 §2.3) -----------------------------------------------------------------------------------

const musicIdField = (): TextField => ({ kind: "text", name: "id", label: "Id", help: "The node's name in this event: 1 to 48 letters, digits, - or _, unique in the event (rules and stingers name it).", default: "" });
const gridOffsetField = (): NumberField => ({ kind: "number", name: "gridOffset", label: "Grid offset", help: "Seconds of audio before bar 1, beat 1 (the pickup).", min: 0, max: MAX_GRID_OFFSET, step: 0.001, default: 0 });
const cueSelectField = (name: "entry" | "exit", cues: readonly string[]): SelectField => ({
  kind: "select", name, label: name === "entry" ? "Entry cue" : "Exit cue", optional: true, emptyLabel: "(default)", options: cues, default: "",
  help: name === "entry" ? "The cue the segment is entered at; default is the cue named entry, else the grid start." : "The cue the segment is left at; default is the cue named exit, else the end.",
});
const playlistModeField = (): SelectField => ({ kind: "select", name: "mode", label: "Mode", help: "Sequence plays the children in order, random picks by weight, shuffle plays each once per round.", options: PLAYLIST_MODES, default: "sequence" });
const roundsField = (): NumberField => ({ kind: "number", name: "rounds", label: "Rounds", help: "Whole passes through the list; 0 repeats forever.", min: 0, max: MAX_PLAYLIST_ROUNDS, step: 1, integer: true, default: 1 });
const playsField = (): NumberField => ({ kind: "number", name: "plays", label: "Plays", help: "How many times this child plays per visit of its playlist.", min: 1, max: MUSIC_LIMITS.plays, step: 1, integer: true, default: 1 });
const musicVolumeRandomField = (): RangeField => volumeRandomField();

/**
 * The fields of a music node, in panel order, given its parent (`null` for the root) and whether it is a `library`
 * segment of its container (`inLibrary`: it is no child, so `plays`, `weight` and `value` mean nothing):
 * 1. `id` (text; the panel checks it against the event's other ids).
 * 2. The type's own: a segment's `gridOffset`, `entry` and `exit` (selects over its cue names, optional); a playlist's
 *    `mode`, `rounds` and (random mode) `avoidRepeat`; a music switch's `parameter` (labelled) and `default`.
 * 3. `volume` and `volumeRandom`. Pitch, delay, range, fade and automation are not read on music nodes, so they are not offered.
 * 4. What the parent gives meaning to: `plays` under a playlist, `weight` under a random playlist, `value` (optional
 *    text) under a music switch.
 */
export function musicNodeFields(node: MusicNode, parent: MusicNode | null, inLibrary = false): FieldDescriptor[] {
  const out: FieldDescriptor[] = [musicIdField()];
  switch (node.type) {
    case "segment": {
      const cues = node.cues.map((c) => c.name);
      out.push(gridOffsetField(), cueSelectField("entry", cues), cueSelectField("exit", cues));
      break;
    }
    case "playlist":
      out.push(playlistModeField(), roundsField(), ...(node.mode === "random" ? [avoidRepeatField(node.children.length)] : []));
      break;
    case "musicSwitch":
      out.push(switchParameterField(), switchDefaultField());
      break;
  }
  out.push(volumeField(), musicVolumeRandomField());
  if (!inLibrary) {
    if (parent?.type === "playlist") out.push(playsField(), ...(parent.mode === "random" ? [weightField()] : []));
    if (parent?.type === "musicSwitch") out.push(valueField());
  }
  return out;
}

// --- stingers (ADR 0166 §2.5) --------------------------------------------------------------------------------------

/** What a stinger's `at` is, as a choice: a grid point (`beat`, `bar`), `immediate`, a named `cue`, or an `every` spec the panel keeps but doesn't edit. */
export type StingerAtKind = "beat" | "bar" | "immediate" | "cue" | "every";
export const STINGER_AT_KINDS: readonly StingerAtKind[] = ["beat", "bar", "immediate", "cue"];
export const STINGER_IF_TOO_LATE = IF_TOO_LATE;

export function stingerAtKind(at: StingerAt): StingerAtKind {
  if (typeof at === "string") return at;
  return "cue" in at ? "cue" : "every";
}

/** The `at` a choice makes; `cue` keeps the cue name the stinger had (else empty), `every` can't be chosen (the stinger keeps its own). */
export function stingerAtFrom(kind: StingerAtKind, previous: StingerAt): StingerAt {
  if (kind === "cue") return { cue: typeof previous === "object" && "cue" in previous ? previous.cue : "" };
  return kind === "every" ? previous : kind;
}

/** A new stinger on library segment `segment`: a trigger name none of `taken` has (`stinger`, `stinger-2`…), the next beat, `nextGrid`. */
export function newStinger(taken: readonly string[], segment: string): StingerDef {
  let trigger = "stinger";
  for (let n = 2; taken.includes(trigger); n++) trigger = `stinger-${n}`;
  return { trigger, segment, at: "beat", dontRepeat: 0, ifTooLate: "nextGrid" };
}

/** `stinger` with `patch` applied; the optional `volume` and `bus` leave the stinger when `undefined` or empty (the file holds only what is set). */
export function patchStinger(stinger: StingerDef, patch: Partial<StingerDef>): StingerDef {
  const next = { ...stinger, ...patch };
  if (next.volume === undefined) delete next.volume;
  if (next.bus === undefined || next.bus === "") delete next.bus;
  return next;
}

/**
 * The event's own fields, in panel order: `bus`, `volume`, `pitch`, `volumeRandom`, `pitchRandom`, `priority`,
 * `spatial` (optional group: `minDistance`, `maxDistance`, `rolloff`, `occlusion`, `dopplerLevel`, `reverbSendCurve`),
 * `filter` (implicit group: `lowpass`, `highpass`), `sends` (implicit group: `reverb`, `aux`), `limit` (group: `maxInstances`, `steal`),
 * `cooldown`, `automation`. Parameters have their own pane and are not listed.
 */
export function eventFields(): FieldDescriptor[] {
  const spatial: GroupField = {
    kind: "group", name: "spatial", label: "Spatial", help: "Distance falloff in world units; absent plays flat.", optional: true,
    default: spatialGroupDefault(),
    fields: [
      { kind: "number", name: "minDistance", label: "Min distance", help: "Distance in world units within which the event plays at full volume.", min: 0, max: 1e6, step: 0.1, default: 1 },
      { kind: "number", name: "maxDistance", label: "Max distance", help: "Distance in world units beyond which the falloff stops.", min: 0, max: 1e6, step: 0.1, default: 100 },
      { kind: "select", name: "rolloff", label: "Rolloff", help: "How the volume falls off between the min and max distance.", options: ["linear", "inverse", "exponential"], default: "inverse" },
      occlusionField(), dopplerLevelField(), reverbSendCurveField(),
    ],
  };
  const filter: GroupField = {
    kind: "group", name: "filter", label: "Filter", help: "Per-voice low-pass and high-pass filters; absent applies none.", optional: true, implicit: true,
    default: {}, fields: [lowpassField(), highpassField()],
  };
  const sends: GroupField = {
    kind: "group", name: "sends", label: "Sends", help: "How much of the sound goes to the reverb and to one other bus; absent sends as usual.", optional: true, implicit: true,
    default: {}, fields: [reverbSendField(), auxSendField()],
  };
  const limit: GroupField = {
    kind: "group", name: "limit", label: "Limit", help: "How many instances may play at once and what gives way.",
    default: limitGroupDefault(),
    fields: [
      { kind: "number", name: "maxInstances", label: "Max instances", help: "Most instances playing at once; 0 is unlimited.", min: 0, max: 4096, step: 1, integer: true, default: 0 },
      { kind: "select", name: "steal", label: "Steal", help: "Which instance gives way when a new one would pass the limit.", options: ["oldest", "quietest", "none"], default: "oldest" },
    ],
  };
  const priority: NumberField = { kind: "number", name: "priority", label: "Priority", help: "Voice priority from 0 to 255; higher wins when voices are short.", min: 0, max: 255, step: 1, integer: true, default: 128 };
  const cooldown: NumberField = { kind: "number", name: "cooldown", label: "Cooldown", help: "Seconds after a play during which another play is refused.", min: 0, max: 60, step: 0.01, default: 0 };
  const bus: BusField = { kind: "bus", name: "bus", label: "Bus", help: "The bus the event plays through; empty is Master.", default: "" };
  return [bus, volumeField(), pitchField(), volumeRandomField(), pitchRandomField(), priority, spatial, filter, sends, limit, cooldown, automationField()];
}

/** The field named `name` in `fields` (top level only), or `undefined`. */
export function findField(fields: readonly FieldDescriptor[], name: string): FieldDescriptor | undefined {
  return fields.find((f) => f.name === name);
}

/** Whether `target` is a sustain node. */
function isSustain(target: object): target is SustainNode {
  return (target as { type?: unknown }).type === "sustain";
}

/**
 * `target[field.name]`, or `undefined` when the key is absent. A sustain's `releaseFade` reads as `sustainReleaseFade`,
 * so a file without the key shows its `fade`.
 */
export function readField(target: EventNode | MusicNode | AudioEventAsset | Record<string, unknown>, field: FieldDescriptor): unknown {
  if (field.name === "releaseFade" && isSustain(target)) return sustainReleaseFade(target);
  if (field.kind === "aux") {
    // The first non-reverb key is the aux send (the parser keeps one).
    const key = Object.keys(target).find((k) => k !== REVERB_SEND_KEY);
    const level = key === undefined ? undefined : (target as Record<string, unknown>)[key];
    return key !== undefined && typeof level === "number" ? ({ bus: key, level } satisfies AuxSend) : undefined;
  }
  return (target as unknown as Record<string, unknown>)[field.name];
}

/**
 * A shallow copy of `target` with `field.name` set to `value`, or with the key removed when `value` is `undefined`
 * (only for optional fields; a required field given `undefined` gets its `default`). The input is not modified.
 */
export function writeField<T extends object>(target: T, field: FieldDescriptor, value: unknown): T {
  const copy: Record<string, unknown> = { ...(target as object) };
  if (field.kind === "aux") {
    // `value` is an `AuxSend` (or `undefined`); it replaces every non-reverb key.
    for (const k of Object.keys(copy)) if (k !== REVERB_SEND_KEY) delete copy[k];
    const aux = value as AuxSend | undefined;
    if (aux) copy[aux.bus] = aux.level;
    return copy as T;
  }
  // An implicit group left empty is absent; an optional leaf set to its default is absent (a file only holds what was set).
  const empty = field.kind === "group" && field.implicit === true && value !== null && typeof value === "object" && Object.keys(value).length === 0;
  const atDefault = (field.kind === "number" || field.kind === "boolean" || field.kind === "curve") && isOptional(field) && sameValue(value, defaultOf(field));
  if (empty || atDefault) value = undefined;
  if (value === undefined) {
    if (isOptional(field)) {
      delete copy[field.name];
      return copy as T;
    }
    copy[field.name] = defaultOf(field);
    return copy as T;
  }
  copy[field.name] = value;
  return copy as T;
}

/**
 * What the widget's raw input becomes before `writeField`, as the parser would read it: `number` clamps to
 * `min..max`, rounds when `integer`, and gives `default` for a non-finite input; `range` clamps both ends and swaps
 * them when low is above high (`undefined` stays `undefined` when optional, else `default`); `select` gives `default`
 * for a value not in `options`; `text`, `asset`, `parameter`, `bus` coerce to a string (an `asset` drops a leading
 * `asset:`; an optional `text` maps `""` to `undefined`); `boolean` is `value === true`; `curves` and `group` pass
 * through unchanged.
 */
export function coerceField(field: FieldDescriptor, value: unknown): unknown {
  switch (field.kind) {
    case "number": {
      const n = toFiniteNumber(value);
      if (n === undefined) return field.default;
      const rounded = field.integer ? Math.round(n) : n;
      if (field.optional && field.offAtOrAbove !== undefined && rounded >= field.offAtOrAbove) return undefined;
      if (field.optional && field.offAtOrBelow !== undefined && rounded <= field.offAtOrBelow) return undefined;
      return Math.min(field.max, Math.max(field.min, rounded));
    }
    case "range": {
      const lo = Array.isArray(value) ? toFiniteNumber(value[0]) : undefined;
      const hi = Array.isArray(value) ? toFiniteNumber(value[1]) : undefined;
      if (lo === undefined || hi === undefined) return field.optional ? undefined : [field.default[0], field.default[1]];
      const a = Math.min(field.max, Math.max(field.min, lo));
      const b = Math.min(field.max, Math.max(field.min, hi));
      return a <= b ? [a, b] : [b, a];
    }
    case "select":
      if (field.optional && (value === undefined || value === "")) return undefined;
      return typeof value === "string" && field.options.includes(value) ? value : field.optional ? undefined : field.default;
    case "text": {
      if (value === undefined || value === null) return field.optional ? undefined : field.default;
      const s = String(value);
      return field.optional && s === "" ? undefined : s;
    }
    case "asset":
      if (value === undefined || value === null) return field.default;
      return String(value).replace(/^asset:/, "");
    case "parameter":
    case "bus":
      if (value === undefined || value === null) return field.default;
      return String(value);
    case "boolean":
      return value === true;
    case "aux": {
      const aux = value as Partial<AuxSend> | undefined | null;
      if (!aux || typeof aux.bus !== "string" || aux.bus === "" || aux.bus === REVERB_SEND_KEY) return undefined;
      const level = toFiniteNumber(aux.level) ?? field.default;
      return { bus: aux.bus, level: Math.min(field.max, Math.max(field.min, level)) } satisfies AuxSend;
    }
    case "curve":
      // A curve with no keys cannot be written (the parser would drop it): absent.
      return Array.isArray(value) && value.length > 0 ? value : undefined;
    case "curves":
    case "group":
      return value;
  }
}
