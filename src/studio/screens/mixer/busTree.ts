// The Mixer's routing tree and the edits that change its shape (ADR 0330; the prototype's Buses panel): the buses in
// routing order with their display paths, re-routing with its refusals (Master, onto itself, under a bus below it,
// onto its current parent), new buses, returns and VCAs, renaming (names are identities, unique across buses, returns
// and VCAs; every reference inside `audio.json` follows) and deleting with a plan of what goes, applied in the same
// edit. Pure: every edit returns `{ next } | { refused }` (ADR 0307) over an `AudioProject` and never mutates it.
import { MIX_LIMITS, newBus } from "../../../engine/audio/project/format";
import type { AudioProject, Bus, MixAutomation, Return, Snapshot, Vca } from "../../../engine/audio/project/types";
import { MAX_BUSES } from "../../../engine/audio/settings";
import { uniqueName } from "../../../engine/core/uniqueName";
import type { EditResult } from "../../../plugins/audio/editor/editResult";

export type { EditResult };

/** What a name in the mix is. */
export type MixItemKind = "bus" | "return" | "vca";

/** The master bus: the root of the tree (the first bus). */
export const masterOf = (p: Pick<AudioProject, "buses">): string => p.buses[0]?.name ?? "Master";

/** The kind of the mix item named `name`, or null. */
export function kindOf(p: Pick<AudioProject, "buses" | "returns" | "vcas">, name: string): MixItemKind | null {
  if (p.buses.some((b) => b.name === name)) return "bus";
  if (p.returns.some((r) => r.name === name)) return "return";
  if (p.vcas.some((v) => v.name === name)) return "vca";
  return null;
}

/** Every name in the mix's one namespace. */
export const takenNames = (p: Pick<AudioProject, "buses" | "returns" | "vcas">): string[] => [...p.buses.map((b) => b.name), ...p.returns.map((r) => r.name), ...p.vcas.map((v) => v.name)];

export const busOf = (p: Pick<AudioProject, "buses">, name: string): Bus | undefined => p.buses.find((b) => b.name === name);
export const returnOf = (p: Pick<AudioProject, "returns">, name: string): Return | undefined => p.returns.find((r) => r.name === name);

/** A bus's ancestors, nearest first (cycle-safe). */
export function ancestorsOf(p: Pick<AudioProject, "buses">, name: string): string[] {
  const out: string[] = [];
  const seen = new Set([name]);
  for (let parent = busOf(p, name)?.parent ?? null; parent !== null && !seen.has(parent); parent = busOf(p, parent)?.parent ?? null) {
    out.push(parent);
    seen.add(parent);
  }
  return out;
}

/** The buses directly under `name`, in list order. */
export const childrenOf = (p: Pick<AudioProject, "buses">, name: string): Bus[] => p.buses.filter((b) => b.parent === name);

/** Every bus below `name` (children first, then theirs), not `name` itself. */
export function descendantsOf(p: Pick<AudioProject, "buses">, name: string): string[] {
  const out: string[] = [];
  const walk = (n: string) => {
    for (const c of childrenOf(p, n)) {
      if (out.includes(c.name) || c.name === name) continue;
      out.push(c.name);
      walk(c.name);
    }
  };
  walk(name);
  return out;
}

/** A bus's display path, "SFX › Vehicles" (Master is "Master"; the path is display only, ADR 0330). */
export function busPath(p: Pick<AudioProject, "buses">, name: string): string {
  const master = masterOf(p);
  if (name === master) return name;
  return [...ancestorsOf(p, name).reverse().filter((a) => a !== master), name].join(" › ");
}

/** One row of the routing tree. */
export interface BusRow {
  readonly name: string;
  readonly depth: number;
  readonly parent: string | null;
  readonly hasChildren: boolean;
  /** The top-level branch it is in (Master's children), for the colour stripe; null for Master. */
  readonly branch: string | null;
}

/**
 * The buses in routing order (depth first, siblings in list order). With `collapsed`, the rows under a collapsed bus
 * are left out (the bus itself stays).
 */
