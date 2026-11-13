/**
 * Internal (ADR 0171 amended by 0172; api-and-models §6.2): live mix operations. An edit in Project Settings > Audio or
 * the Mixer panel is one `MixOp` (not a diff: a rename is `renameBus`, so a bus's voices, slot and held handles survive),
 * applied to the settings draft by `applyOpToDraft` and to the running mixer by `mixer.apply(op)`.
 *
 * Pure: no plugin, no DOM. Contract K0 declares the shapes; task Mo1 fills the functions.
 *
 * **One edit path.** The engine may not import the editor plugin, so the edit itself lives here, in
 * `applyOpToSettings`, and the model functions of `src/plugins/audio/editor/audioSettingsModel.ts` (`addBus`,
 * `removeBus`, `renameBus`, `setBusParent`, `setBusValue`, the effect, snapshot, ducking, automation, meter and target
 * functions) build an op and call `applyOpToDraft`: an op and the Project Settings UI edit the same way (§6.2's
 * "`applyOpToDraft` calls the model functions", read with the engine-imports-no-plugin rule).
 *
 * **Canonical form.** `applyOpToSettings` writes optional keys the way the parse and the model functions do: a bus's
 * `maxVoices`, `bed`, `bedPriority` and `meter` are absent when unset or at their default; `loudnessTargets` is absent
 * when it equals `DEFAULT_LOUDNESS_TARGETS`; `loudnessResetOnPlay` is absent when true. `diffOps(a, b)` applied to `a`
 * gives `b` for a canonical, valid `b` (the live keys, `LIVE_KEYS`; every other key is listed in `restartRequired`).
 *
 * **Refusals.** An op the parse would drop (an unknown bus, a duplicate name, a ninth metered bus, a rule whose target is
 * its trigger…) is refused: `opRefusal` says why and `applyOpToSettings` returns its input unchanged (the same object).
 */
import type { AudioSettings, BusAutomation, BusEffect, DuckingRule, LoudnessTarget } from "./settings";

/** How an op reaches the core (§6.2's class table; architecture §4.7). */
export type OpClass = "direct" | "smoothed" | "dip" | "config" | "none";

/** The `OpClass` values as numbers, in the byte form's `u8 class` (the capture's MIXOP record, §5.3). */
export const OP_CLASS_CODES: Readonly<Record<OpClass, number>> = { direct: 0, smoothed: 1, dip: 2, config: 3, none: 4 };

/** Every op class, for tests and tables. */
export const OP_CLASSES: readonly OpClass[] = ["direct", "smoothed", "dip", "config", "none"];

/**
 * One live edit (§6.2). Index semantics, for every list op:
 * - `addBus.index`: the position in `audio.buses` (clamped to 1..length, the root stays first); absent: the end.
 *   `parent` unknown: the root (as the model's `addBus`).
 * - `addEffect.index`, `addSnapshot.index`: insert position (clamped to 0..length). `addSnapshot.name` absent: a unique
 *   "Snapshot", "Snapshot 2"…; `renameSnapshot.name` required.
 * - `setDucking` / `setAutomation` / `setTarget`: `rule` (or `target`) with `insert` inserts at `index` (0..length);
 *   without `insert` replaces the entry at `index`; `null` removes it.
 * - `setBus` values: `volume` number; `mute` boolean; `maxVoices` number or null (unlimited); `bed` a `BusBed` or null
 *   (the default); `bedPriority` number or null (the default); `meter` `"loudness"` or null (off).
 * - `setSnapshot.value` null: the bus is unlisted in that snapshot (multiplier 1, no low-pass).
 */
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

// --- limits and defaults the ops check (api-and-models §2.1; Ld5 may move them into settings.ts) ----------------------

/** §2.1: non-root buses that may carry `meter: "loudness"` (the root is always metered). */
export const MAX_LOUDNESS_BUSES = 8;
/** §2.1: entries of `loudnessTargets`, 1..8. */
export const MAX_LOUDNESS_TARGETS = 8;
/** §2.1: a target's name, up to 32 characters. */
export const MAX_TARGET_NAME = 32;
/** §2.1 (owner decision 4): `loudnessTargets` when absent; the first is the default target. */
export const DEFAULT_LOUDNESS_TARGETS: readonly Readonly<LoudnessTarget>[] = [
  { name: "console", integrated: -24, tolerance: 2, truePeak: -1 },
  { name: "mobile", integrated: -18, tolerance: 2, truePeak: -1 },
];

