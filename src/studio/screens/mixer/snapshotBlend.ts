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
import { isLabelled, type ParameterDef } from "../../../engine/audio/eventFormat";
import type { ConditionOp, Snapshot, SnapshotCondition, SnapshotStart } from "../../../engine/audio/project/types";

/** Test values by parameter name: a number, or a labelled parameter's label index. */
export type TestValues = Readonly<Record<string, number>>;

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

/** A parameter's test value: the given one, else its default (a label's index). */
export function testValueOf(def: ParameterDef, values: TestValues): number {
  const v = values[def.name];
  if (v !== undefined && Number.isFinite(v)) return v;
  return isLabelled(def) ? Math.max(0, def.labels.indexOf(def.default)) : def.default;
}

/** Whether one condition holds for the test values; false for an unknown parameter or a mismatched op. */
export function conditionHolds(c: SnapshotCondition, params: readonly ParameterDef[], values: TestValues): boolean {
  const def = params.find((p) => p.name === c.parameter);
  if (!def) return false;
  const v = testValueOf(def, values);
  if (isLabelled(def)) {
    const want = typeof c.value === "string" ? def.labels.indexOf(c.value) : Math.round(c.value);
    if (c.op === "is") return Math.round(v) === want;
    if (c.op === "not") return Math.round(v) !== want;
    return false;
  }
  if (typeof c.value !== "number") return false;
  const x = c.value;
  switch (c.op) {
    case "lt": return v < x;
    case "le": return v <= x;
    case "eq": return v === x;
    case "ne": return v !== x;
    case "ge": return v >= x;
    case "gt": return v > x;
    case "between": {
      const y = c.value2 ?? x;
      return v >= Math.min(x, y) && v <= Math.max(x, y);
    }
    default: return false;
  }
}

/** Whether a start would have the snapshot on with these test values (base: always; code and never: off). */
export function startHolds(start: SnapshotStart, params: readonly ParameterDef[], values: TestValues): boolean {
  switch (start.kind) {
    case "base": return true;
    case "code":
    case "never": return false;
    case "conditions":
      if (start.conditions.length === 0) return false;
      return start.match === "all" ? start.conditions.every((c) => conditionHolds(c, params, values)) : start.conditions.some((c) => conditionHolds(c, params, values));
  }
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

// --- resolution ---------------------------------------------------------------------------------------------------------

/** A snapshot that is on, in the order they started (oldest first), with its fade weight (default 1). */
export interface ActiveSnapshot {
  readonly snapshot: Pick<Snapshot, "name" | "priority" | "combine" | "buses" | "effects">;
  readonly weight?: number;
}

export interface ResolvedMix {
  /** Bus or return name → summed dB offset. */
  readonly levels: Readonly<Record<string, number>>;
  /** Bus name → effect id → param → { value, from }. */
  readonly effects: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, { readonly value: number; readonly from: string }>>>>>>;
  /** Per bus, the snapshots heard on it and how ("override", "add"), for the gain lanes' note. */
  readonly sources: Readonly<Record<string, readonly { readonly name: string; readonly how: "override" | "add" }[]>>;
}

/** The winner among override entries: highest priority, then the latest started (highest index). */
function winner<T extends { priority: number; order: number }>(list: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const x of list) if (!best || x.priority > best.priority || (x.priority === best.priority && x.order > best.order)) best = x;
  return best;
}

/**
 * The mix the active snapshots make (ADR 0330's rules). `base` maps a bus's effect parameter to its base value, so a
 * fading override blends from it (absent: the override's value is used as is).
 */
export function resolveSnapshots(active: readonly ActiveSnapshot[], base?: (bus: string, effectId: string, param: string) => number | undefined): ResolvedMix {
  const levels: Record<string, number> = {};
  const sources: Record<string, { name: string; how: "override" | "add" }[]> = {};
  const overrides = new Map<string, { priority: number; order: number; db: number; name: string }[]>();
  const params = new Map<string, { priority: number; order: number; value: number; weight: number; name: string; bus: string; id: string; param: string }[]>();
  active.forEach(({ snapshot: s, weight = 1 }, order) => {
    const w = Math.min(1, Math.max(0, weight));
    for (const [bus, db] of Object.entries(s.buses)) {
      if (s.combine === "add") {
        levels[bus] = (levels[bus] ?? 0) + db * w;
        (sources[bus] ??= []).push({ name: s.name, how: "add" });
      } else {
        const list = overrides.get(bus) ?? [];
        list.push({ priority: s.priority, order, db: db * w, name: s.name });
        overrides.set(bus, list);
      }
    }
    if (s.combine === "add") return;
    for (const [bus, byId] of Object.entries(s.effects)) {
      for (const [id, ps] of Object.entries(byId)) {
        for (const [param, value] of Object.entries(ps)) {
          const key = `${bus}\u0000${id}\u0000${param}`;
          const list = params.get(key) ?? [];
          list.push({ priority: s.priority, order, value, weight: w, name: s.name, bus, id, param });
          params.set(key, list);
        }
      }
    }
  });
  for (const [bus, list] of overrides) {
    const win = winner(list)!;
    levels[bus] = (levels[bus] ?? 0) + win.db;
    (sources[bus] ??= []).unshift({ name: win.name, how: "override" });
  }
  const effects: Record<string, Record<string, Record<string, { value: number; from: string }>>> = {};
  for (const list of params.values()) {
    const win = winner(list)!;
    const from = base?.(win.bus, win.id, win.param);
    const value = from === undefined ? win.value : from + (win.value - from) * win.weight;
    ((effects[win.bus] ??= {})[win.id] ??= {})[win.param] = { value, from: win.name };
  }
  return { levels, effects, sources };
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