export function routingRows(p: Pick<AudioProject, "buses">, collapsed: ReadonlySet<string> = new Set()): BusRow[] {
  const out: BusRow[] = [];
  const master = masterOf(p);
  const seen = new Set<string>();
  const walk = (name: string, depth: number, branch: string | null, hidden: boolean) => {
    if (seen.has(name)) return;
    seen.add(name);
    const bus = busOf(p, name);
    if (!bus) return;
    const kids = childrenOf(p, name);
    if (!hidden) out.push({ name, depth, parent: bus.parent, hasChildren: kids.length > 0, branch });
    for (const k of kids) walk(k.name, depth + 1, branch ?? k.name, hidden || collapsed.has(name));
  };
  walk(master, 0, null, false);
  return out;
}

/** Why `bus` can't be re-routed under `parent`, or null when it can (the prototype's three refusals, plus Master). */
export function whyNotReroute(p: Pick<AudioProject, "buses">, bus: string, parent: string): string | null {
  const b = busOf(p, bus);
  if (!b) return `there's no bus "${bus}"`;
  if (b.parent === null) return "Master can't be re-routed";
  if (!busOf(p, parent)) return `"${parent}" isn't a bus`;
  if (parent === bus) return `${bus} can't feed itself`;
  if (descendantsOf(p, bus).includes(parent)) return `${parent} is under ${bus}`;
  if (b.parent === parent) return `${bus} already feeds ${parent}`;
  return null;
}

const withBus = (p: AudioProject, name: string, change: (b: Bus) => Bus): AudioProject => ({ ...p, buses: p.buses.map((b) => (b.name === name ? change(b) : b)) });

/** `bus` re-routed under `parent` ("Re-route"). */
export function reroute(p: AudioProject, bus: string, parent: string): EditResult<AudioProject> {
  const why = whyNotReroute(p, bus, parent);
  if (why) return { refused: why };
  return { next: withBus(p, bus, (b) => ({ ...b, parent })) };
}

/** A new bus at unity inside `parent` (Master when `parent` isn't a bus), named "New bus" (numbered if taken). */
export function addBus(p: AudioProject, parent: string | null, base = "New bus"): EditResult<{ project: AudioProject; name: string }> {
  if (p.buses.length >= MAX_BUSES) return { refused: `a mix has at most ${MAX_BUSES} buses` };
  const under = parent !== null && busOf(p, parent) ? parent : masterOf(p);
  const name = uniqueName(base, takenNames(p));
  // After the parent's last descendant, so list order follows routing order.
  const block = [under, ...descendantsOf(p, under)];
  let at = 0;
  p.buses.forEach((b, i) => { if (block.includes(b.name)) at = i + 1; });
  const buses = [...p.buses];
  buses.splice(at, 0, newBus(name, under));
  return { next: { project: { ...p, buses }, name } };
}

/** A new return (into Master) with nothing on it. */
export function addReturn(p: AudioProject, base = "New return"): EditResult<{ project: AudioProject; name: string }> {
  if (p.returns.length >= MIX_LIMITS.returns) return { refused: `a mix has at most ${MIX_LIMITS.returns} returns` };
  const name = uniqueName(base, takenNames(p));
  return { next: { project: { ...p, returns: [...p.returns, { name, output: masterOf(p), volumeDb: 0, mute: false, effects: [] }] }, name } };
}

/** A new VCA with no members. */
export function addVca(p: AudioProject, base = "New VCA"): EditResult<{ project: AudioProject; name: string }> {
  if (p.vcas.length >= MIX_LIMITS.vcas) return { refused: `a mix has at most ${MIX_LIMITS.vcas} VCAs` };
  const name = uniqueName(base, takenNames(p));
  return { next: { project: { ...p, vcas: [...p.vcas, { name, volumeDb: 0, members: [] }] }, name } };
}

/** A VCA's members set to `members` (only buses; order kept, duplicates dropped). */
export function setVcaMembers(p: AudioProject, vca: string, members: readonly string[]): EditResult<AudioProject> {
  if (!p.vcas.some((v) => v.name === vca)) return { refused: `there's no VCA "${vca}"` };
  const bad = members.find((m) => !busOf(p, m));
  if (bad) return { refused: `"${bad}" isn't a bus` };
  const clean = [...new Set(members)];
  return { next: { ...p, vcas: p.vcas.map((v) => (v.name === vca ? { ...v, members: clean } : v)) } };
}

