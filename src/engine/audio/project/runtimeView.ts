/**
 * Internal (ADR 0344): the mix as the old `audio` section shape (`AudioSettings`' mix keys).
 *
 * **`coreSectionOf(project)`** is what the runtime's mixer hands its backends (`Mixer.audioSettings`): the bus tree
 *   the audio core's slots and the Web Audio fallback's nodes are built from. Levels are each bus's fader alone (the
 *   mixer runs VCAs as their own gain lane), the effects the backends' bus chains run (every type the audio core runs, `CORE_EFFECT_TYPES`, ADR 0345 ABI 4.6: legacy low-pass, high-pass and compressor when exact, else catalogue effects, `coreBusEffect`),
 *   each bus's sends (`BusSettings.sends`, linear levels), ducking and the automation the core runs (ABI 4.8: `volume`,
 *   any effect parameter of a chain the core runs, an automated effect being sent as the catalogue's, and send levels;
 *   a migrated low-pass carrier's cutoff as the old bus low-pass). **Returns are buses** of the section (ADR 0344, ABI 4.7: the core's bus-to-return sends): each after the
 *   project's buses, under its own name (names are unique across buses, returns and VCAs), its `output` as the parent,
 *   its fader, mute and inserts; the sends into it are post-fader `sends` of the buses that feed it. The mixer itself
 *   runs everything else on the main thread from the `AudioProject` (snapshots, VCAs, effect-parameter overrides, send
 *   muting): `warnings` lists only what nothing runs yet.
 *   The Web Audio fallback runs no bus effects and no sends (ADR 0345's fallback rule), so it needs nothing folded: a
 *   return is a silent bus there.
 * `mergeLegacyIntoProject` (`legacy.ts`) writes an edit of it back. It carries the snapshots in the old shape
 * (multipliers and the carrier low-pass), so the old ops that name them by index (ADR 0171) still find them; the
 * runtime's mixer doesn't read them. (The editor's legacy panels had a second view with VCAs folded into the levels,
 * decision D2, until the Audio Studio replaced them.)
 *
 * Pure; no plugin, no DOM.
 */
import type { Curve, CurveKey } from "../../core/curve";
import { BUS_RULES, MAX_BUSES, coreRuns, findingText, type CoreEffectType } from "../busCapability";
import { allowedAt, effectSpec, isPluginEffectType, pluginEffectNote } from "../effects/catalogue";
import type { Effect } from "../effects/types";
import {
  DEFAULT_BED_PRIORITY, DEFAULT_LOUDNESS_TARGETS, MAX_SEND_LEVEL, ROOT_BED_PRIORITY,
  type AudioSettings, type BusAutomation, type BusEffect, type BusSettings, type DuckingRule as RuntimeDuckingRule, type LoudnessTarget, type SnapshotSettings,
} from "../settings";
import { DEFAULT_SUBMIXES } from "./format";
import { dbToGain } from "./gain";
import { fxParamSlot, log2Curve } from "./fxAutomation";
import { isCarrier, isMappable, secondsOf, toBusEffect } from "./legacyEffects";
import type { AudioProject, Bus, MixAutomation, Return, Send } from "./types";

/** The sum of the VCA levels on `name`: each VCA that lists it, unless it also lists one of its ancestors (counted there). */
export function vcaOffsetDb(project: Pick<AudioProject, "buses" | "vcas">, name: string): number {
  const ancestors: string[] = [];
  const seen = new Set<string>([name]);
  for (let p = project.buses.find((b) => b.name === name)?.parent ?? null; p !== null && !seen.has(p); p = project.buses.find((b) => b.name === p)?.parent ?? null) {
    ancestors.push(p);
    seen.add(p);
  }
  let db = 0;
  for (const v of project.vcas) if (v.members.includes(name) && !ancestors.some((a) => v.members.includes(a))) db += v.volumeDb;
  return db;
}

