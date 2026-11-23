// The mixer's gain breakdown (ADR 0349 `GainLanes`, ADR 0344 "Gain"): where the level you hear from a bus or return
// comes from. A bus's level in dB is the sum of its lanes (authored fader, runtime, snapshot, VCA, monitor, dip, duck,
// automation) and every level above it is added on top, so the linear gain is the product down the tree.
//
// The VCA lane is the sum of the VCAs whose members include the bus or one of its ancestors, each VCA counted once; the
// levels added from above leave their own VCA lanes out, so a VCA is applied exactly once however deep its member is.
// Mute and a fader at the floor (−60 dB) silence a bus and everything under it. Solo is exclusive: with a bus soloed,
// every bus is silenced on its monitor lane except Master, the returns, the soloed bus and its ancestors and descendants.
// Lanes owned by the runtime (runtime, dip, duck, automation; monitor while comparing) come in as `live` values.
import { MIN_DB } from "../../engine/audio/project/gain";
import type { Bus, Return, Snapshot, Vca } from "../../engine/audio/project/types";

export type GainLaneKey = "authored" | "runtime" | "snapshot" | "vca" | "monitor" | "dip" | "duck" | "automation";

export const GAIN_LANE_ORDER: readonly GainLaneKey[] = ["authored", "runtime", "snapshot", "vca", "monitor", "dip", "duck", "automation"];

const LABEL: Record<GainLaneKey, string> = {
  authored: "Fader",
  runtime: "Runtime",
  snapshot: "Snapshot",
  vca: "VCA",
  monitor: "Monitor",
  dip: "Dip",
  duck: "Duck",
  automation: "Automation",
};

const HINT: Record<GainLaneKey, string> = {
  authored: "The level saved in the mix",
  runtime: "Set by game code (Audio.bus(…).volume)",
  snapshot: "The snapshot's offset for this bus",
  vca: "VCAs this bus or a bus above it belongs to",
  monitor: "Solo and Compare while you listen; never saved",
  dip: "A short dip asked for by the game",
  duck: "Ducking rules lowering this bus",
  automation: "Level automation driven by game parameters",
};

/** Lanes the runtime owns, dB (absent: neutral). `-Infinity` silences. */
export type LiveLanes = Partial<Record<"runtime" | "snapshot" | "monitor" | "dip" | "duck" | "automation", number>>;

export interface GainInputs {
  readonly buses: readonly Pick<Bus, "name" | "parent" | "volumeDb" | "mute">[];
  readonly returns?: readonly Pick<Return, "name" | "output" | "volumeDb" | "mute">[];
  readonly vcas?: readonly Pick<Vca, "name" | "volumeDb" | "members">[];
  /** The snapshot whose offsets are shown (the one being edited or auditioned); a `live.snapshot` value wins over it. */
  readonly snapshot?: Pick<Snapshot, "name" | "buses"> | null;
  /** The soloed bus, if any. */
  readonly solo?: string | null;
  /** Lanes the runtime owns, per bus or return name. */
  readonly live?: Readonly<Record<string, LiveLanes>>;
  /** The master bus's name (default "Master"). */
  readonly master?: string;
}

export interface GainLane {
  readonly key: GainLaneKey;
  readonly label: string;
  /** dB; 0 is neutral; `-Infinity` silences. */
  readonly db: number;
  readonly neutral: boolean;
  /** What it is ("Gameplay SFX, All voice", "muted", "solo on Dialogue"). */
  readonly note: string;
}

export interface GainBreakdown {
  readonly name: string;
  readonly lanes: readonly GainLane[];
  /** The sum of this bus's own lanes. */
  readonly ownDb: number;
  /** Each level above it, nearest first (their VCA lanes left out). */
  readonly parents: readonly { readonly name: string; readonly db: number }[];
  readonly parentsDb: number;
  /** What you hear from it, dB (`-Infinity` for silence). */
  readonly totalDb: number;
  /** The same as a linear gain (0 for silence). */
  readonly gain: number;
}

interface Node {
  readonly name: string;
  readonly parent: string | null;
  readonly volumeDb: number;
  readonly mute: boolean;
  readonly isReturn: boolean;
}

const nodesOf = (inputs: GainInputs): Map<string, Node> => {
  const map = new Map<string, Node>();
  for (const b of inputs.buses) map.set(b.name, { name: b.name, parent: b.parent, volumeDb: b.volumeDb, mute: b.mute, isReturn: false });
  for (const r of inputs.returns ?? []) map.set(r.name, { name: r.name, parent: r.output, volumeDb: r.volumeDb, mute: r.mute, isReturn: true });
  return map;
};