/** A return's output set to bus `output`. */
export function setReturnOutput(p: AudioProject, ret: string, output: string): EditResult<AudioProject> {
  if (!returnOf(p, ret)) return { refused: `there's no return "${ret}"` };
  if (!busOf(p, output)) return { refused: `"${output}" isn't a bus` };
  return { next: { ...p, returns: p.returns.map((r) => (r.name === ret ? { ...r, output } : r)) } };
}

// --- references inside audio.json -------------------------------------------------------------------------------------

const renameKeys = <V>(rec: Readonly<Record<string, V>>, from: string, to: string): Record<string, V> => {
  if (!(from in rec)) return rec as Record<string, V>;
  const out: Record<string, V> = {};
  for (const [k, v] of Object.entries(rec)) out[k === from ? to : k] = v;
  return out;
};

const renameTarget = (t: MixAutomation["target"], from: string, to: string): MixAutomation["target"] => (t === `send:${from}` ? `send:${to}` : t);

/** `p` with every reference to `from` (bus, return or VCA) renamed `to`, and the item itself (no checks). */
function renameEverywhere(p: AudioProject, from: string, to: string): AudioProject {
  const n = (x: string) => (x === from ? to : x);
  const fx = <T extends { effects: Bus["effects"] }>(o: T): T => (o.effects.some((e) => e.key === from) ? { ...o, effects: o.effects.map((e) => (e.key === from ? { ...e, key: to } : e)) } : o);
  return {
    ...p,
    buses: p.buses.map((b) => fx({ ...b, name: n(b.name), parent: b.parent === null ? null : n(b.parent), sends: b.sends.map((s) => ({ ...s, to: n(s.to) })) })),
    returns: p.returns.map((r) => fx({ ...r, name: n(r.name), output: n(r.output) })),
    vcas: p.vcas.map((v) => ({ ...v, name: n(v.name), members: v.members.map(n) })),
    automation: p.automation.map((a) => ({ ...a, on: n(a.on), target: renameTarget(a.target, from, to) })),
    ducking: p.ducking.map((d) => ({ ...d, target: n(d.target), trigger: n(d.trigger) })),
    snapshots: p.snapshots.map((s) => ({ ...s, buses: renameKeys(s.buses, from, to), effects: renameKeys(s.effects, from, to) })),
  };
}

/** Why `from` can't be renamed `to` (null when it can, or when the name is unchanged). */
export function whyNotRename(p: AudioProject, from: string, to: string): string | null {
  const kind = kindOf(p, from);
  if (!kind) return `there's nothing named "${from}"`;
  if (to.trim() === "") return "a name can't be empty";
  if (to !== to.trim()) return "a name can't start or end with a space";
  if (to === from) return null;
  if (kind === "bus" && from === masterOf(p)) return "Master keeps its name (scripts and new buses route to it)";
  if (takenNames(p).includes(to)) return `"${to}" is taken (names are unique across buses, returns and VCAs)`;
  return null;
}

/** `from` renamed `to`, with every reference in `audio.json` following ("Rename"). An unchanged name is no change. */
export function renameItem(p: AudioProject, from: string, to: string): EditResult<AudioProject> {
  const why = whyNotRename(p, from, to);
  if (why) return { refused: why };
  if (from === to) return { next: p };
  return { next: renameEverywhere(p, from, to) };
}

// --- deleting -----------------------------------------------------------------------------------------------------------