/**
 * The return a bus's old-shape reverb send stands for: the first of its sends to a return with an `on` reverb. The
 * migration's and the legacy merge's (an old section's `reverb` effect); the runtime's view sends into returns directly.
 */
export function reverbSendOf(project: Pick<AudioProject, "returns">, bus: Bus): { send: Send; ret: Return } | null {
  for (const send of bus.sends) {
    const ret = project.returns.find((r) => r.name === send.to);
    if (ret && ret.effects.some((e) => e.type === "reverb" && e.on)) return { send, ret };
  }
  return null;
}

/**
 * ADR 0345 (ABI 4.6): true when the audio core's bus chain runs `e` on `owner` (a bus or a return) in the backends'
 * view: switched on, a type the core runs (`CORE_EFFECT_TYPES`), and not a low-pass carrier (`isCarrier`: the old
 * snapshot and automation low-pass stand for it).
 */
export const coreShown = (project: Pick<AudioProject, "snapshots" | "automation">, owner: string, e: Effect): boolean =>
  e.on && (coreRuns(e.type) || pluginRunsOnBus(e.type)) && !isCarrier(project, owner, e);

/** ADR 0352 §4: a registered plugin effect whose plugin is on and that declares the bus level (returns are buses) runs in the core's bus chain. */
const pluginRunsOnBus = (type: string): boolean => isPluginEffectType(type) && effectSpec(type).plugin?.state === "on" && allowedAt(type, "bus");

/**
 * The bus effect the core runs for `e` (`coreShown`): a low-pass, high-pass or compressor the legacy shape holds exactly
 * stays legacy (the Web Audio fallback and the parity reference run those), anything else is a catalogue effect (`fx`).
 * `catalogue` forces the catalogue shape: an effect automation drives (ABI 4.8: the core automates catalogue parameters
 * by index, `automatedEffect`).
 */
export function coreBusEffect(e: Effect, catalogue = false): BusEffect {
  if (isMappable(e) && !catalogue) {
    const lost: string[] = [];
    const b = toBusEffect(e, lost);
    if (lost.length === 0) return b;
  }
  return { type: "fx", fx: e.type as CoreEffectType, params: structuredClone(e.params), ...(e.key ? { key: e.key } : {}) };
}

/** A send's linear level in the section (`BusSettings.sends`): its dB as a gain, capped at the core's +12 dB. */
export const sendLevelOf = (levelDb: number): number => clampGain(dbToGain(levelDb), MAX_SEND_LEVEL);

/**
 * ADR 0344: the returns the section holds as buses, in the project's order: those that fit in the core's slots after the
 * buses (`MAX_BUSES`, slots shared with buses).
 */
export function sectionReturnsOf(project: Pick<AudioProject, "buses" | "returns">): Return[] {
  return project.returns.slice(0, Math.max(0, MAX_BUSES - project.buses.length));
}

const clampGain = (g: number, max: number) => Math.min(max, Math.max(0, g));
const curveToGain = (curve: Curve): CurveKey[] => curve.map((k) => (k.length === 3 ? [k[0], dbToGain(k[1]), k[2]] : [k[0], dbToGain(k[1])]) as CurveKey);

/** ADR 0344 (ABI 4.8): true when an automation of `owner` (not bypassed) drives a parameter of `e`, so the core runs it as the catalogue's. */
export const automatedEffect = (project: Pick<AudioProject, "automation">, owner: string, e: Effect): boolean =>
  project.automation.some((a) => !a.bypass && a.on === owner && a.target.startsWith(`fx:${e.id}:`));

