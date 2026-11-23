/**
 * Internal (ADR 0344 "Live mixing"): the live ops of the mix model that the old section shape can't express — returns,
 * VCAs, mute of a bus or a return, sends, and snapshot edits — applied to an `AudioProject`. They are `MixOp`s (the
 * union in `mixOps.ts`), so they travel the same path as the others: `mixer.apply(op)` checks them here
 * (`projectOpRefusal`), applies them to its model (`applyOpToProject`) and sends what changed of the backends' view
 * (`coreSectionOf`) as the old ops; the capture stores them (`mixOpCodec.ts`).
 *
 * - `setMute`: a bus's or a return's mute (a bus's is also `setBus` `mute`); mute silences the bus and its sends.
 * - `setReturn`: a return created, replaced (`from` names it when it is renamed: every send, snapshot entry, automation
 *   and ducking rule that names it follows) or removed (`ret` null: the sends to it go too).
 * - `setSend`: a bus's send to a return, at `levelDb`, or removed (null).
 * - `setVca`: a VCA created, replaced (renamed with `from`) or removed (`vca` null).
 * - `setSnapshotDef`: a snapshot created, replaced (renamed with `from`) or removed (`snapshot` null).
 * - `setSnapshotLevel`: one bus's or return's offset in a snapshot (null: unlisted).
 * - `setSnapshotEffect`: one effect parameter's override in a snapshot (null: no override).
 * - `setOcclusionCurves` (ADR 0362 item 6): the project's occlusion curves (`settings.occlusion.curves`; null: none,
 *   the materials' losses as they are). The one engine setting with a live path: the occlusion pass reads it each frame.
 *
 * Pure; no plugin, no DOM.
 */
import { audioProjectToJson, MIX_LIMITS, parseAudioProject } from "./project/format";
import { clampDb } from "./project/gain";
import type { AudioProject, Return, Snapshot, Vca } from "./project/types";
import { parseOcclusionCurves, sameOcclusionCurves, type OcclusionCurves } from "./occlusionCurves";

export type ProjectMixOp =
  | { op: "setMute"; name: string; value: boolean }
  | { op: "setReturn"; name: string; ret: Return | null; from?: string }
  | { op: "setSend"; bus: string; to: string; levelDb: number | null }
  | { op: "setVca"; name: string; vca: Vca | null; from?: string }
  | { op: "setSnapshotDef"; name: string; snapshot: Snapshot | null; from?: string }
  | { op: "setSnapshotLevel"; snapshot: string; target: string; db: number | null }
  | { op: "setSnapshotEffect"; snapshot: string; target: string; effect: string; param: string; value: number | null }
  | { op: "setOcclusionCurves"; curves: OcclusionCurves | null };

/** The project op names, in the byte form's order after the old ops (`MIX_OP_NAMES` appends them). */
export const PROJECT_OP_NAMES = ["setMute", "setReturn", "setSend", "setVca", "setSnapshotDef", "setSnapshotLevel", "setSnapshotEffect", "setOcclusionCurves"] as const satisfies readonly ProjectMixOp["op"][];

/** Whether `op` is one of the mix model's own ops (this module's), not one of the old section's. */
export const isProjectOp = (op: { op: string }): op is ProjectMixOp => (PROJECT_OP_NAMES as readonly string[]).includes(op.op);

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nameOk = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const busOf = (p: AudioProject, name: string) => p.buses.find((b) => b.name === name);
const returnOf = (p: AudioProject, name: string) => p.returns.find((r) => r.name === name);
const ownerOf = (p: AudioProject, name: string) => busOf(p, name) ?? returnOf(p, name);
/** Every name in the project's one namespace (buses, returns, VCAs), but `except`. */
const takenNames = (p: AudioProject, except?: string) => new Set([...p.buses, ...p.returns, ...p.vcas].map((x) => x.name).filter((n) => n !== except));

