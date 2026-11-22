// Snapshot triggers and blending (ADR 0330 "Snapshots blend"; the prototype's Trigger dialog and its clash list).
//
// - Conditions: `lt le eq ne ge gt between` on numeric parameters, `is not` on labelled ones (a boolean is labelled
//   ["Off", "On"]), evaluated against test values (a labelled parameter's value is its label's index). A snapshot whose
//   start is `base` is always on; `code` and `never` are off until game code (or an audition) starts them.
// - Resolution: any number of snapshots can be active. Per bus, the Override snapshots that list the bus resolve by
//   priority (equal priority: the one started last wins) and the Add snapshots that list it stack their offsets on top.
//   An effect parameter takes the value of the winning Override snapshot that overrides it; Add snapshots never
//   override parameters. A snapshot only affects what it lists (as Wwise states and FMOD snapshots scope properties).
//   Each snapshot's contribution scales with its fade weight (0..1, a linear ramp in dB over its fade times).
// - Overlaps: for the Trigger dialog, the other snapshots sharing a bus or a parameter with one, and who wins where.
//
// Pure.
import { isLabelled, type ParameterDef } from "../../../engine/audio/parameters";
import { startHolds } from "../../../engine/audio/project/snapshots";
import type { ConditionOp, Snapshot, SnapshotCondition, SnapshotStart } from "../../../engine/audio/project/types";

// The model itself (conditions and resolution) is the engine's, shared with the runtime's mixer (ADR 0330).
export {
  conditionHolds, resolveSnapshots, startHolds, testValueOf,
  type ActiveSnapshot, type ResolvedMix, type TestValues,
} from "../../../engine/audio/project/snapshots";
import type { TestValues } from "../../../engine/audio/project/snapshots";

/** The comparisons a parameter offers, with their words. */
export const NUMERIC_OPS: readonly { op: ConditionOp; label: string; symbol: string }[] = [
  { op: "lt", label: "is below", symbol: "<" },
  { op: "le", label: "is at most", symbol: "≤" },
  { op: "eq", label: "equals", symbol: "=" },
  { op: "ne", label: "isn't", symbol: "≠" },
  { op: "ge", label: "is at least", symbol: "≥" },
  { op: "gt", label: "is above", symbol: ">" },
  { op: "between", label: "is between", symbol: "between" },
];
export const LABEL_OPS: readonly { op: ConditionOp; label: string; symbol: string }[] = [
  { op: "is", label: "is", symbol: "is" },
  { op: "not", label: "isn't", symbol: "is not" },
];

/** The ops a parameter allows. */
export const opsFor = (def: ParameterDef | undefined) => (def && isLabelled(def) ? LABEL_OPS : NUMERIC_OPS);

/** A new condition row on `def`: "is above its default" for a number, "is its first label" for labels. */
export function defaultCondition(def: ParameterDef): SnapshotCondition {
  return isLabelled(def) ? { parameter: def.name, op: "is", value: def.labels[0] ?? "" } : { parameter: def.name, op: "gt", value: def.default };
}

/** A condition moved to parameter `def`: the op and value kept when they still fit its type, else its defaults. */
export function retarget(c: SnapshotCondition, def: ParameterDef): SnapshotCondition {
  const fits = opsFor(def).some((o) => o.op === c.op) && (isLabelled(def) ? typeof c.value === "string" && def.labels.includes(c.value) : typeof c.value === "number");
  return fits ? { ...c, parameter: def.name } : defaultCondition(def);
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/** One condition as text ("depth > 0", "state is Paused", "health between 0 and 20"). */
export function conditionText(c: SnapshotCondition): string {
  const op = [...NUMERIC_OPS, ...LABEL_OPS].find((o) => o.op === c.op);
  const v = typeof c.value === "number" ? fmt(c.value) : c.value;
  if (c.op === "between") return `${c.parameter} between ${v} and ${fmt(c.value2 ?? (typeof c.value === "number" ? c.value : 0))}`;
  return `${c.parameter} ${op?.symbol ?? c.op} ${v}`;
}

/** A start as text, for the tree's search and the snapshot chip ("Base mix", "From game code", "depth > 0 and …"). */
export function triggerText(start: SnapshotStart): string {
  switch (start.kind) {
    case "base": return "Base mix";
    case "code": return "From game code";
    case "never": return "Never (audition only)";
    case "conditions":
      return start.conditions.length === 0 ? "No conditions" : start.conditions.map(conditionText).join(start.match === "all" ? " and " : " or ");
  }
}

// --- overlaps -----------------------------------------------------------------------------------------------------------

/** One other snapshot sharing something with the one being edited, and how they combine. */
export interface Overlap {
  readonly name: string;
  /** What they share: bus names, and "Bus · fx1.cutoff" for parameters. */
  readonly shared: readonly string[];
  /** Who wins, in words. */
  readonly outcome: string;
  /** Equal priority between two Override snapshots: the one started last wins (worth a warning). */
  readonly warn: boolean;
  /** The other snapshot is on with the test values now. */
  readonly onNow: boolean;
}

/**
 * The snapshots `name` overlaps with (sharing a bus offset or an overridden parameter), with the outcome per ADR 0330:
 * both Add → their offsets add up; one Add → its offsets add on top of the other; both Override → the higher priority
 * wins, equal → the one started last wins. `draft` stands in for the snapshot being edited (the dialog's unsaved state).
 */
export function overlapsOf(snapshots: readonly Snapshot[], name: string, params: readonly ParameterDef[], values: TestValues, draft?: Snapshot): Overlap[] {
  const self = draft ?? snapshots.find((s) => s.name === name);
  if (!self) return [];
  const paramKeys = (s: Snapshot) => Object.entries(s.effects).flatMap(([bus, byId]) => Object.entries(byId).flatMap(([id, ps]) => Object.keys(ps).map((p) => `${bus} · ${id}.${p}`)));
  const mineBuses = Object.keys(self.buses);
  const mineParams = paramKeys(self);
  const out: Overlap[] = [];
  for (const other of snapshots) {
    if (other.name === name) continue;
    const sharedBuses = Object.keys(other.buses).filter((b) => mineBuses.includes(b));
    // Add snapshots don't override parameters, so a parameter is shared only between two Override snapshots.
    const sharedParams = self.combine === "override" && other.combine === "override" ? paramKeys(other).filter((k) => mineParams.includes(k)) : [];
    if (sharedBuses.length === 0 && sharedParams.length === 0) continue;
    let outcome: string;
    let warn = false;
    if (self.combine === "add" && other.combine === "add") outcome = "Both add: their level changes add up.";
    else if (self.combine === "add") outcome = `${self.name} adds its levels on top of ${other.name}.`;
    else if (other.combine === "add") outcome = `${other.name} adds its levels on top of ${self.name}.`;
    else if (self.priority === other.priority) {
      outcome = `Same priority (${self.priority}): the one started last wins.`;
      warn = true;
    } else {
      const [hi, lo] = self.priority > other.priority ? [self, other] : [other, self];
      outcome = `${hi.name} wins (priority ${hi.priority} over ${lo.priority}).`;
    }
    out.push({ name: other.name, shared: [...sharedBuses, ...sharedParams], outcome, warn, onNow: startHolds(other.start, params, values) });
  }
  return out;
}