/** The effects the core runs of `owner`'s chain (warnings into `warn`). */
function sectionEffects(project: AudioProject, owner: { name: string; effects: Effect[] }, kind: "bus" | "return", warn: (line: string) => void): BusEffect[] {
  const out: BusEffect[] = [];
  for (const e of owner.effects) {
    // Every type the core's bus chain runs (ADR 0345).
    if (coreShown(project, owner.name, e)) {
      out.push(coreBusEffect(e, automatedEffect(project, owner.name, e)));
      if (e.type === "sidechainCompressor" && !project.buses.some((b) => b.name === e.key) && !project.returns.some((r) => r.name === e.key)) warn(`${kind} "${owner.name}": the sidechain compressor "${e.id}" has no key bus; it doesn't compress until it has one.`);
    } else if (e.on && !isCarrier(project, owner.name, e)) {
      // ADR 0352 §4: a plugin effect whose plugin is off or missing passes audio through, with this one warning.
      const note = pluginEffectNote(e.type);
      warn(note ? `${kind} "${owner.name}": the effect "${e.id}" ${note}.` : `${kind} "${owner.name}": the ${e.type} effect "${e.id}" doesn't run on a ${kind} (ADR 0345); left out.`);
    }
  }
  return out;
}

/** The section bus of `bus` (warnings into `warn`): its fader alone (the mixer runs VCAs as a lane), its sends into the returns in `returns`. */
function sectionBus(project: AudioProject, bus: Bus, returns: ReadonlySet<string>, warn: (line: string) => void): BusSettings {
  const root = bus.parent === null;
  const out: BusSettings = { name: bus.name, ...(root ? {} : { parent: bus.parent! }), volume: clampGain(dbToGain(bus.volumeDb), 2), mute: bus.mute, effects: sectionEffects(project, bus, "bus", warn) };
  // ADR 0344: post-fader sends at their authored level. Mutes (the bus's, a script's, a monitor's) are the mixer's to run
  // (the core's `BUS_SEND_MUTED`), so the authored view stays an exact image of the file.
  const sends = bus.sends.filter((s) => returns.has(s.to)).map((s) => ({ to: s.to, level: sendLevelOf(s.levelDb) }));
  if (sends.length > 0) out.sends = sends;
  if (sends.length > BUS_RULES.sendsPerBus.limit) warn(findingText("sendsPerBus", `bus "${bus.name}"`));
  // A return past the core's bus slots that holds a reverb still runs, as the core's one shared reverb send (the old
  // model's; its level plus the return's, 0 while the return is muted): the first such send of the bus.
  const shared = reverbSendOf({ returns: project.returns.filter((r) => !returns.has(r.name)) }, bus);
  if (shared) out.effects.push({ type: "reverb", send: shared.ret.mute ? 0 : clampGain(dbToGain(shared.send.levelDb + shared.ret.volumeDb), 1) });
  if (bus.voiceLimit !== null) out.maxVoices = bus.voiceLimit;
  if (root) {
    if (bus.bed && bus.bed.priority !== ROOT_BED_PRIORITY) out.bedPriority = bus.bed.priority;
  } else if (bus.bed) {
    if (bus.bed.own) out.bed = "own";
    else out.bed = "none";
    if (bus.bed.priority !== DEFAULT_BED_PRIORITY) out.bedPriority = bus.bed.priority;
  }
  if (!root && bus.meter) out.meter = "loudness";
  return out;
}

/** ADR 0344: the section bus of return `r`: its output as the parent, its fader, mute and inserts; no voices, bed or meter of its own. */
function sectionReturn(project: AudioProject, r: Return, warn: (line: string) => void): BusSettings {
  return { name: r.name, parent: r.output, volume: clampGain(dbToGain(r.volumeDb), 2), mute: r.mute, effects: sectionEffects(project, r, "return", warn) };
}

/**
 * The section's entry for automation `a` (`coreSectionOf`'s `automation`), or null when the view leaves it out (bypassed,
 * its owner not in the section, a send the bus doesn't have, an effect the core doesn't run): `volume` (as a gain curve);
 * ADR 0344 (ABI 4.8) `send:<return>` (dB) and `fx:<id>:<param>` of an effect the core runs, by its index in the chain the
 * view shows and the catalogue parameter's index (a log-scale parameter as a log2 curve); a migrated low-pass carrier's
 * cutoff as the old bus low-pass. What has no parameter the core runs goes to `warn`.
 */
