/**
 * Internal (ADR 0330): the old `audio` section of `project.json` and `audio.json`.
 *
 * - `fromLegacySection(section)` is the migration: volumes to dB, the `reverb` send effect to sends into a created
 *   "Reverb" return, snapshot multipliers to dB offsets, a snapshot low-pass to an override of a low-pass created on that
 *   bus (open at 20 kHz outside the snapshot), bus automation to `volume` or `fx:<low-pass>:cutoff` targets.
 * - `mergeLegacyIntoProject(project, section)` writes an edit of the backends' view (`coreSectionOf(project)`,
 *   `runtimeView.ts`, the old section shape with levels without VCAs) back into `project`: the runtime's mixer lifts a
 *   live op of the old shape with it (`Mixer._applyLive`). It keeps what the old shape can't express (more returns,
 *   VCAs, effects the runtime doesn't run, snapshot triggers and effect overrides, disabled rules, bypassed automation).
 *   Whatever is unchanged in the view keeps its exact value, so `mergeLegacyIntoProject(p, coreSectionOf(p))` is `p`.
 *   (The editor's legacy panels wrote through it with a VCA-folded view until the Audio Studio replaced them, D2.)
 *
 * Pure; no plugin, no DOM.
 */
import type { Curve, CurveKey } from "../../core/curve";
import { uniqueName } from "../../core/uniqueName";
import { defaultEffect } from "../effects/catalogue";
import type { Effect } from "../effects/types";
import {
  DEFAULT_LOUDNESS_TARGETS, busBed, busBedPriority, parseAudioSettings,
  type AudioSettings, type BusAutomation, type BusEffect, type BusSettings, type DuckingRule as RuntimeDuckingRule,
} from "../settings";
import {
  DEFAULT_SNAPSHOT_FADE_MS, DEFAULT_SNAPSHOT_PRIORITY, audioProjectToJson, defaultAudioProject, engineSettingsOf, freeEffectId, newBus,
  parseAudioProject,
} from "./format";
import { coreSectionOf, reverbSendOf, sectionReturnsOf } from "./runtimeView";
import { levelDbOf } from "./gain";
import { OPEN_CUTOFF, isCarrier, msOf, paramsOf, updatedParams } from "./legacyEffects";
import { coreBusEffect, coreShown } from "./runtimeView";
import type { AudioEngineSettings, AudioProject, Bus, DuckingRule, MixAutomation, Return, Snapshot } from "./types";

/** The name the migration gives the return that replaces the old shared reverb. */
export const REVERB_RETURN = "Reverb";

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function newSnapshot(name: string): Snapshot {
  return { name, folder: "", start: { kind: "code" }, fadeInMs: DEFAULT_SNAPSHOT_FADE_MS, fadeOutMs: DEFAULT_SNAPSHOT_FADE_MS, holdMs: 0, priority: DEFAULT_SNAPSHOT_PRIORITY, combine: "override", buses: {}, effects: {} };
}

const curveToDb = (curve: Curve): CurveKey[] => curve.map((k) => (k.length === 3 ? [k[0], levelDbOf(k[1], 0, false), k[2]] : [k[0], levelDbOf(k[1], 0, false)]) as CurveKey);

/** A bus's bed in the new shape, from the old `bed` and `bedPriority` (defaults applied). */
function bedOf(a: Pick<AudioSettings, "buses">, name: string, root: boolean): Bus["bed"] {
  const priority = busBedPriority(a, name);
  if (root) return { own: true, priority };
  const bed = busBed(a, name);
  return bed === "own" ? { own: true, priority } : bed === "none" ? { own: false, priority } : null;
}

function reverbEffect(): Effect {
  // A return is fully wet (the send sets how much of a bus reaches it), as Wwise, FMOD and every DAW set a return reverb.
  const fx = defaultEffect("reverb", "fx1");
  fx.params.mix = 100;
  return fx;
}