/** The `audio` keys a live op edits; every other key that differs is `restartRequired` in `diffOps`. */
export const LIVE_KEYS = ["buses", "snapshots", "ducking", "automation", "loudnessTargets", "loudnessResetOnPlay"] as const;

/** Mo1: `loudnessTargets` with the default applied (a copy). */
export function loudnessTargetsOf(_a: Pick<AudioSettings, "loudnessTargets">): LoudnessTarget[] {
  throw new Error("Mo1");
}

/**
 * Mo1: why `op` can't apply to `a` (the message the settings section and the Mixer show, e.g. "At most 8 buses can be
 * metered"), or null when it applies. An op that applies may still change nothing (a value set to what it is).
 */
export function opRefusal(_a: AudioSettings, _op: MixOp): string | null {
  throw new Error("Mo1");
}

/** Mo1: `a` after `op`, in canonical form; `a` itself (the same object) when the op is refused or changes nothing. */
export function applyOpToSettings(_a: AudioSettings, _op: MixOp): AudioSettings {
  throw new Error("Mo1");
}

/**
 * Mo1: the next draft after `op`: the parsed section through `applyOpToSettings`, the live keys written back over the
 * draft's `audio` object (other keys stay as authored). `d` itself when nothing changes.
 */
export function applyOpToDraft<D extends MixDraft>(_d: D, _op: MixOp): D {
  throw new Error("Mo1");
}

/**
 * Mo1: how `op` reaches the core against `settings` (§6.2's class table, architecture §4.7): `direct` (`setBus` volume,
 * mute, maxVoices, meter; `setEffect` on a filter or send; `addEffect` at the end; `addBus`; snapshot, ducking,
 * automation and target edits), `smoothed` (`setEffect` on a compressor), `dip` (`moveBus`, `removeBus`, `removeEffect`,
 * `moveEffect`, `addEffect` before the end), `config` (`renameBus`, no wire; `setBus` bed and bedPriority; `setOption`),
 * `none` (refused, or changes nothing).
 */
export function opClass(_op: MixOp, _settings: AudioSettings): OpClass {
  throw new Error("Mo1");
}

/**
 * Mo1: the ops that undo `op` applied to `before`: `applyOpToSettings` of them, in order, on
 * `applyOpToSettings(before, op)` gives `before` back (for a canonical `before`). Empty when `op` is refused or changes
 * nothing. A list, not one op: undoing `removeBus` re-adds the bus and its descendants with their values, effects,
 * snapshot entries, ducking rules and automation; undoing `removeSnapshot` re-adds its entries.
 */
export function invert(_op: MixOp, _before: AudioSettings): MixOp[] {
  throw new Error("Mo1");
}

/**
 * Mo1: ops that turn `before` into `after` (an outside edit, Compare); a rename it can't see is remove plus add, and so is
 * a bus whose place in the list changed. Top-level keys outside `LIVE_KEYS` that differ are listed in `restartRequired`
 * (no live path serves them: voices, backend, clip memory and format, codecs, spatial, limiter look-ahead, music rings,
 * rhythm mode, occlusion, zones…).
 */
export function diffOps(_before: AudioSettings, _after: AudioSettings): { ops: MixOp[]; restartRequired: string[] } {
  throw new Error("Mo1");
}

/**
 * Mo1: the byte form of `op`: indices and counts as u32 words, numbers as f64 bit patterns (two words, low word first,
 * exact), strings as `nameId`, existing buses as `busRef` (`addBus.name` and `renameBus.to` are new names: `nameId`),
 * optional and nullable fields behind a flag word, effects and enums as small codes.
 */
export function encodeMixOp(_op: MixOp, _cls: OpClass, _names: MixOpNameTable): MixOpBytes {
  throw new Error("Mo1");
}

/** Mo1: the op back from its byte form; `name(id)` and `bus(ref)` resolve what `encodeMixOp` interned. */
export function decodeMixOp(_bytes: MixOpBytes, _names: { name(id: number): string; bus(ref: number): string }): { op: MixOp; class: OpClass } {
  throw new Error("Mo1");
}
