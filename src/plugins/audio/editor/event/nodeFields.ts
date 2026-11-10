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
  void node; void parent;
  throw new Error("not implemented"); // L6.3b
}

/**
 * The event's own fields, in panel order: `bus`, `volume`, `pitch`, `volumeRandom`, `pitchRandom`, `priority`,
 * `spatial` (optional group: `minDistance`, `maxDistance`, `rolloff`), `limit` (group: `maxInstances`, `steal`),
 * `cooldown`, `automation`. Parameters have their own pane and are not listed.
 */
export function eventFields(): FieldDescriptor[] {
  throw new Error("not implemented"); // L6.3b
}

/** The field named `name` in `fields` (top level only), or `undefined`. */
export function findField(fields: readonly FieldDescriptor[], name: string): FieldDescriptor | undefined {
  void fields; void name;
  throw new Error("not implemented"); // L6.3b
}

/** `target[field.name]`, or `undefined` when the key is absent. */
export function readField(target: EventNode | AudioEventAsset | Record<string, unknown>, field: FieldDescriptor): unknown {
  void target; void field;
  throw new Error("not implemented"); // L6.3b
}

/**
 * A shallow copy of `target` with `field.name` set to `value`, or with the key removed when `value` is `undefined`
 * (only for optional fields; a required field given `undefined` gets its `default`). The input is not modified.
 */
export function writeField<T extends object>(target: T, field: FieldDescriptor, value: unknown): T {
  void target; void field; void value;
  throw new Error("not implemented"); // L6.3b
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
  void field; void value;
  throw new Error("not implemented"); // L6.3b
}