/** A new low-pass carrier on `bus` (open, so neutral until a snapshot or automation moves it). */
function addCarrier(bus: Pick<Bus, "effects">): string {
  const id = freeEffectId(bus.effects.map((e) => e.id));
  bus.effects.push({ id, type: "lowpass", on: true, params: paramsOf({ type: "lowpass", frequency: OPEN_CUTOFF, q: 1 }) });
  return id;
}

const duckingFrom = (r: RuntimeDuckingRule): DuckingRule => ({
  target: r.target, trigger: r.trigger, mode: r.mode ?? "presence", detector: r.detector ?? "rms", thresholdDb: r.threshold ?? -30,
  amountDb: Math.min(0, levelDbOf(r.amount)), attackMs: msOf(r.attack), releaseMs: msOf(r.release), enabled: true,
});

/** The migration of an old `audio` section (as `project.json` held it) to `audio.json`. Problems of the old section's parse go to `problems`. */
export function fromLegacySection(section: unknown, problems: string[] = []): AudioProject {
  const parsed = parseAudioSettings(section);
  problems.push(...parsed.problems);
  const a = parsed.settings;
  const project = defaultAudioProject();
  project.settings = engineSettingsOf(a);
  project.parameters = structuredClone(a.parameters);
  const reverbName = uniqueName(REVERB_RETURN, a.buses.map((b) => b.name));
  let usesReverb = false;
  // ADR 0330: a section with `sends` (a backends' view handed back, `coreSectionOf`): each bus a send names, with no bus
  // under it, is a return again (its parent the output).
  const targets = new Set(a.buses.flatMap((b) => (b.sends ?? []).map((s) => s.to)));
  const asReturn = new Set(a.buses.filter((b, i) => i > 0 && targets.has(b.name) && !a.buses.some((o) => o.parent === b.name)).map((b) => b.name));
  /** The catalogue effects of a section bus's chain (the reverb send effect aside). */
  const effectsOf = (b: BusSettings): Effect[] => {
    const out: Effect[] = [];
    for (const e of b.effects) {
      if (e.type === "fx") out.push({ id: freeEffectId(out.map((x) => x.id)), type: e.fx, on: true, params: { ...e.params }, ...(e.key ? { key: e.key } : {}) });
      else if (e.type !== "reverb") out.push({ id: freeEffectId(out.map((x) => x.id)), type: e.type, on: true, params: paramsOf(e) });
    }
    return out;
  };
  project.buses = a.buses.filter((b) => !asReturn.has(b.name)).map((b, i) => {
    const root = i === 0;
    const bus: Bus = { ...newBus(b.name, root ? null : b.parent!), volumeDb: levelDbOf(b.volume), mute: b.mute, voiceLimit: b.maxVoices ?? null, bed: bedOf(a, b.name, root), meter: root || b.meter === "loudness" };
    bus.effects = effectsOf(b);
    for (const e of b.effects) {
      if (e.type !== "reverb") continue;
      if (root) problems.push(`buses "${b.name}": the master bus can't send, so its reverb send is dropped.`);
      else if (bus.sends.length > 0) problems.push(`buses "${b.name}": a second reverb send is dropped.`);
      else {
        bus.sends.push({ to: reverbName, levelDb: levelDbOf(e.send) });
        usesReverb = true;
      }
    }
    if (!root) for (const s of b.sends ?? []) if (asReturn.has(s.to) && !bus.sends.some((x) => x.to === s.to)) bus.sends.push({ to: s.to, levelDb: levelDbOf(s.level) });
    return bus;
  });
  const busName = (name: string | undefined) => (name !== undefined && project.buses.some((b) => b.name === name) ? name : project.buses[0].name);
  project.returns = a.buses.filter((b) => asReturn.has(b.name)).map((b) => ({ name: b.name, output: busName(b.parent), volumeDb: levelDbOf(b.volume), mute: b.mute, effects: effectsOf(b) }));
  if (usesReverb) project.returns.push({ name: reverbName, output: project.buses[0].name, volumeDb: 0, mute: false, effects: [reverbEffect()] });
  const carriers = new Map<string, string>();
  const carrier = (name: string): string => {
    let id = carriers.get(name);
    if (id === undefined) carriers.set(name, (id = addCarrier((project.buses.find((b) => b.name === name) ?? project.returns.find((r) => r.name === name))!)));
    return id;
  };
  project.snapshots = a.snapshots.map((s) => {
    const snap = newSnapshot(s.name);
    for (const [bus, v] of Object.entries(s.volumes)) snap.buses[bus] = levelDbOf(v);
    for (const [bus, hz] of Object.entries(s.lowpass)) (snap.effects[bus] ??= {})[carrier(bus)] = { cutoff: hz };
    return snap;
  });
  project.automation = a.automation.map((x) => ({
    on: x.bus, parameter: x.parameter, bypass: false,
    ...(x.target === "volume" ? { target: "volume" as const, curve: curveToDb(x.curve) } : { target: `fx:${carrier(x.bus)}:cutoff` as const, curve: structuredClone(x.curve) as CurveKey[] }),
  }));
  project.ducking = a.ducking.map(duckingFrom);
  project.loudness = { targets: structuredClone(a.loudnessTargets ?? DEFAULT_LOUDNESS_TARGETS.map((t) => ({ ...t }))), resetOnPlay: a.loudnessResetOnPlay !== false };
  return project;
}