/** What deleting a bus, return or VCA takes with it (listed in the confirm dialog), and what it moves. */
export interface DeletePlan {
  readonly name: string;
  readonly kind: MixItemKind;
  /** Buses moving up to the deleted bus's parent. */
  readonly movedChildren: readonly string[];
  /** Where they (and returns that output here) go. */
  readonly newParent: string | null;
  /** Each thing that goes, as a line ("2 effects", "Send to Reverb", "Ducking: Dialogue ducks Music"). */
  readonly lines: readonly string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What deleting `name` would do; null when it can't be deleted (Master, or nothing by that name). */
export function planDelete(p: AudioProject, name: string): EditResult<DeletePlan> {
  const kind = kindOf(p, name);
  if (!kind) return { refused: `there's nothing named "${name}"` };
  const lines: string[] = [];
  let movedChildren: string[] = [];
  let newParent: string | null = null;
  if (kind === "bus") {
    const bus = busOf(p, name)!;
    if (bus.parent === null) return { refused: "Master can't be deleted" };
    newParent = bus.parent;
    movedChildren = childrenOf(p, name).map((b) => b.name);
    if (movedChildren.length > 0) lines.push(`${movedChildren.join(", ")} move${movedChildren.length === 1 ? "s" : ""} up to ${newParent}`);
    if (bus.effects.length > 0) lines.push(`Its ${plural(bus.effects.length, "effect")}`);
    for (const s of bus.sends) lines.push(`Its send to ${s.to}`);
    for (const r of p.returns.filter((x) => x.output === name)) lines.push(`Return ${r.name} plays into ${newParent} instead`);
  } else if (kind === "return") {
    const ret = returnOf(p, name)!;
    if (ret.effects.length > 0) lines.push(`Its ${plural(ret.effects.length, "effect")}`);
    const senders = p.buses.filter((b) => b.sends.some((s) => s.to === name)).map((b) => b.name);
    if (senders.length > 0) lines.push(`Sends to it from ${senders.join(", ")}`);
  } else {
    const vca = p.vcas.find((v) => v.name === name)!;
    if (vca.members.length > 0) lines.push(`Its offset on ${vca.members.join(", ")}`);
  }
  const autos = p.automation.filter((a) => a.on === name || a.target === `send:${name}`);
  if (autos.length > 0) lines.push(plural(autos.length, "automation lane"));
  for (const d of p.ducking.filter((x) => x.target === name || x.trigger === name)) lines.push(`Ducking: ${d.trigger} ducks ${d.target}`);
  const snaps = p.snapshots.filter((s) => name in s.buses || name in s.effects).map((s) => s.name);
  if (snaps.length > 0) lines.push(`Its levels in ${plural(snaps.length, "snapshot")} (${snaps.join(", ")})`);
  if (kind === "bus") {
    const vcas = p.vcas.filter((v) => v.members.includes(name)).map((v) => v.name);
    if (vcas.length > 0) lines.push(`Membership of ${vcas.join(", ")}`);
    const keyed = [...p.buses, ...p.returns].filter((o) => o.effects.some((e) => e.key === name)).map((o) => o.name);
    if (keyed.length > 0) lines.push(`Sidechain key on ${keyed.join(", ")} (left without a key)`);
  }
  return { next: { name, kind, movedChildren, newParent, lines } };
}

const dropKey = <V>(rec: Readonly<Record<string, V>>, key: string): Record<string, V> => {
  if (!(key in rec)) return rec as Record<string, V>;
  const out = { ...rec };
  delete out[key];
  return out;
};

/** `name` deleted with everything its plan lists ("Delete bus" / "Delete return" / "Delete VCA"). */
export function deleteItem(p: AudioProject, name: string): EditResult<AudioProject> {
  const planned = planDelete(p, name);
  if ("refused" in planned) return planned;
  const { kind, newParent } = planned.next;
  const unkey = <T extends { effects: Bus["effects"] }>(o: T): T =>
    o.effects.some((e) => e.key === name) ? { ...o, effects: o.effects.map((e) => (e.key === name ? (({ key: _k, ...rest }) => rest)(e) : e)) } : o;
  let buses = p.buses;
  let returns = p.returns;
  let vcas: Vca[] = p.vcas;
  if (kind === "bus") {
    buses = buses.filter((b) => b.name !== name).map((b) => (b.parent === name ? { ...b, parent: newParent } : b));
    returns = returns.map((r) => (r.output === name ? { ...r, output: newParent! } : r));
    vcas = vcas.map((v) => (v.members.includes(name) ? { ...v, members: v.members.filter((m) => m !== name) } : v));
    buses = buses.map(unkey);
    returns = returns.map(unkey);
  } else if (kind === "return") {
    returns = returns.filter((r) => r.name !== name);
    buses = buses.map((b) => (b.sends.some((s) => s.to === name) ? { ...b, sends: b.sends.filter((s) => s.to !== name) } : b));
  } else vcas = vcas.filter((v) => v.name !== name);
  const snapshots: Snapshot[] = p.snapshots.map((s) => (name in s.buses || name in s.effects ? { ...s, buses: dropKey(s.buses, name), effects: dropKey(s.effects, name) } : s));
  return {
    next: {
      ...p,
      buses,
      returns,
      vcas,
      automation: p.automation.filter((a) => a.on !== name && a.target !== `send:${name}`),
      ducking: p.ducking.filter((d) => d.target !== name && d.trigger !== name),
      snapshots,
    },
  };
}