/** Why `op` can't apply to `project`, or null when it applies (it may still change nothing). */
export function projectOpRefusal(p: AudioProject, op: ProjectMixOp): string | null {
  switch (op.op) {
    case "setMute":
      if (!ownerOf(p, op.name)) return `No bus or return named "${op.name}".`;
      return typeof op.value === "boolean" ? null : "A mute must be true or false.";
    case "setReturn": {
      const old = op.from ?? op.name;
      if (op.ret === null) return returnOf(p, op.name) ? null : `No return named "${op.name}".`;
      if (op.from !== undefined && !returnOf(p, op.from)) return `No return named "${op.from}".`;
      if (!nameOk(op.ret.name) || op.ret.name !== op.name) return "A return needs a name (the op's name).";
      if (takenNames(p, returnOf(p, old) ? old : undefined).has(op.name)) return `Another bus, return or VCA is already named "${op.name}".`;
      if (!returnOf(p, old) && p.returns.length >= MIX_LIMITS.returns) return `At most ${MIX_LIMITS.returns} returns.`;
      if (!busOf(p, op.ret.output)) return `A return's output must be a bus; there is no bus named "${op.ret.output}".`;
      if (!finite(op.ret.volumeDb)) return "A return's level must be a number of dB.";
      return null;
    }
    case "setSend": {
      const bus = busOf(p, op.bus);
      if (!bus) return `No bus named "${op.bus}".`;
      if (bus.parent === null) return `${op.bus} is the master bus and can't send.`;
      if (!returnOf(p, op.to)) return `No return named "${op.to}".`;
      return op.levelDb === null || finite(op.levelDb) ? null : "A send level must be a number of dB or unset.";
    }
    case "setVca": {
      const old = op.from ?? op.name;
      if (op.vca === null) return p.vcas.some((v) => v.name === op.name) ? null : `No VCA named "${op.name}".`;
      if (op.from !== undefined && !p.vcas.some((v) => v.name === op.from)) return `No VCA named "${op.from}".`;
      if (!nameOk(op.vca.name) || op.vca.name !== op.name) return "A VCA needs a name (the op's name).";
      const exists = p.vcas.some((v) => v.name === old);
      if (takenNames(p, exists ? old : undefined).has(op.name)) return `Another bus, return or VCA is already named "${op.name}".`;
      if (!exists && p.vcas.length >= MIX_LIMITS.vcas) return `At most ${MIX_LIMITS.vcas} VCAs.`;
      if (!finite(op.vca.volumeDb)) return "A VCA's level must be a number of dB.";
      const stranger = op.vca.members.find((m) => !busOf(p, m));
      return stranger === undefined ? null : `A VCA's members must be buses; there is no bus named "${stranger}".`;
    }
    case "setSnapshotDef": {
      const old = op.from ?? op.name;
      if (op.snapshot === null) return p.snapshots.some((s) => s.name === op.name) ? null : `No snapshot named "${op.name}".`;
      if (op.from !== undefined && !p.snapshots.some((s) => s.name === op.from)) return `No snapshot named "${op.from}".`;
      if (!nameOk(op.snapshot.name) || op.snapshot.name !== op.name) return "A snapshot needs a name (the op's name).";
      const exists = p.snapshots.some((s) => s.name === old);
      if (p.snapshots.some((s) => s.name === op.name && s.name !== old)) return `Another snapshot is already named "${op.name}".`;
      return !exists && p.snapshots.length >= MIX_LIMITS.snapshots ? `At most ${MIX_LIMITS.snapshots} snapshots.` : null;
    }
    case "setSnapshotLevel":
      if (!p.snapshots.some((s) => s.name === op.snapshot)) return `No snapshot named "${op.snapshot}".`;
      if (!ownerOf(p, op.target)) return `No bus or return named "${op.target}".`;
      return op.db === null || finite(op.db) ? null : "A snapshot level must be a number of dB or unset.";
    case "setSnapshotEffect": {
      if (!p.snapshots.some((s) => s.name === op.snapshot)) return `No snapshot named "${op.snapshot}".`;
      const owner = ownerOf(p, op.target);
      if (!owner) return `No bus or return named "${op.target}".`;
      if (!owner.effects.some((e) => e.id === op.effect)) return `${op.target} has no effect "${op.effect}".`;
      if (!nameOk(op.param)) return "An override needs a parameter name.";
      return op.value === null || finite(op.value) ? null : "An override must be a number or unset.";
    }
    case "setOcclusionCurves": {
      if (op.curves === null) return null;
      const problems: string[] = [];
      parseOcclusionCurves(op.curves, "curves", problems);
      return problems.length === 0 ? null : `Occlusion curves: ${problems[0]}`;
    }
  }
}