export function sectionAutomationOf(project: AudioProject, a: MixAutomation, warn: (line: string) => void = () => {}): BusAutomation | null {
  if (a.bypass) return null;
  const fitting = sectionReturnsOf(project);
  const isBus = project.buses.some((b) => b.name === a.on);
  const owner: Bus | Return | undefined = project.buses.find((b) => b.name === a.on) ?? fitting.find((r) => r.name === a.on);
  if (!owner) return null;
  if (a.target === "volume") return { bus: owner.name, parameter: a.parameter, target: "volume", curve: curveToGain(a.curve) };
  if (a.target.startsWith("send:")) {
    const to = a.target.slice(5);
    const ok = isBus && fitting.some((r) => r.name === to) && (owner as Bus).sends.some((s) => s.to === to);
    return ok ? { bus: owner.name, parameter: a.parameter, target: "send", to, curve: structuredClone(a.curve) as CurveKey[] } : null;
  }
  const [, id, p] = a.target.split(":");
  const e = owner.effects.find((x) => x.id === id);
  if (!e || !p) return null;
  if (isCarrier(project, owner.name, e)) return p === "cutoff" ? { bus: owner.name, parameter: a.parameter, target: "lowpass", curve: structuredClone(a.curve) as CurveKey[] } : null;
  if (!coreShown(project, owner.name, e)) return null;
  const slot = fxParamSlot(e.type, p);
  if (!slot) {
    warn(`automation of ${owner.name} "${a.target}": the ${e.type} effect has no parameter "${p}" the audio core runs; left out.`);
    return null;
  }
  const effect = owner.effects.filter((x) => coreShown(project, owner.name, x)).indexOf(e);
  return { bus: owner.name, parameter: a.parameter, target: "fx", effect, param: slot.index, ...(slot.log ? { log: true, curve: log2Curve(a.curve) } : { curve: structuredClone(a.curve) as CurveKey[] }) };
}

/** The mix keys of the section (engine keys left out: the caller adds its own). */
export type MixSection = Pick<AudioSettings, "buses" | "snapshots" | "ducking" | "parameters" | "automation" | "loudnessTargets" | "loudnessResetOnPlay">;

