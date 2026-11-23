// The Mixer's value edits (ADR 0344; the prototype's Buses panel and Inspector, with its known bugs fixed): levels
// (a fader in a non-base snapshot edits that snapshot's offset, never the base level), mute, effect chains (with a
// snapshot's parameter overrides, and a removed effect's automation and overrides removed in the same edit), sends
// (a removed send's automation goes with it), ducking rules, automation lanes and snapshot triggers. Each edit returns
// `{ next } | { refused }`; the screen applies it as one labelled undo step of `audio.json`.
// Pure.
import { DEFAULT_SNAPSHOT_FADE_MS, MIX_LIMITS, vcaOffsetDb } from "../../../engine/audio/project/format";
import type { FaderGhost } from "../../components/faderModel";
import { clampDb } from "../../../engine/audio/project/gain";
import type { AudioProject, Bus, DuckingRule, MixAutomation, Return, Send, Snapshot, SnapshotStart } from "../../../engine/audio/project/types";
import type { Effect } from "../../../engine/audio/effects/types";
import type { Curve } from "../../../engine/core/curve";
import { busOf, kindOf, masterOf, returnOf, type EditResult } from "./busTree";

/** The undo label of an edit on `name` ("Set level · SFX"). */
export const labelOn = (label: string, name: string | null | undefined): string => (name ? `${label} · ${name}` : label);

/** The snapshot whose offsets faders edit: null when the base level is edited (no snapshot, or a base-mix snapshot). */
export function editedSnapshot(p: Pick<AudioProject, "snapshots">, editing: string | null): Snapshot | null {
  if (editing === null) return null;
  const s = p.snapshots.find((x) => x.name === editing);
  return s && s.start.kind !== "base" ? s : null;
}

/** A bus's or return's base level. */
const baseDbOf = (p: AudioProject, name: string): number | null => busOf(p, name)?.volumeDb ?? returnOf(p, name)?.volumeDb ?? null;

/** The level a fader shows for `name` while `editing`: the base level plus the snapshot's offset (VCAs: their level). */
export function shownLevel(p: AudioProject, name: string, editing: string | null): number {
  const vca = p.vcas.find((v) => v.name === name);
  if (vca) return vca.volumeDb;
  const base = baseDbOf(p, name) ?? 0;
  const snap = editedSnapshot(p, editing);
  return snap && name in snap.buses ? clampDb(base + snap.buses[name]!) : base;
}

/** The base level as the fader's ghost tick while a snapshot is edited (null otherwise, or for a VCA). */
export function baseGhost(p: AudioProject, name: string, editing: string | null): number | null {
  if (!editedSnapshot(p, editing) || kindOf(p, name) === "vca") return null;
  return baseDbOf(p, name);
}

/**
 * The ticks `name`'s fader draws while `editing` (D19): the level with its VCAs (a bus under a VCA that isn't at 0 dB)
 * and, while a non-base snapshot is edited, the base level. Both show at once.
 */
export function levelGhosts(p: AudioProject, name: string, editing: string | null): FaderGhost[] {
  const out: FaderGhost[] = [];
  const vca = kindOf(p, name) === "bus" ? vcaOffsetDb(p, name) : 0;
  if (vca !== 0) {
    const db = clampDb(shownLevel(p, name, editing) + vca);
    out.push({ kind: "vca", db, title: `With VCAs: ${db.toFixed(1)} dB` });
  }
  const base = baseGhost(p, name, editing);
  if (base !== null) out.push({ kind: "base", db: base, title: `Base level: ${base.toFixed(1)} dB` });
  return out;
}

const withSnapshot = (p: AudioProject, name: string, change: (s: Snapshot) => Snapshot): AudioProject => ({ ...p, snapshots: p.snapshots.map((s) => (s.name === name ? change(s) : s)) });

/**
 * Set the level a fader shows for `name` to `db` ("Set level", "Snapshot level", "VCA level"): with a non-base
 * snapshot edited, its offset becomes `db − base` (held to the dB range); otherwise the base level (or the VCA's).
 */