// --- the adapter ------------------------------------------------------------------------------------------------------

/** `project` with buses renamed by `renames` (old → new) everywhere they are named. */
function renamed(project: AudioProject, renames: ReadonlyMap<string, string>): AudioProject {
  if (renames.size === 0) return project;
  const r = (n: string) => renames.get(n) ?? n;
  const rekey = <T>(rec: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(rec).map(([k, v]) => [r(k), v]));
  const target = (t: MixAutomation["target"]): MixAutomation["target"] => (t.startsWith("send:") ? `send:${r(t.slice(5))}` : t);
  return {
    ...project,
    buses: project.buses.map((b) => ({ ...b, name: r(b.name), parent: b.parent === null ? null : r(b.parent), sends: b.sends.map((s) => ({ ...s, to: r(s.to) })) })),
    returns: project.returns.map((x) => ({ ...x, name: r(x.name), output: r(x.output) })),
    vcas: project.vcas.map((v) => ({ ...v, members: v.members.map(r) })),
    automation: project.automation.map((a) => ({ ...a, on: r(a.on), target: target(a.target) })),
    ducking: project.ducking.map((d) => ({ ...d, target: r(d.target), trigger: r(d.trigger) })),
    snapshots: project.snapshots.map((s) => ({ ...s, buses: rekey(s.buses), effects: rekey(s.effects) })),
  };
}

/** The names of the section's buses in order (`coreSectionOf`: the buses, then the returns that fit). */
const sectionNames = (p: AudioProject): string[] => [...p.buses.map((b) => b.name), ...sectionReturnsOf(p).map((r) => r.name)];

/**
 * Renames the old section's edit made: an old bus (or return, ADR 0330: returns are buses of the section) missing at the
 * same index as a new bus that wasn't there (the list kept its length).
 */
function renamesOf(project: AudioProject, next: AudioSettings): Map<string, string> {
  const out = new Map<string, string>();
  const names = sectionNames(project);
  if (names.length !== next.buses.length) return out;
  const oldNames = new Set(names), newNames = new Set(next.buses.map((b) => b.name));
  names.forEach((b, i) => {
    const n = next.buses[i].name;
    if (!newNames.has(b) && !oldNames.has(n)) out.set(b, n);
  });
  return out;
}

/** The bus or return of the section named `name` (`runtimeView.ts`' owners). */
const sectionOwner = (p: AudioProject, name: string): Bus | Return | undefined => p.buses.find((b) => b.name === name) ?? sectionReturnsOf(p).find((r) => r.name === name);

/** Whether the section view shows `d` (`runtimeView.ts`' rule). */
const showsRule = (p: AudioProject, d: DuckingRule) => d.enabled && sectionOwner(p, d.target) !== undefined && sectionOwner(p, d.trigger) !== undefined;