/** `p` with its occlusion curves set (`null` or an empty set: none). */
export function withOcclusionCurves(p: AudioProject, curves: OcclusionCurves | null): AudioProject {
  const { curves: _drop, ...occ } = p.settings.occlusion;
  const keep = curves && (curves.volume || curves.lowpass) ? structuredClone(curves) : null;
  return { ...p, settings: { ...p.settings, occlusion: keep ? { ...occ, curves: keep } : occ } };
}

/** `p` with every reference to `from` (a return, VCA or snapshot name of `kind`) renamed to `to`. */
function renamed(p: AudioProject, kind: "return" | "vca" | "snapshot", from: string, to: string): AudioProject {
  if (from === to) return p;
  const r = (n: string) => (n === from ? to : n);
  const rekey = <T>(rec: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(rec).map(([k, v]) => [r(k), v]));
  if (kind === "snapshot") return { ...p, snapshots: p.snapshots.map((s) => (s.name === from ? { ...s, name: to } : s)) };
  if (kind === "vca") return { ...p, vcas: p.vcas.map((v) => (v.name === from ? { ...v, name: to } : v)) };
  return {
    ...p,
    returns: p.returns.map((x) => (x.name === from ? { ...x, name: to } : x)),
    buses: p.buses.map((b) => ({ ...b, sends: b.sends.map((s) => ({ ...s, to: r(s.to) })) })),
    automation: p.automation.map((a) => ({ ...a, on: r(a.on), target: a.target === `send:${from}` ? (`send:${to}` as const) : a.target })),
    ducking: p.ducking.map((d) => ({ ...d, target: r(d.target), trigger: r(d.trigger) })),
    snapshots: p.snapshots.map((s) => ({ ...s, buses: rekey(s.buses), effects: rekey(s.effects) })),
  };
}

/** Upsert or remove a named entry of a list, keeping its place. */
function upsert<T extends { name: string }>(list: readonly T[], name: string, item: T | null): T[] {
  if (item === null) return list.filter((x) => x.name !== name);
  const i = list.findIndex((x) => x.name === name);
  return i < 0 ? [...list, structuredClone(item)] : list.map((x, j) => (j === i ? structuredClone(item) : x));
}

/** Whether two projects say the same thing (their file form). */
const sameProject = (a: AudioProject, b: AudioProject): boolean => JSON.stringify(audioProjectToJson(a)) === JSON.stringify(audioProjectToJson(b));

/**
 * `p` after `op`, normalised through the file's parse (a reference the edit left dangling is dropped as the file would
 * drop it); `p` itself (the same object) when the op is refused or changes nothing.
 */