export function setLevel(p: AudioProject, name: string, db: number, editing: string | null): EditResult<AudioProject> {
  if (!Number.isFinite(db) && db !== -Infinity) return { refused: "the level must be a number" };
  const level = clampDb(db);
  const kind = kindOf(p, name);
  if (!kind) return { refused: `there's nothing named "${name}"` };
  if (kind === "vca") {
    return { next: { ...p, vcas: p.vcas.map((v) => (v.name === name ? { ...v, volumeDb: level } : v)) } };
  }
  const snap = editedSnapshot(p, editing);
  if (snap) {
    const offset = Math.round(clampDb(level - (baseDbOf(p, name) ?? 0)) * 1000) / 1000;
    if (snap.buses[name] === offset) return { next: p };
    return { next: withSnapshot(p, snap.name, (s) => ({ ...s, buses: { ...s.buses, [name]: offset } })) };
  }
  if (kind === "bus") return { next: { ...p, buses: p.buses.map((b) => (b.name === name ? { ...b, volumeDb: level } : b)) } };
  return { next: { ...p, returns: p.returns.map((r) => (r.name === name ? { ...r, volumeDb: level } : r)) } };
}

/** The level edit's undo label for `name`. */
export function levelLabel(p: AudioProject, name: string, editing: string | null): string {
  if (kindOf(p, name) === "vca") return labelOn("VCA level", name);
  return labelOn(editedSnapshot(p, editing) ? "Snapshot level" : "Set level", name);
}

/** A snapshot's offset for `name` removed ("Clear offset"). */
export function clearOffset(p: AudioProject, snapshot: string, name: string): EditResult<AudioProject> {
  const s = p.snapshots.find((x) => x.name === snapshot);
  if (!s) return { refused: `there's no snapshot "${snapshot}"` };
  if (!(name in s.buses)) return { next: p };
  const buses = { ...s.buses };
  delete buses[name];
  return { next: withSnapshot(p, snapshot, (x) => ({ ...x, buses })) };
}

/** A bus's or return's mute ("Mute" / "Unmute"). Mute silences it and its sends (ADR 0344). */
export function setMute(p: AudioProject, name: string, mute: boolean): EditResult<AudioProject> {
  if (busOf(p, name)) return { next: { ...p, buses: p.buses.map((b) => (b.name === name && b.mute !== mute ? { ...b, mute } : b)) } };
  if (returnOf(p, name)) return { next: { ...p, returns: p.returns.map((r) => (r.name === name && r.mute !== mute ? { ...r, mute } : r)) } };
  return { refused: `there's nothing named "${name}" to mute` };
}

// --- effects ------------------------------------------------------------------------------------------------------------

type Owner = Bus | Return;
const ownerOf = (p: AudioProject, name: string): Owner | undefined => busOf(p, name) ?? returnOf(p, name);

/** An owner's chain as shown while `editing`: the base effects with the edited snapshot's parameter overrides in. */
export function shownEffects(p: AudioProject, name: string, editing: string | null): Effect[] {
  const owner = ownerOf(p, name);
  if (!owner) return [];
  const over = editedSnapshot(p, editing)?.effects[name];
  if (!over) return owner.effects;
  return owner.effects.map((e) => (over[e.id] ? { ...e, params: { ...e.params, ...over[e.id] } } : e));
}

/** The parameters `next` changes against `shown`, when that's all it changes (same effects, order, on and keys); else null. */
function paramOnlyChanges(shown: readonly Effect[], next: readonly Effect[]): { id: string; param: string; value: number }[] | null {
  if (shown.length !== next.length) return null;
  const out: { id: string; param: string; value: number }[] = [];
  for (let i = 0; i < shown.length; i++) {
    const a = shown[i]!, b = next[i]!;
    if (a.id !== b.id || a.type !== b.type || a.on !== b.on || a.key !== b.key) return null;
    for (const k of new Set([...Object.keys(a.params), ...Object.keys(b.params)])) if (a.params[k] !== b.params[k] && b.params[k] !== undefined) out.push({ id: b.id, param: k, value: b.params[k]! });
  }
  return out;
}

/** `p` without automation of, and snapshot overrides on, the effects of `name` that aren't in `kept`. */
function dropEffectRefs(p: AudioProject, name: string, kept: readonly Effect[]): AudioProject {
  const ids = new Set(kept.map((e) => e.id));
  const gone = (id: string) => !ids.has(id);
  const automation = p.automation.filter((a) => !(a.on === name && a.target.startsWith("fx:") && gone(a.target.split(":")[1]!)));
  const snapshots = p.snapshots.map((s) => {
    const byId = s.effects[name];
    if (!byId || !Object.keys(byId).some(gone)) return s;
    const kept2 = Object.fromEntries(Object.entries(byId).filter(([id]) => !gone(id)));
    const effects = { ...s.effects };
    if (Object.keys(kept2).length > 0) effects[name] = kept2;
    else delete effects[name];
    return { ...s, effects };
  });
  return { ...p, automation: automation.length === p.automation.length ? p.automation : automation, snapshots };
}