/** Whether the section view shows `a` (`runtimeView.ts`' rule). */
function showsAutomation(p: AudioProject, a: MixAutomation): boolean {
  if (a.bypass) return false;
  const bus = sectionOwner(p, a.on);
  if (!bus) return false;
  if (a.target === "volume") return true;
  const [kind, id, param] = a.target.split(":");
  return kind === "fx" && param === "cutoff" && bus.effects.find((e) => e.id === id)?.type === "lowpass";
}

/**
 * The effects of a bus after the old section's chain changed from `before` to `after` (both without the reverb send).
 * `old` holds the bus's effects; the ones the view shows correspond, in order, to `before`. The same types in the same
 * order update in place; otherwise the shown effects are rebuilt where the first one stood, keeping the ids of those of
 * the same type, and every effect the view doesn't show stays.
 */
/** The effect type a section bus effect stands for (a catalogue `fx` names its own). */
const kindOf = (b: BusEffect): string => (b.type === "fx" ? b.fx : b.type);

function mergeEffects(project: AudioProject, owner: string, old: readonly Effect[], before: readonly BusEffect[], after: readonly BusEffect[]): Effect[] {
  // The view (`coreSectionOf`) shows what the core runs, each as `coreBusEffect` (ADR 0331): legacy shapes or catalogue `fx`.
  const shown = old.filter((e) => coreShown(project, owner, e));
  const beforeOf = (e: Effect) => before[shown.indexOf(e)] ?? coreBusEffect(e);
  if (shown.length === after.length && shown.every((e, i) => e.type === kindOf(after[i]))) {
    return old.map((e) => {
      const i = shown.indexOf(e);
      return i < 0 ? structuredClone(e) : { ...structuredClone(e), params: updatedParams(e, beforeOf(e), after[i]) };
    });
  }
  const kept = old.filter((e) => !shown.includes(e)).map((e) => structuredClone(e));
  const taken = old.map((e) => e.id); // never reuse a removed effect's id: an override or automation may still name it
  const used = new Set<Effect>();
  const made = after.map((b): Effect => {
    const reuse = shown.find((e) => !used.has(e) && e.type === kindOf(b));
    if (reuse) {
      used.add(reuse);
      return { ...structuredClone(reuse), params: updatedParams(reuse, beforeOf(reuse), b) };
    }
    const id = freeEffectId(taken);
    taken.push(id);
    if (b.type === "fx") return { id, type: b.fx, on: true, params: { ...b.params }, ...(b.key !== undefined ? { key: b.key } : {}) };
    const mapped = b as Exclude<BusEffect, { type: "reverb" | "fx" }>;
    return { id, type: mapped.type, on: true, params: paramsOf(mapped) };
  });
  const at = shown.length > 0 ? old.slice(0, old.indexOf(shown[0])).filter((e) => !shown.includes(e)).length : kept.length;
  return [...kept.slice(0, at), ...made, ...kept.slice(at)];
}

const nonReverb = (b: BusSettings | undefined): Exclude<BusEffect, { type: "reverb" }>[] =>
  (b?.effects ?? []).filter((e): e is Exclude<BusEffect, { type: "reverb" }> => e.type !== "reverb");

/**
 * `project` with the old-shape `section` written in. `section` is an edit of `coreSectionOf(project)`: each value it
 * changed is converted and written; what it left alone, and what the old shape can't express, stays as `project` has
 * it. A bus renamed in place keeps what only `audio.json` knows about it.
 */