/** `name`'s ancestors, nearest first (cycles and unknown parents end the walk). */
function ancestorsOf(nodes: ReadonlyMap<string, Node>, name: string): string[] {
  const out: string[] = [];
  const seen = new Set([name]);
  for (let p = nodes.get(name)?.parent ?? null; p !== null && nodes.has(p) && !seen.has(p); p = nodes.get(p)!.parent) {
    out.push(p);
    seen.add(p);
  }
  return out;
}

/** Whether `name` stays audible on its monitor lane while `solo` is soloed (ADR 0344's solo rule). */
export function audibleUnderSolo(inputs: GainInputs, name: string, solo: string | null | undefined): boolean {
  if (!solo) return true;
  const nodes = nodesOf(inputs);
  const master = inputs.master ?? "Master";
  if (name === master || name === solo || nodes.get(name)?.isReturn) return true;
  return ancestorsOf(nodes, solo).includes(name) || ancestorsOf(nodes, name).includes(solo);
}

const add = (a: number, b: number) => (a === -Infinity || b === -Infinity ? -Infinity : a + b);
const sum = (xs: readonly number[]) => xs.reduce(add, 0);

function lanesOf(inputs: GainInputs, nodes: ReadonlyMap<string, Node>, name: string, withVca: boolean): GainLane[] {
  const node = nodes.get(name)!;
  const live = inputs.live?.[name] ?? {};
  const lane = (key: GainLaneKey, db: number, note = ""): GainLane => ({ key, label: LABEL[key], db, neutral: db === 0, note: note || (db === 0 ? "neutral" : HINT[key]) });
  const silent = node.mute || node.volumeDb <= MIN_DB;
  const lanes: GainLane[] = [lane("authored", silent ? -Infinity : node.volumeDb, node.mute ? "muted" : silent ? "at the floor" : HINT.authored)];
  lanes.push(lane("runtime", live.runtime ?? 0));
  const snap = live.snapshot ?? inputs.snapshot?.buses[name] ?? 0;
  lanes.push(lane("snapshot", snap, snap !== 0 && inputs.snapshot && live.snapshot === undefined ? inputs.snapshot.name : ""));
  if (withVca) {
    const line = new Set([name, ...ancestorsOf(nodes, name)]);
    const vcas = (inputs.vcas ?? []).filter((v) => v.members.some((m) => line.has(m)));
    const db = sum(vcas.map((v) => (v.volumeDb <= MIN_DB ? -Infinity : v.volumeDb)));
    lanes.push(lane("vca", db, vcas.length > 0 ? vcas.map((v) => v.name).join(", ") : ""));
  }
  const soloSilenced = !audibleUnderSolo(inputs, name, inputs.solo);
  const monitor = soloSilenced ? -Infinity : (live.monitor ?? 0);
  lanes.push(lane("monitor", monitor, soloSilenced ? `solo on ${inputs.solo}` : ""));
  lanes.push(lane("dip", live.dip ?? 0));
  lanes.push(lane("duck", live.duck ?? 0));
  lanes.push(lane("automation", live.automation ?? 0));
  return lanes;
}

/** The breakdown for bus or return `name`, or null when there is none by that name. */
export function gainBreakdown(inputs: GainInputs, name: string): GainBreakdown | null {
  const nodes = nodesOf(inputs);
  if (!nodes.has(name)) return null;
  const lanes = lanesOf(inputs, nodes, name, true);
  const ownDb = sum(lanes.map((l) => l.db));
  const parents = ancestorsOf(nodes, name).map((p) => ({ name: p, db: sum(lanesOf(inputs, nodes, p, false).map((l) => l.db)) }));
  const parentsDb = sum(parents.map((p) => p.db));
  const totalDb = add(ownDb, parentsDb);
  return { name, lanes, ownDb, parents, parentsDb, totalDb, gain: totalDb === -Infinity ? 0 : Math.pow(10, totalDb / 20) };
}

/** A lane's bar: how much of the bar it fills (40 dB is full) and which way. */
export function laneBar(db: number): { readonly fill: number; readonly cut: boolean } {
  if (db === -Infinity) return { fill: 1, cut: true };
  return { fill: Math.min(1, Math.abs(db) / 40), cut: db < 0 };
}

/** A lane's value as text: "neutral", "−∞", or a signed dB figure. */
export function laneText(lane: Pick<GainLane, "db" | "neutral">): string {
  if (lane.neutral) return "neutral";
  return dbText(lane.db);
}

/** A dB figure: "−∞" for silence, signed with one decimal otherwise ("+2.0 dB", "−16.0 dB"). */
export function dbText(db: number): string {
  if (db === -Infinity) return "−∞";
  const r = Math.round(db * 10) / 10;
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(1)} dB`;
}

/** A linear gain as text ("× 0.158"). */
export const gainText = (gain: number): string => `× ${gain === 0 ? "0" : gain.toFixed(3)}`;