/**
 * An edit of the chain on `name` (from `EffectChain`, made against `shownEffects`). With a non-base snapshot edited, a
 * change of parameter values only writes the snapshot's overrides (owner decision: snapshots hold any bus effect
 * parameter); anything else (add, remove, reorder, bypass, key) edits the base chain. Removing an effect removes its
 * automation and every snapshot override of it in the same edit.
 */
export function editEffects(p: AudioProject, name: string, result: EditResult<Effect[]>, editing: string | null): EditResult<AudioProject> {
  if ("refused" in result) return result;
  const owner = ownerOf(p, name);
  if (!owner) return { refused: `there's no bus or return "${name}"` };
  const shown = shownEffects(p, name, editing);
  if (result.next === shown) return { next: p };
  const snap = editedSnapshot(p, editing);
  if (snap) {
    const changes = paramOnlyChanges(shown, result.next);
    if (changes) {
      if (changes.length === 0) return { next: p };
      return {
        next: withSnapshot(p, snap.name, (s) => {
          const byId = { ...(s.effects[name] ?? {}) };
          for (const c of changes) byId[c.id] = { ...(byId[c.id] ?? {}), [c.param]: c.value };
          return { ...s, effects: { ...s.effects, [name]: byId } };
        }),
      };
    }
    // A structural change: keep the base values of parameters the snapshot overrides.
    const over = snap.effects[name] ?? {};
    const base = new Map(owner.effects.map((e) => [e.id, e]));
    const unoverride = (e: Effect): Effect => {
      const o = over[e.id], b = base.get(e.id);
      if (!o || !b) return e;
      const params = { ...e.params };
      for (const k of Object.keys(o)) {
        if (b.params[k] === undefined) delete params[k];
        else params[k] = b.params[k]!;
      }
      return { ...e, params };
    };
    result = { next: result.next.map(unoverride) };
  }
  const effects = result.next;
  if (effects.length > MIX_LIMITS.effectsPerOwner) return { refused: `a bus holds at most ${MIX_LIMITS.effectsPerOwner} effects` };
  const changed: AudioProject = busOf(p, name)
    ? { ...p, buses: p.buses.map((b) => (b.name === name ? { ...b, effects } : b)) }
    : { ...p, returns: p.returns.map((r) => (r.name === name ? { ...r, effects } : r)) };
  return { next: dropEffectRefs(changed, name, effects) };
}

/** The overrides a snapshot holds on `name`'s effects: one row per parameter. */
export function overridesOn(p: AudioProject, snapshot: string, name: string): { id: string; param: string; value: number }[] {
  const byId = p.snapshots.find((s) => s.name === snapshot)?.effects[name] ?? {};
  return Object.entries(byId).flatMap(([id, ps]) => Object.entries(ps).map(([param, value]) => ({ id, param, value })));
}

/** A snapshot's override of `name`'s effect parameter removed ("Clear override"); without `param`, every override on that effect; without `id`, every override on `name`. */
export function clearOverride(p: AudioProject, snapshot: string, name: string, id?: string, param?: string): EditResult<AudioProject> {
  const s = p.snapshots.find((x) => x.name === snapshot);
  if (!s) return { refused: `there's no snapshot "${snapshot}"` };
  const byId = s.effects[name];
  if (!byId) return { next: p };
  const next: Record<string, Record<string, number>> = {};
  for (const [eid, ps] of Object.entries(byId)) {
    if (id !== undefined && eid !== id) { next[eid] = ps; continue; }
    if (id === undefined) continue;
    const kept = param === undefined ? {} : Object.fromEntries(Object.entries(ps).filter(([k]) => k !== param));
    if (Object.keys(kept).length > 0) next[eid] = kept;
  }
  const effects = { ...s.effects };
  if (Object.keys(next).length > 0) effects[name] = next;
  else delete effects[name];
  return { next: withSnapshot(p, snapshot, (x) => ({ ...x, effects })) };
}

// --- sends ---------------------------------------------------------------------------------------------------------------

/** The level a new send starts at. */
export const NEW_SEND_DB = -12;