export function applyOpToProject(p: AudioProject, op: ProjectMixOp): AudioProject {
  if (projectOpRefusal(p, op) !== null) return p;
  // An engine setting, not the mix: the file's mix parse doesn't touch it.
  if (op.op === "setOcclusionCurves") return sameOcclusionCurves(p.settings.occlusion.curves, op.curves ?? undefined) ? p : withOcclusionCurves(p, op.curves);
  let next: AudioProject;
  switch (op.op) {
    case "setMute":
      next = busOf(p, op.name)
        ? { ...p, buses: p.buses.map((b) => (b.name === op.name ? { ...b, mute: op.value } : b)) }
        : { ...p, returns: p.returns.map((r) => (r.name === op.name ? { ...r, mute: op.value } : r)) };
      break;
    case "setReturn": {
      const base = op.from !== undefined ? renamed(p, "return", op.from, op.name) : p;
      next = { ...base, returns: upsert(base.returns, op.name, op.ret && { ...op.ret, volumeDb: clampDb(op.ret.volumeDb) }) };
      break;
    }
    case "setSend":
      next = {
        ...p,
        buses: p.buses.map((b) => {
          if (b.name !== op.bus) return b;
          const i = b.sends.findIndex((s) => s.to === op.to);
          if (op.levelDb === null) return { ...b, sends: b.sends.filter((s) => s.to !== op.to) };
          const send = { to: op.to, levelDb: clampDb(op.levelDb) };
          return { ...b, sends: i < 0 ? [...b.sends, send] : b.sends.map((s, j) => (j === i ? send : s)) };
        }),
      };
      break;
    case "setVca": {
      const base = op.from !== undefined ? renamed(p, "vca", op.from, op.name) : p;
      next = { ...base, vcas: upsert(base.vcas, op.name, op.vca && { ...op.vca, volumeDb: clampDb(op.vca.volumeDb), members: [...new Set(op.vca.members)] }) };
      break;
    }
    case "setSnapshotDef": {
      const base = op.from !== undefined ? renamed(p, "snapshot", op.from, op.name) : p;
      next = { ...base, snapshots: upsert(base.snapshots, op.name, op.snapshot) };
      break;
    }
    case "setSnapshotLevel":
      next = {
        ...p,
        snapshots: p.snapshots.map((s) => {
          if (s.name !== op.snapshot) return s;
          const buses = { ...s.buses };
          if (op.db === null) delete buses[op.target];
          else buses[op.target] = clampDb(op.db);
          return { ...s, buses };
        }),
      };
      break;
    case "setSnapshotEffect":
      next = {
        ...p,
        snapshots: p.snapshots.map((s) => {
          if (s.name !== op.snapshot) return s;
          const effects = structuredClone(s.effects);
          const byId = (effects[op.target] ??= {});
          const params = (byId[op.effect] ??= {});
          if (op.value === null) delete params[op.param];
          else params[op.param] = op.value;
          if (Object.keys(params).length === 0) delete byId[op.effect];
          if (Object.keys(byId).length === 0) delete effects[op.target];
          return { ...s, effects };
        }),
      };
      break;
  }
  const out = { ...parseAudioProject(audioProjectToJson(next)).project, settings: p.settings };
  return sameProject(out, p) ? p : out;
}