function sectionOf(project: AudioProject, warnings: string[]): MixSection {
  const warn = (line: string) => void warnings.push(line);
  const fitting = sectionReturnsOf(project);
  for (const r of project.returns.slice(fitting.length)) {
    if (r.effects.some((e) => e.type === "reverb" && e.on)) {
      // As the old model ran its one shared reverb: quietly, unless the return holds more than its reverb.
      if (r.effects.some((e) => e.on && e.type !== "reverb")) warn(`return "${r.name}": the audio core has ${MAX_BUSES} bus slots, buses and returns together; it runs as the core's shared reverb, without its other inserts.`);
    } else warn(`return "${r.name}": the audio core has ${MAX_BUSES} bus slots, buses and returns together; left out with the sends into it.`);
  }
  const returns = new Set(fitting.map((r) => r.name));
  const isBus = (name: string) => project.buses.some((b) => b.name === name);
  const isOwner = (name: string) => isBus(name) || returns.has(name);
  const ownerOf = (name: string) => project.buses.find((b) => b.name === name) ?? fitting.find((r) => r.name === name);
  const out: MixSection = { buses: [], snapshots: [], ducking: [], parameters: structuredClone(project.parameters), automation: [] };
  out.buses = [...project.buses.map((b) => sectionBus(project, b, returns, warn)), ...fitting.map((r) => sectionReturn(project, r, warn))];

  for (const s of project.snapshots) {
    const snap: SnapshotSettings = { name: s.name, volumes: {}, lowpass: {} };
    for (const [name, db] of Object.entries(s.buses)) {
      if (isOwner(name)) snap.volumes[name] = clampGain(dbToGain(db), 2);
    }
    for (const [name, byId] of Object.entries(s.effects)) {
      const owner = ownerOf(name);
      for (const [id, params] of Object.entries(byId)) {
        const e = owner?.effects.find((x) => x.id === id);
        for (const [p, v] of Object.entries(params)) {
          if (owner && e?.type === "lowpass" && p === "cutoff") snap.lowpass[name] = Math.min(snap.lowpass[name] ?? Infinity, v);
          else if (!e || !coreShown(project, name, e as Effect)) warn(`snapshot "${s.name}": the override of ${name} ${id}.${p} names an effect the ${returns.has(name) ? "return" : "bus"} doesn't run; left out.`);
        }
      }
    }
    out.snapshots.push(snap);
  }

  for (const d of project.ducking) {
    if (!d.enabled) continue;
    if (!isOwner(d.target) || !isOwner(d.trigger)) continue; // a return left out of the slots (warned above)
    // A presence rule ducks while its trigger has voices; a return has none of its own (it is fed by sends only).
    if (d.mode === "presence" && returns.has(d.trigger)) warn(`ducking: "${d.trigger}" is a return, which plays no sounds of its own, so its presence rule on "${d.target}" never ducks; use a level rule.`);
    const rule: RuntimeDuckingRule = { target: d.target, trigger: d.trigger, mode: d.mode, amount: clampGain(dbToGain(d.amountDb), 1), attack: secondsOf(d.attackMs), release: secondsOf(d.releaseMs) };
    if (d.mode === "level") { rule.detector = d.detector; rule.threshold = d.thresholdDb; }
    out.ducking.push(rule);
  }

  for (const a of project.automation) {
    const entry = sectionAutomationOf(project, a, warn);
    if (entry) out.automation.push(entry);
  }

  const t = project.loudness.targets;
  const same = t.length === DEFAULT_LOUDNESS_TARGETS.length && t.every((x, i) => JSON.stringify(x) === JSON.stringify(DEFAULT_LOUDNESS_TARGETS[i]));
  if (!same) out.loudnessTargets = structuredClone(t) as LoudnessTarget[];
  if (!project.loudness.resetOnPlay) out.loudnessResetOnPlay = false;
  return out;
}

/** The engine settings of `project` in the runtime's shape (`AudioSettings` minus the mix): `settings` with ADR 0345/0347's keys applied. */
export function engineSectionOf(project: AudioProject, warnings: string[] = []): Omit<AudioSettings, keyof MixSection | "mix"> {
  // `dialogue` (ADR 0355) is read by the dialogue system from audio.json, not by the backends.
  const { submixes, bedBeyond, dopplerAmount, dialogue: _dialogue, ...engine } = project.settings;
  void warnings;
  const out = structuredClone(engine);
  // ADR 0347: voices farther than `bedBeyond` metres go to their bus's bed (the core backend's panner pick reads it).
  if (bedBeyond !== null) out.bed = { ...out.bed, beyond: bedBeyond };
  if (submixes !== DEFAULT_SUBMIXES) out.voices = { ...out.voices, submixes }; // ADR 0345: the instance submix pool (absent: the default)
  // ADR 0347: the global Doppler amount scales every voice's Doppler level (the Doppler pass reads it).
  if (dopplerAmount !== 1) out.doppler = { ...out.doppler, amount: dopplerAmount };
  return out;
}

/**
 * The backends' view of `project` (see the header): its engine settings and the bus tree the backends build (buses,
 * then returns), levels without VCAs. What nothing in the runtime runs yet goes to `warnings`, one line each.
 */
export function coreSectionOf(project: AudioProject, warnings: string[] = []): AudioSettings {
  return { ...engineSectionOf(project, warnings), ...sectionOf(project, warnings) };
}
