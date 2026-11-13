/**
 * Internal (ADR 0171 amended by 0172; api-and-models §6.2): live mix operations. An edit in Project Settings > Audio or
 * the Mixer panel is one `MixOp` (not a diff: a rename is `renameBus`, so a bus's voices, slot and held handles survive),
 * applied to the settings draft by `applyOpToDraft` and to the running mixer by `mixer.apply(op)`.
 *
 * Pure: no plugin, no DOM. Contract K0 declares the shapes; task Mo1 fills the functions (each stub throws "Mo1").
 */
import type { AudioSettings, BusAutomation, BusEffect, DuckingRule, LoudnessTarget } from "./settings";

/** How an op reaches the core (§6.2's class table; architecture §4.7). */
export type OpClass = "direct" | "smoothed" | "dip" | "config" | "none";

/** The `OpClass` values as numbers, in the byte form's `u8 class` (the capture's MIXOP record, §5.3). */
export const OP_CLASS_CODES: Readonly<Record<OpClass, number>> = { direct: 0, smoothed: 1, dip: 2, config: 3, none: 4 };

/** Every op class, for tests and tables. */
export const OP_CLASSES: readonly OpClass[] = ["direct", "smoothed", "dip", "config", "none"];

/** One live edit (§6.2). */
export type MixOp =
  | { op: "setBus"; bus: string; key: "volume" | "mute" | "maxVoices" | "bed" | "bedPriority" | "meter"; value: number | boolean | string | null }
  | { op: "addBus"; name: string; parent: string; index?: number }
  /** The bus and its descendants (`audioSettingsModel.ts` `removeBus`). */
  | { op: "removeBus"; bus: string }
  | { op: "renameBus"; from: string; to: string }
  | { op: "moveBus"; bus: string; parent: string }
  | { op: "addEffect"; bus: string; index: number; effect: BusEffect }
  | { op: "removeEffect"; bus: string; index: number }
  | { op: "moveEffect"; bus: string; from: number; to: number }
  | { op: "setEffect"; bus: string; index: number; key: string; value: number }
  | { op: "addSnapshot" | "removeSnapshot" | "renameSnapshot"; index: number; name?: string }
  | { op: "setSnapshot"; index: number; bus: string; key: "volume" | "lowpass"; value: number | null }
  | { op: "setDucking"; index: number; rule: DuckingRule | null; insert?: boolean }
  | { op: "setAutomation"; index: number; rule: BusAutomation | null; insert?: boolean }
  | { op: "setTarget"; index: number; target: LoudnessTarget | null; insert?: boolean }
  | { op: "setOption"; key: "loudnessResetOnPlay"; value: boolean };

/** The `op` names, in the byte form's `u8 op` order (index = code). Append only: a capture stores the code. */
export const MIX_OP_NAMES = [
  "setBus", "addBus", "removeBus", "renameBus", "moveBus", "addEffect", "removeEffect", "moveEffect", "setEffect",
  "addSnapshot", "removeSnapshot", "renameSnapshot", "setSnapshot", "setDucking", "setAutomation", "setTarget", "setOption",
] as const satisfies readonly MixOp["op"][];

/** What `audioEdit` registers for one undo step: the ops that made it and the ops that undo it (§6.4). */
export interface MixOpEntry { ops: MixOp[]; inverse: MixOp[] }

/**
 * What `mixer.apply(op)` / `AudioBackend.applyOp(op)` answers (§6.2). `deferred`: the edit is kept and applies later
 * (a bus add with no free slot, R10; the message says when). `restartRequired`: no live path serves it; it applies at
 * the next Play (the message names what).
 */
export interface ApplyResult { ok: boolean; class: OpClass; deferred?: string; restartRequired?: string }

/**
 * The settings draft an op edits: the panel's `SettingsDraft` (`src/editor/projectSettingsModel.ts`) or anything with an
 * `audio` section. Generic so the engine imports nothing of the editor.
 */
export interface MixDraft { audio?: unknown }

/** The byte form of one op (the capture's MIXOP record): `u8 op`, `u8 class`, `u16 argc`, `argc` u32 words (§6.2). */
export interface MixOpBytes { op: number; class: number; words: Uint32Array }

/** Resolves names to ids and bus names to `busRef` (`gen << 8 | slot`, §6.3) for the byte form. */
export interface MixOpNameTable {
  nameId(name: string): number;
  busRef(bus: string): number;
}

/** Mo1: the next draft after `op`, through the model functions the settings section uses (`audioSettingsModel.ts`). */
export function applyOpToDraft<D extends MixDraft>(_d: D, _op: MixOp): D {
  throw new Error("Mo1");
}

/** Mo1: how `op` reaches the core against `settings` (§6.2's class table). */
export function opClass(_op: MixOp, _settings: AudioSettings): OpClass {
  throw new Error("Mo1");
}

/** Mo1: the op that undoes `op` applied to `before`. */
export function invert(_op: MixOp, _before: AudioSettings): MixOp {
  throw new Error("Mo1");
}

/** Mo1: ops that turn `before` into `after` (an outside edit, Compare); a rename it can't see is remove plus add. Keys no live path serves are listed in `restartRequired`. */
export function diffOps(_before: AudioSettings, _after: AudioSettings): { ops: MixOp[]; restartRequired: string[] } {
  throw new Error("Mo1");
}

/** Mo1: the byte form of `op` (floats as bit patterns, strings as name ids, buses as `busRef`). */
export function encodeMixOp(_op: MixOp, _cls: OpClass, _names: MixOpNameTable): MixOpBytes {
  throw new Error("Mo1");
}

/** Mo1: the op back from its byte form; `name(id)` and `bus(ref)` resolve what `encodeMixOp` interned. */
export function decodeMixOp(_bytes: MixOpBytes, _names: { name(id: number): string; bus(ref: number): string }): { op: MixOp; class: OpClass } {
  throw new Error("Mo1");
}