/** The ops that undo `op` on `before` (empty when it is refused or changes nothing). */
export function invertProjectOp(op: ProjectMixOp, before: AudioProject): ProjectMixOp[] {
  if (applyOpToProject(before, op) === before) return [];
  switch (op.op) {
    case "setMute": return [{ op: "setMute", name: op.name, value: ownerOf(before, op.name)!.mute }];
    case "setReturn": {
      const old = op.from ?? op.name;
      const was = returnOf(before, old);
      if (!was) return [{ op: "setReturn", name: op.name, ret: null }];
      // Removing a return drops the sends to it: they come back with it.
      const sends = op.ret === null ? before.buses.flatMap((b) => b.sends.filter((s) => s.to === old).map((s): ProjectMixOp => ({ op: "setSend", bus: b.name, to: old, levelDb: s.levelDb }))) : [];
      return [{ op: "setReturn", name: old, ret: structuredClone(was), ...(op.from !== undefined ? { from: op.name } : {}) }, ...sends];
    }
    case "setSend": return [{ op: "setSend", bus: op.bus, to: op.to, levelDb: busOf(before, op.bus)!.sends.find((s) => s.to === op.to)?.levelDb ?? null }];
    case "setVca": {
      const old = op.from ?? op.name;
      const was = before.vcas.find((v) => v.name === old);
      return [was ? { op: "setVca", name: old, vca: structuredClone(was), ...(op.from !== undefined ? { from: op.name } : {}) } : { op: "setVca", name: op.name, vca: null }];
    }
    case "setSnapshotDef": {
      const old = op.from ?? op.name;
      const was = before.snapshots.find((s) => s.name === old);
      return [was ? { op: "setSnapshotDef", name: old, snapshot: structuredClone(was), ...(op.from !== undefined ? { from: op.name } : {}) } : { op: "setSnapshotDef", name: op.name, snapshot: null }];
    }
    case "setSnapshotLevel": return [{ ...op, db: before.snapshots.find((s) => s.name === op.snapshot)!.buses[op.target] ?? null }];
    case "setSnapshotEffect": return [{ ...op, value: before.snapshots.find((s) => s.name === op.snapshot)!.effects[op.target]?.[op.effect]?.[op.param] ?? null }];
    case "setOcclusionCurves": return [{ op: "setOcclusionCurves", curves: before.settings.occlusion.curves ? structuredClone(before.settings.occlusion.curves) : null }];
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The project ops that move `before`'s returns, VCAs, sends, return mutes and snapshots to `after`'s, in an order that
 * applies (returns before the sends to them, sends removed before their return). Renames show as a removal and an
 * addition. What the old ops express (the bus tree, bus levels and mutes, bus effects, ducking, automation, loudness) is
 * `diffOps`' (`mixOps.ts`), over the backends' view (`diffProjectMix` in `mixOps.ts` puts both together).
 */
export function diffProjectOps(before: AudioProject, after: AudioProject): ProjectMixOp[] {
  const ops: ProjectMixOp[] = [];
  const afterReturns = new Set(after.returns.map((r) => r.name));
  // Sends that go while their bus and return stay, first (a removed return takes its sends with it).
  for (const b of before.buses) {
    const now = busOf(after, b.name);
    if (!now) continue;
    for (const s of b.sends) if (afterReturns.has(s.to) && !now.sends.some((x) => x.to === s.to)) ops.push({ op: "setSend", bus: b.name, to: s.to, levelDb: null });
  }
  for (const r of before.returns) if (!afterReturns.has(r.name)) ops.push({ op: "setReturn", name: r.name, ret: null });
  for (const r of after.returns) {
    const was = returnOf(before, r.name);
    if (!was || !same(was, r)) ops.push({ op: "setReturn", name: r.name, ret: structuredClone(r) });
  }
  for (const b of after.buses) {
    const was = busOf(before, b.name);
    for (const s of b.sends) {
      const old = was?.sends.find((x) => x.to === s.to);
      if (!old || old.levelDb !== s.levelDb) ops.push({ op: "setSend", bus: b.name, to: s.to, levelDb: s.levelDb });
    }
  }
  const afterVcas = new Set(after.vcas.map((v) => v.name));
  for (const v of before.vcas) if (!afterVcas.has(v.name)) ops.push({ op: "setVca", name: v.name, vca: null });
  for (const v of after.vcas) {
    const was = before.vcas.find((x) => x.name === v.name);
    if (!was || !same(was, v)) ops.push({ op: "setVca", name: v.name, vca: structuredClone(v) });
  }
  const afterSnaps = new Set(after.snapshots.map((s) => s.name));
  for (const s of before.snapshots) if (!afterSnaps.has(s.name)) ops.push({ op: "setSnapshotDef", name: s.name, snapshot: null });
  for (const s of after.snapshots) {
    const was = before.snapshots.find((x) => x.name === s.name);
    if (!was || !same(was, s)) ops.push({ op: "setSnapshotDef", name: s.name, snapshot: structuredClone(s) });
  }
  const curves = after.settings.occlusion.curves;
  if (!sameOcclusionCurves(before.settings.occlusion.curves, curves)) ops.push({ op: "setOcclusionCurves", curves: curves ? structuredClone(curves) : null });
  return ops;
}