export function mergeLegacyIntoProject(original: AudioProject, section: unknown): AudioProject {
  const next = parseAudioSettings(section).settings;
  const project = renamed(original, renamesOf(original, next));
  const raw = coreSectionOf(project);
  const expected = parseAudioSettings(raw).settings;
  const out: AudioProject = structuredClone(project);

  // Engine settings: each key the section changed.
  const nextEngine = engineSettingsOf(next) as unknown as Record<string, unknown>;
  const expEngine = engineSettingsOf(expected) as unknown as Record<string, unknown>;
  const settings = out.settings as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(nextEngine), ...Object.keys(expEngine)])) {
    if (k === "submixes" || k === "bedBeyond" || k === "dopplerAmount" || same(nextEngine[k], expEngine[k])) continue;
    if (nextEngine[k] === undefined) delete settings[k];
    else settings[k] = structuredClone(nextEngine[k]);
  }
  out.settings = settings as unknown as AudioEngineSettings;

  // Buses, in the section's order.
  const reverbReturn = (): Return => {
    let ret = out.returns.find((r) => r.effects.some((e) => e.type === "reverb" && e.on));
    if (!ret) {
      const names = [...next.buses.map((b) => b.name), ...out.returns.map((r) => r.name), ...out.vcas.map((v) => v.name)];
      ret = { name: uniqueName(REVERB_RETURN, names), output: out.buses[0].name, volumeDb: 0, mute: false, effects: [reverbEffect()] };
      out.returns.push(ret);
    }
    return ret;
  };
  // ADR 0330: the returns the section holds as buses (`sectionReturnsOf`) are written back to the returns: output, mute,
  // inserts and level; one the section no longer lists is removed with the sends into it. Those that didn't fit stay.
  const shownReturns = new Set(sectionReturnsOf(project).map((r) => r.name));
  const returnVolumes: { ret: Return; nb: BusSettings; changed: boolean }[] = [];
  out.returns = out.returns.flatMap((ret): Return[] => {
    if (!shownReturns.has(ret.name)) return [ret];
    const nb = next.buses.find((b) => b.name === ret.name);
    if (!nb) return [];
    const eb = expected.buses.find((b) => b.name === ret.name);
    if (nb.parent !== undefined && (!eb || nb.parent !== eb.parent)) ret.output = nb.parent;
    ret.mute = nb.mute;
    if (!eb || !same(nonReverb(nb), nonReverb(eb))) ret.effects = mergeEffects(project, ret.name, project.returns.find((r) => r.name === ret.name)?.effects ?? [], nonReverb(eb), nonReverb(nb));
    returnVolumes.push({ ret, nb, changed: !eb || nb.volume !== eb.volume });
    return [ret];
  });
  const isReturn = (name: string) => out.returns.some((r) => r.name === name);
  const volumes: { bus: Bus; nb: BusSettings; changed: boolean }[] = [];
  out.buses = next.buses.filter((nb, i) => i === 0 || !shownReturns.has(nb.name)).map((nb, i) => {
    const root = i === 0;
    const ob = project.buses.find((b) => b.name === nb.name);
    const eb = expected.buses.find((b) => b.name === nb.name);
    const bus: Bus = ob ? structuredClone(ob) : newBus(nb.name, root ? null : nb.parent!);
    const rootChanged = !ob || (ob.parent === null) !== root;
    bus.parent = root ? null : nb.parent!;
    bus.mute = nb.mute;
    if (!eb || nb.maxVoices !== eb.maxVoices) bus.voiceLimit = nb.maxVoices ?? null;
    if (!eb || rootChanged || nb.bed !== eb.bed || nb.bedPriority !== eb.bedPriority) bus.bed = bedOf(next, nb.name, root);
    if (!eb || rootChanged || nb.meter !== eb.meter) bus.meter = root || nb.meter === "loudness";
    if (!eb || !same(nonReverb(nb), nonReverb(eb))) bus.effects = mergeEffects(project, nb.name, ob?.effects ?? [], nonReverb(eb), nonReverb(nb));
    const nRev = nb.effects.find((e) => e.type === "reverb"), eRev = eb?.effects.find((e) => e.type === "reverb");
    if (!eb || !same(nRev, eRev)) {
      const old = ob ? reverbSendOf(project, ob) : null;
      const index = old ? bus.sends.findIndex((s) => s.to === old.send.to) : bus.sends.length;
      const sends = bus.sends.filter((s) => s.to !== old?.send.to);
      if (nRev?.type === "reverb" && root) {
        // Master can't send (ADR 0330): the old section's reverb on the root has nowhere to go.
      } else if (nRev?.type === "reverb") {
        const ret = old ? out.returns.find((r) => r.name === old.ret.name)! : reverbReturn();
        sends.splice(Math.max(0, index), 0, { to: ret.name, levelDb: levelDbOf(nRev.send, ret.volumeDb) });
      }
      bus.sends = sends;
    }
    // ADR 0330: the section's sends (linear levels) into returns; an unchanged level keeps its exact dB.
    if (!eb || !same(nb.sends ?? [], eb.sends ?? [])) {
      const was = new Map((eb?.sends ?? []).map((s) => [s.to, s.level]));
      const fromSection = (nb.sends ?? []).filter((s) => isReturn(s.to)).map((s) => {
        const old = ob?.sends.find((x) => x.to === s.to);
        return { to: s.to, levelDb: old && was.get(s.to) === s.level ? old.levelDb : levelDbOf(s.level) };
      });
      // Sends into returns the section leaves out (past the core's slots) stay as they were.
      const kept = bus.sends.filter((s) => !shownReturns.has(s.to) && !fromSection.some((x) => x.to === s.to));
      bus.sends = [...fromSection, ...kept];
    }
    if (root) bus.sends = [];
    volumes.push({ bus, nb, changed: !ob || !eb || nb.volume !== eb.volume });
    return bus;
  });
  const busNames = new Set(out.buses.map((b) => b.name));
  for (const v of out.vcas) v.members = v.members.filter((m) => busNames.has(m));
  for (const r of out.returns) if (!busNames.has(r.output)) r.output = out.buses[0].name;
  // Levels last: the view's volume is the fader alone (VCAs are their own lane).
  for (const { bus, nb, changed } of volumes) if (changed) bus.volumeDb = levelDbOf(nb.volume);
  for (const { ret, nb, changed } of returnVolumes) if (changed) ret.volumeDb = levelDbOf(nb.volume);

  // Carriers for an old snapshot or automation low-pass: one per bus, shared.
  const created = new Set<Effect>();
  const carrierOf = (name: string): string | null => {
    const bus = out.buses.find((b) => b.name === name) ?? out.returns.find((r) => r.name === name && shownReturns.has(r.name));
    if (!bus) return null;
    const found = bus.effects.find((e) => isCarrier(project, name, e) || (e.type === "lowpass" && e.on && created.has(e)));
    if (found) return found.id;
    const id = addCarrier(bus);
    created.add(bus.effects[bus.effects.length - 1]);
    return id;
  };

  // Snapshots, by name.
  out.snapshots = next.snapshots.map((ns) => {
    const os = project.snapshots.find((s) => s.name === ns.name);
    const es = expected.snapshots.find((s) => s.name === ns.name);
    const snap = os ? structuredClone(os) : newSnapshot(ns.name);
    if (!es || !same(ns.volumes, es.volumes)) {
      const buses: Record<string, number> = {};
      for (const [k, v] of Object.entries(snap.buses)) if (!busNames.has(k) && !shownReturns.has(k)) buses[k] = v; // returns past the core's slots: the section can't name them
      for (const [k, v] of Object.entries(ns.volumes)) buses[k] = es && os && es.volumes[k] === v && os.buses[k] !== undefined ? os.buses[k] : levelDbOf(v);
      snap.buses = buses;
    }
    if (!es || !same(ns.lowpass, es.lowpass)) {
      for (const k of new Set([...Object.keys(ns.lowpass), ...Object.keys(es?.lowpass ?? {})])) {
        if (es && ns.lowpass[k] === es.lowpass[k]) continue;
        const bus = out.buses.find((b) => b.name === k) ?? out.returns.find((r) => r.name === k && shownReturns.has(r.name));
        if (!bus) continue;
        const byId = snap.effects[k] ?? {};
        for (const id of Object.keys(byId)) {
          if (bus.effects.find((e) => e.id === id)?.type !== "lowpass") continue;
          delete byId[id].cutoff;
          if (Object.keys(byId[id]).length === 0) delete byId[id];
        }
        snap.effects[k] = byId;
        if (ns.lowpass[k] !== undefined) {
          const id = carrierOf(k)!;
          byId[id] = { ...byId[id], cutoff: ns.lowpass[k] };
        }
        if (Object.keys(byId).length === 0) delete snap.effects[k];
      }
    }
    return snap;
  });

  // Ducking: rules have no names, so they pair by position among the ones the view shows.
  if (!same(next.ducking, expected.ducking)) {
    const shown = project.ducking.filter((d) => showsRule(project, d));
    const update = (d: DuckingRule, n: RuntimeDuckingRule, e: RuntimeDuckingRule): DuckingRule => {
      const r = { ...d, target: n.target, trigger: n.trigger, mode: n.mode ?? d.mode };
      if (n.amount !== e.amount) r.amountDb = Math.min(0, levelDbOf(n.amount));
      if (n.attack !== e.attack) r.attackMs = msOf(n.attack);
      if (n.release !== e.release) r.releaseMs = msOf(n.release);
      if (n.detector !== undefined && n.detector !== e.detector) r.detector = n.detector;
      if (n.threshold !== undefined && n.threshold !== e.threshold) r.thresholdDb = n.threshold;
      return r;
    };
    out.ducking = shown.length === expected.ducking.length && shown.length === next.ducking.length
      ? project.ducking.map((d) => (shown.includes(d) ? update(d, next.ducking[shown.indexOf(d)], expected.ducking[shown.indexOf(d)]) : structuredClone(d)))
      : [...next.ducking.map(duckingFrom), ...project.ducking.filter((d) => !shown.includes(d)).map((d) => structuredClone(d))];
  }

  // Automation: the same pairing.
  if (!same(next.automation, expected.automation)) {
    const shown = project.automation.filter((a) => showsAutomation(project, a));
    const fresh = (n: BusAutomation): MixAutomation | null => {
      if (n.target === "volume") return { on: n.bus, target: "volume", parameter: n.parameter, curve: curveToDb(n.curve), bypass: false };
      const id = carrierOf(n.bus);
      return id === null ? null : { on: n.bus, target: `fx:${id}:cutoff`, parameter: n.parameter, curve: structuredClone(n.curve) as CurveKey[], bypass: false };
    };
    const update = (a: MixAutomation, n: BusAutomation, e: BusAutomation): MixAutomation | null => {
      if (n.bus !== e.bus || n.target !== e.target) return fresh(n);
      const curve = same(n.curve, e.curve) ? structuredClone(a.curve) : n.target === "volume" ? curveToDb(n.curve) : (structuredClone(n.curve) as CurveKey[]);
      return { ...structuredClone(a), parameter: n.parameter, curve };
    };
    const list = shown.length === expected.automation.length && shown.length === next.automation.length
      ? project.automation.map((a) => (shown.includes(a) ? update(a, next.automation[shown.indexOf(a)], expected.automation[shown.indexOf(a)]) : structuredClone(a)))
      : [...next.automation.map(fresh), ...project.automation.filter((a) => !shown.includes(a)).map((a) => structuredClone(a))];
    out.automation = list.filter((a): a is MixAutomation => a !== null);
  }

  if (!same(next.parameters, expected.parameters)) out.parameters = structuredClone(next.parameters);
  out.loudness = { targets: structuredClone(next.loudnessTargets ?? DEFAULT_LOUDNESS_TARGETS.map((t) => ({ ...t }))), resetOnPlay: next.loudnessResetOnPlay !== false };

  // A carrier no longer named by any snapshot or automation goes: it is open (neutral), and the old shape never showed it.
  for (const bus of [...out.buses, ...out.returns]) bus.effects = bus.effects.filter((e) => !(isCarrier(project, bus.name, e) || created.has(e)) || isCarrier(out, bus.name, e));

  // Through the parse, so a reference the edit left dangling (a removed bus) is dropped as the file would drop it.
  return parseAudioProject(audioProjectToJson(out)).project;
}