/** A send from bus `name` to return `to` ("Edit send"). Refused from Master and for a second send to the same return. */
export function addSend(p: AudioProject, name: string, to: string): EditResult<AudioProject> {
  const bus = busOf(p, name);
  if (!bus) return { refused: `only a bus sends ("${name}" isn't one)` };
  if (name === masterOf(p)) return { refused: "Master can't send" };
  if (!returnOf(p, to)) return { refused: `"${to}" isn't a return` };
  if (bus.sends.some((s) => s.to === to)) return { refused: `${name} already sends to ${to}` };
  return { next: { ...p, buses: p.buses.map((b) => (b === bus ? { ...b, sends: [...b.sends, { to, levelDb: NEW_SEND_DB }] } : b)) } };
}

/** A send replaced by `send` (its level, from `SendRow`) ("Edit send"). */
export function editSend(p: AudioProject, name: string, result: EditResult<Send>): EditResult<AudioProject> {
  if ("refused" in result) return result;
  const bus = busOf(p, name);
  if (!bus || !bus.sends.some((s) => s.to === result.next.to)) return { refused: `${name} has no send to ${result.next.to}` };
  return { next: { ...p, buses: p.buses.map((b) => (b === bus ? { ...b, sends: b.sends.map((s) => (s.to === result.next.to ? result.next : s)) } : b)) } };
}

/** The send from `name` to `to` removed, with its automation ("Edit send"). */
export function removeSend(p: AudioProject, name: string, to: string): EditResult<AudioProject> {
  const bus = busOf(p, name);
  if (!bus || !bus.sends.some((s) => s.to === to)) return { refused: `${name} has no send to ${to}` };
  return {
    next: {
      ...p,
      buses: p.buses.map((b) => (b === bus ? { ...b, sends: b.sends.filter((s) => s.to !== to) } : b)),
      automation: p.automation.filter((a) => !(a.on === name && a.target === `send:${to}`)),
    },
  };
}

// --- ducking -------------------------------------------------------------------------------------------------------------

/** A new rule's values (the prototype's: while playing, −6 dB, 50 ms attack, 400 ms release, −20 dBFS threshold). */
export const NEW_DUCK: Omit<DuckingRule, "target" | "trigger"> = { mode: "presence", detector: "peak", thresholdDb: -20, amountDb: -6, attackMs: 50, releaseMs: 400, enabled: true };

/** A rule ducking `target` while `trigger` plays ("Edit ducking"). One rule per pair; never on itself or from Master. */
export function addDucking(p: AudioProject, target: string, trigger: string): EditResult<AudioProject> {
  if (!ownerOf(p, target)) return { refused: `"${target}" isn't a bus or return` };
  if (!ownerOf(p, trigger)) return { refused: `"${trigger}" isn't a bus or return` };
  if (target === trigger) return { refused: `${target} can't duck itself` };
  if (trigger === masterOf(p)) return { refused: "Master can't trigger ducking" };
  if (target === masterOf(p)) return { refused: "Master can't be ducked (it carries everything)" };
  if (p.ducking.some((d) => d.target === target && d.trigger === trigger)) return { refused: `${trigger} already ducks ${target}` };
  return { next: { ...p, ducking: [...p.ducking, { target, trigger, ...NEW_DUCK }] } };
}

/** The `index`-th rule replaced (from `DuckRow`) ("Edit ducking"). */
export function editDucking(p: AudioProject, index: number, result: EditResult<DuckingRule>): EditResult<AudioProject> {
  if ("refused" in result) return result;
  const old = p.ducking[index];
  if (!old) return { refused: "that ducking rule is gone" };
  if (result.next === old) return { next: p };
  const dup = p.ducking.some((d, i) => i !== index && d.target === result.next.target && d.trigger === result.next.trigger);
  if (dup) return { refused: `${result.next.trigger} already ducks ${result.next.target}` };
  return { next: { ...p, ducking: p.ducking.map((d, i) => (i === index ? result.next : d)) } };
}

/** The `index`-th rule removed ("Edit ducking"). */
export function removeDucking(p: AudioProject, index: number): EditResult<AudioProject> {
  if (!p.ducking[index]) return { refused: "that ducking rule is gone" };
  return { next: { ...p, ducking: p.ducking.filter((_, i) => i !== index) } };
}

/** The lint ADR 0344 asks for: buses ducked by both a ducking rule and a sidechain keyed on the same trigger. */
export function doubleDucks(p: AudioProject): { target: string; trigger: string }[] {
  const out: { target: string; trigger: string }[] = [];
  for (const d of p.ducking) {
    if (!d.enabled) continue;
    const owner = ownerOf(p, d.target);
    if (owner?.effects.some((e) => e.on && e.type === "sidechainCompressor" && e.key === d.trigger)) out.push({ target: d.target, trigger: d.trigger });
  }
  return out;
}

