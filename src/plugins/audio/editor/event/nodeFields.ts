// The Event editor's field descriptors (ADR 0158 §1, §7): for the selected node (and for the event itself), the
// ordered list of fields the properties panel renders, each with its kind, label, limits, default and help. The
// limits match `parseAudioEvent`'s, so whatever the panel writes reads back unchanged. Pure: no Preact, no editor state.
// `readField` / `writeField` / `coerceField` read and write a descriptor's value on a node or the event, immutably.
import type { AudioEventAsset, EventNode } from "../../../../engine/audio/eventFormat";

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
 * - `group`: an object whose own `fields` are named relative to it; an `optional` group may be absent (a checkbox
 *   adds it with `default` or removes the key).
 */
export type FieldKind = "number" | "range" | "select" | "text" | "asset" | "boolean" | "parameter" | "bus" | "curves" | "group";

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

export interface GroupField extends FieldBase {
  kind: "group";
  /** May be absent (`spatial`: absent plays flat). */
  optional?: boolean;
  /** The object written when an optional group is turned on (a fresh copy each time). */
  default: Record<string, unknown>;
  fields: FieldDescriptor[];
}

export type FieldDescriptor =
  | NumberField | RangeField | SelectField | TextField | AssetField | BooleanField | ParameterField | BusField | CurvesField | GroupField;

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
const releaseFadeField = (): NumberField => ({ kind: "number", name: "fade", label: "Crossfade", help: "Seconds to crossfade from the loop into the end sound on release.", min: 0, max: 1e6, step: 0.01, default: 0 });

const weightField = (): NumberField => ({ kind: "number", name: "weight", label: "Weight", help: "Relative chance of this child being picked.", min: 0, max: 1e6, step: 0.1, default: 1 });
const valueField = (): TextField => ({ kind: "text", name: "value", label: "Value", help: "The label this child plays for.", optional: true, default: "" });
const rangeField = (): RangeField => ({ kind: "range", name: "range", label: "Range", help: "The parameter range where this child is at full level.", min: -1e6, max: 1e6, step: 0.01, optional: true, default: [0, 1] });
const blendFadeField = (): NumberField => ({ kind: "number", name: "fade", label: "Fade", help: "Width, in parameter units, of the fade in and out at the range edges.", min: 0, max: 1e6, step: 0.01, default: 0 });

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
      return [releaseField(), ...(node.release === "now" ? [releaseFadeField()] : [])];
  }
}

/** Whether a field's key may be absent (its widget can clear it). */
function isOptional(field: FieldDescriptor): boolean {
  return (field.kind === "range" || field.kind === "text" || field.kind === "group") && field.optional === true;
}

/** A fresh copy of a field's default, for writing a required field given `undefined`. */
function defaultOf(field: FieldDescriptor): unknown {
  switch (field.kind) {
    case "curves": return [];
    case "range": return [field.default[0], field.default[1]];
    case "group": return { ...field.default };
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
 *    sustain's `fade` (release crossfade) only for `release: "now"`. `avoidRepeat`'s `max` is
 *    `max(0, children.length - 1)`.
 * 2. The common fields: `volume`, `pitch`, `volumeRandom`, `pitchRandom`, `delay`.
 * 3. The fields the parent gives meaning to: `weight` under a random; `value` (optional text) under a switch; `range`
 *    (optional) and `fade` under a blend. A sustain under a blend lists `fade` once, as its release crossfade if shown,
 *    else as the blend fade (the format has one `fade` key; see the brief).
 * 4. `automation` (curves) last.
 * Limits are `parseAudioEvent`'s (see the spec in the brief).
 */
export function nodeFields(node: EventNode, parent: EventNode | null): FieldDescriptor[] {
  const out: FieldDescriptor[] = [...ownFields(node), ...commonFields()];
  if (parent?.type === "random") out.push(weightField());
  if (parent?.type === "switch") out.push(valueField());
  if (parent?.type === "blend") {
    out.push(rangeField());
    // One `fade` key: a sustain set to release "now" already lists it as its release crossfade.
    if (!(node.type === "sustain" && node.release === "now")) out.push(blendFadeField());
  }
  out.push(automationField());
  return out;
}

/**
 * The event's own fields, in panel order: `bus`, `volume`, `pitch`, `volumeRandom`, `pitchRandom`, `priority`,
 * `spatial` (optional group: `minDistance`, `maxDistance`, `rolloff`), `limit` (group: `maxInstances`, `steal`),
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
    ],
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
  return [bus, volumeField(), pitchField(), volumeRandomField(), pitchRandomField(), priority, spatial, limit, cooldown, automationField()];
}

/** The field named `name` in `fields` (top level only), or `undefined`. */
export function findField(fields: readonly FieldDescriptor[], name: string): FieldDescriptor | undefined {
  return fields.find((f) => f.name === name);
}

/** `target[field.name]`, or `undefined` when the key is absent. */
export function readField(target: EventNode | AudioEventAsset | Record<string, unknown>, field: FieldDescriptor): unknown {
  return (target as unknown as Record<string, unknown>)[field.name];
}

/**
 * A shallow copy of `target` with `field.name` set to `value`, or with the key removed when `value` is `undefined`
 * (only for optional fields; a required field given `undefined` gets its `default`). The input is not modified.
 */
export function writeField<T extends object>(target: T, field: FieldDescriptor, value: unknown): T {
  const copy: Record<string, unknown> = { ...(target as object) };
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
      return typeof value === "string" && field.options.includes(value) ? value : field.default;
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
    case "curves":
    case "group":
      return value;
  }
}