// --- automation ----------------------------------------------------------------------------------------------------------

/** An automation lane's identity: what it's on and what it drives. */
export interface AutomationTarget {
  readonly on: string;
  readonly target: MixAutomation["target"];
}

/** The lane for `t`, if any. */
export const automationOf = (p: Pick<AudioProject, "automation">, t: AutomationTarget): MixAutomation | undefined => p.automation.find((a) => a.on === t.on && a.target === t.target);

/**
 * The lane for `t` set ("Edit automation"): `lane` null removes it. A flat curve that isn't bypassed is removed too
 * (a flat curve is just the plain value, the prototype's rule).
 */
export function setAutomation(p: AudioProject, t: AutomationTarget, lane: { parameter: string; curve: Curve; bypass: boolean } | null): EditResult<AudioProject> {
  if (!ownerOf(p, t.on)) return { refused: `"${t.on}" isn't a bus or return` };
  const others = p.automation.filter((a) => !(a.on === t.on && a.target === t.target));
  const flat = lane !== null && !lane.bypass && lane.curve.length > 0 && lane.curve.every((k) => k[1] === lane.curve[0]![1]);
  if (lane === null || lane.curve.length === 0 || flat) return { next: others.length === p.automation.length ? p : { ...p, automation: others } };
  if (!p.parameters.some((q) => q.name === lane.parameter)) return { refused: `there's no game parameter "${lane.parameter}"` };
  const at = p.automation.findIndex((a) => a.on === t.on && a.target === t.target);
  const entry: MixAutomation = { on: t.on, target: t.target, parameter: lane.parameter, curve: lane.curve, bypass: lane.bypass };
  if (at < 0 && p.automation.length >= MIX_LIMITS.automation) return { refused: `a mix has at most ${MIX_LIMITS.automation} automation lanes` };
  return { next: { ...p, automation: at < 0 ? [...p.automation, entry] : p.automation.map((a, i) => (i === at ? entry : a)) } };
}

// --- snapshot triggers ---------------------------------------------------------------------------------------------------

/** What the Trigger dialog edits. */
export type TriggerPatch = Partial<Pick<Snapshot, "start" | "fadeInMs" | "fadeOutMs" | "holdMs" | "priority" | "combine">>;

const clampTo = (v: number, [lo, hi]: readonly [number, number], whole = false) => Math.min(hi, Math.max(lo, whole ? Math.round(v) : v));

/** A snapshot's trigger set ("Edit trigger"): times held to 0..60 s, priority to 0..100 (whole). */
export function setTrigger(p: AudioProject, name: string, patch: TriggerPatch): EditResult<AudioProject> {
  const s = p.snapshots.find((x) => x.name === name);
  if (!s) return { refused: `there's no snapshot "${name}"` };
  for (const k of ["fadeInMs", "fadeOutMs", "holdMs", "priority"] as const) {
    const v = patch[k];
    if (v !== undefined && !Number.isFinite(v)) return { refused: "times and the priority must be numbers" };
  }
  if (patch.start?.kind === "conditions") {
    for (const c of patch.start.conditions) if (!p.parameters.some((q) => q.name === c.parameter)) return { refused: `there's no game parameter "${c.parameter}"` };
  }
  const next: Snapshot = {
    ...s,
    ...(patch.start ? { start: structuredClone(patch.start) as SnapshotStart } : {}),
    fadeInMs: patch.fadeInMs !== undefined ? clampTo(patch.fadeInMs, MIX_LIMITS.snapshotMs) : s.fadeInMs,
    fadeOutMs: patch.fadeOutMs !== undefined ? clampTo(patch.fadeOutMs, MIX_LIMITS.snapshotMs) : s.fadeOutMs,
    holdMs: patch.holdMs !== undefined ? clampTo(patch.holdMs, MIX_LIMITS.snapshotMs) : s.holdMs,
    priority: patch.priority !== undefined ? clampTo(patch.priority, MIX_LIMITS.snapshotPriority, true) : s.priority,
    combine: patch.combine ?? s.combine,
  };
  if (JSON.stringify(next) === JSON.stringify(s)) return { next: p };
  return { next: withSnapshot(p, name, () => next) };
}

export { DEFAULT_SNAPSHOT_FADE_MS };
