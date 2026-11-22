/**
 * Internal (ADR 0330): the mix as the old `audio` section shape (`AudioSettings`' mix keys), in two flavours.
 *
 * - **`coreSectionOf(project)`** is what the runtime's mixer hands its backends (`Mixer.audioSettings`): the bus tree
 *   the audio core's slots and the Web Audio fallback's nodes are built from. Levels are each bus's fader alone (the
 *   mixer runs VCAs as their own gain lane), the effects the backends' bus chains run (every type the audio core runs, `CORE_EFFECT_TYPES`, ADR 0331 ABI 4.6: legacy low-pass, high-pass and compressor when exact, else catalogue effects, `coreBusEffect`),
 *   a send to a return that holds a reverb as the core's reverb send (its level plus the return's, 0 while the return is
 *   muted), ducking and the `volume` and low-pass automation the core runs. The
 *   mixer itself runs everything else on the main thread from the `AudioProject` (snapshots, VCAs, returns' lanes,
 *   effect-parameter overrides, send and effect automation): `warnings` lists only what nothing runs yet.
 * - **`legacySectionOf(project)`** is the editor's legacy panels' view (decision D2, until those panels go): the same,
 *   with each bus's VCA offsets folded into its level, and a line in `warnings` for everything the old shape can't hold.
 *   `mergeLegacyIntoProject` (`legacy.ts`) writes an edit of it back.
 *
 * Both carry the snapshots in the old shape (multipliers and the carrier low-pass), so the legacy ops that name them by
 * index (the editor's Mixer panel, ADR 0171) still find them; the runtime's mixer doesn't read them.
 *
 * Pure; no plugin, no DOM.
 */
import type { Curve, CurveKey } from "../../core/curve";
import { coreRuns, type CoreEffectType } from "../busCapability";
import type { Effect } from "../effects/types";
import {
  DEFAULT_BED_PRIORITY, DEFAULT_LOUDNESS_TARGETS, ROOT_BED_PRIORITY,
  type AudioSettings, type BusAutomation, type BusEffect, type BusSettings, type DuckingRule as RuntimeDuckingRule, type LoudnessTarget, type SnapshotSettings,
} from "../settings";
import { DEFAULT_SUBMIXES } from "./format";
import { dbToGain } from "./gain";
import { isCarrier, isMappable, isShown, secondsOf, toBusEffect } from "./legacyEffects";
import type { AudioProject, Bus, Return, Send } from "./types";

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

/** The return a bus's reverb send stands for: the first of its sends to a return with an `on` reverb. */
export function reverbSendOf(project: Pick<AudioProject, "returns">, bus: Bus): { send: Send; ret: Return } | null {
  for (const send of bus.sends) {
    const ret = project.returns.find((r) => r.name === send.to);
    if (ret && ret.effects.some((e) => e.type === "reverb" && e.on)) return { send, ret };
  }
  return null;
}

/**
 * ADR 0331 (ABI 4.6): true when the audio core's bus chain runs `e` on `owner` in the backends' view: switched on, a
 * type the core runs (`CORE_EFFECT_TYPES`), and not a low-pass carrier (`isCarrier`: the old snapshot and automation
 * low-pass stand for it).
 */
export const coreShown = (project: Pick<AudioProject, "snapshots" | "automation">, owner: string, e: Effect): boolean =>
  e.on && coreRuns(e.type) && !isCarrier(project, owner, e);

/**
 * The bus effect the core runs for `e` (`coreShown`): a low-pass, high-pass or compressor the legacy shape holds exactly
 * stays legacy (the Web Audio fallback and the parity reference run those), anything else is a catalogue effect (`fx`).
 */
export function coreBusEffect(e: Effect): BusEffect {
  if (isMappable(e)) {
    const lost: string[] = [];
    const b = toBusEffect(e, lost);
    if (lost.length === 0) return b;
  }
  return { type: "fx", fx: e.type as CoreEffectType, params: structuredClone(e.params), ...(e.key ? { key: e.key } : {}) };
}

/**
 * What each entry of a bus's effect list in the section stands for, in order: an effect of the bus (its id), or its
 * send to a return (the core's reverb send).
 */
export type SectionEffectSource = { readonly kind: "fx"; readonly id: string } | { readonly kind: "send"; readonly to: string };

/** The section's bus effects of `bus`, with what each stands for (the shown effects in order, then the reverb send). */
export function sectionEffectsOf(project: Pick<AudioProject, "snapshots" | "automation" | "returns">, bus: Bus): SectionEffectSource[] {
  const out: SectionEffectSource[] = bus.effects.filter((e) => isShown(project, bus.name, e)).map((e) => ({ kind: "fx", id: e.id }));
  const reverb = reverbSendOf(project, bus);
  if (reverb) out.push({ kind: "send", to: reverb.send.to });
  return out;
}

const clampGain = (g: number, max: number) => Math.min(max, Math.max(0, g));
const curveToGain = (curve: Curve): CurveKey[] => curve.map((k) => (k.length === 3 ? [k[0], dbToGain(k[1]), k[2]] : [k[0], dbToGain(k[1])]) as CurveKey);

interface ViewOptions {
  /** Fold each bus's VCA offsets into its level (the legacy view); otherwise the mixer runs them as a lane. */
  readonly foldVca: boolean;
}

/** The section bus of `bus` (warnings into `warn`). */
function sectionBus(project: AudioProject, bus: Bus, o: ViewOptions, warn: (line: string) => void): BusSettings {
  const root = bus.parent === null;
  const level = bus.volumeDb + (o.foldVca ? vcaOffsetDb(project, bus.name) : 0);
  const out: BusSettings = { name: bus.name, ...(root ? {} : { parent: bus.parent! }), volume: clampGain(dbToGain(level), 2), mute: bus.mute, effects: [] };
  for (const e of bus.effects) {
    if (!o.foldVca) {
      // The backends' view: every type the core's bus chain runs (ADR 0331).
      if (coreShown(project, bus.name, e)) {
        out.effects.push(coreBusEffect(e));
        if (e.type === "sidechainCompressor" && !project.buses.some((b) => b.name === e.key)) warn(`bus "${bus.name}": the sidechain compressor "${e.id}" has no key bus; it doesn't compress until it has one.`);
      } else if (e.on && !isCarrier(project, bus.name, e)) warn(`bus "${bus.name}": the ${e.type} effect "${e.id}" doesn't run on a bus (ADR 0331); left out.`);
      continue;
    }
    if (isShown(project, bus.name, e)) {
      const lost: string[] = [];
      out.effects.push(toBusEffect(e, lost));
      if (lost.length > 0) warn(`bus "${bus.name}": the ${e.type} "${e.id}" ${lost.join(" and ")} needs the audio core's effect catalogue (ADR 0331); left out until then.`);
    } else if (e.on && !isCarrier(project, bus.name, e)) warn(`bus "${bus.name}": the ${e.type} effect "${e.id}" needs the audio core's effect catalogue (ADR 0331); left out until then.`);
  }
  const reverb = reverbSendOf(project, bus);
  for (const s of bus.sends) {
    if (reverb && s === reverb.send) {
      // A muted return silences the send. A muted bus silences its sends too (ADR 0330), but that is the mixer's to run
      // (with script and monitor mutes, `Mixer`'s live effects), so the authored view stays an exact image of the file.
      const g = reverb.ret.mute ? 0 : dbToGain(s.levelDb + reverb.ret.volumeDb);
      if (g > 1) warn(`bus "${bus.name}": the send to "${s.to}" is above the audio core's reverb send of 1; using 1.`);
      out.effects.push({ type: "reverb", send: clampGain(g, 1) });
    } else warn(`bus "${bus.name}": the send to "${s.to}" needs the audio core's bus sends (a return without a reverb, or a second send); left out until then.`);
  }
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

/** The mix keys of the section (engine keys left out: the caller adds its own). */
export type MixSection = Pick<AudioSettings, "buses" | "snapshots" | "ducking" | "parameters" | "automation" | "loudnessTargets" | "loudnessResetOnPlay">;

function sectionOf(project: AudioProject, o: ViewOptions, warnings: string[]): MixSection {
  const legacy = o.foldVca;
  const warn = (line: string) => void warnings.push(line);
  const isBus = (name: string) => project.buses.some((b) => b.name === name);
  const out: MixSection = { buses: [], snapshots: [], ducking: [], parameters: structuredClone(project.parameters), automation: [] };
  out.buses = project.buses.map((b) => sectionBus(project, b, o, warn));
  for (const r of project.returns) {
    if (legacy && r.output !== project.buses[0]?.name) warn(`return "${r.name}": its output "${r.output}" needs the new mixer; it plays into the master bus until then.`);
    for (const e of r.effects) if (e.on && e.type !== "reverb") warn(`return "${r.name}": the ${e.type} effect "${e.id}" needs the audio core's return inserts; left out until then.`);
  }

  for (const s of project.snapshots) {
    if (legacy && (s.start.kind === "base" || s.start.kind === "conditions")) warn(`snapshot "${s.name}": starting ${s.start.kind === "base" ? "with the base mix" : "on conditions"} needs the new mixer; it starts from code until then.`);
    if (legacy && s.combine === "add") warn(`snapshot "${s.name}": Add needs the new mixer; it overrides until then.`);
    const snap: SnapshotSettings = { name: s.name, volumes: {}, lowpass: {} };
    for (const [name, db] of Object.entries(s.buses)) {
      if (isBus(name)) snap.volumes[name] = clampGain(dbToGain(db), 2);
      else if (legacy) warn(`snapshot "${s.name}": the offset on "${name}" needs the new mixer; left out until then.`);
    }
    for (const [name, byId] of Object.entries(s.effects)) {
      const bus = project.buses.find((b) => b.name === name);
      for (const [id, params] of Object.entries(byId)) {
        const e = bus?.effects.find((x) => x.id === id);
        for (const [p, v] of Object.entries(params)) {
          if (bus && e?.type === "lowpass" && p === "cutoff") snap.lowpass[name] = Math.min(snap.lowpass[name] ?? Infinity, v);
          else if (legacy) warn(`snapshot "${s.name}": the override of ${name} ${id}.${p} needs the new mixer; left out until then.`);
          else if (!e || !coreShown(project, name, e as Effect)) warn(`snapshot "${s.name}": the override of ${name} ${id}.${p} names an effect the bus doesn't run; left out.`);
        }
      }
    }
    out.snapshots.push(snap);
  }

  for (const d of project.ducking) {
    if (!d.enabled) continue;
    if (!isBus(d.target) || !isBus(d.trigger)) { warn(`ducking: "${d.trigger}" ducking "${d.target}" needs the audio core's return slots; left out until then.`); continue; }
    const rule: RuntimeDuckingRule = { target: d.target, trigger: d.trigger, mode: d.mode, amount: clampGain(dbToGain(d.amountDb), 1), attack: secondsOf(d.attackMs), release: secondsOf(d.releaseMs) };
    if (d.mode === "level") { rule.detector = d.detector; rule.threshold = d.thresholdDb; }
    out.ducking.push(rule);
  }

  for (const a of project.automation) {
    if (a.bypass) continue;
    const bus = project.buses.find((b) => b.name === a.on);
    let entry: BusAutomation | null = null;
    if (bus && a.target === "volume") entry = { bus: bus.name, parameter: a.parameter, target: "volume", curve: curveToGain(a.curve) };
    else if (bus && a.target.startsWith("fx:")) {
      const [, id, p] = a.target.split(":");
      if (p === "cutoff" && bus.effects.find((e) => e.id === id)?.type === "lowpass") entry = { bus: bus.name, parameter: a.parameter, target: "lowpass", curve: structuredClone(a.curve) as CurveKey[] };
    }
    if (entry) out.automation.push(entry);
    else if (legacy) warn(`automation: ${a.target} on "${a.on}" needs the new mixer; left out until then.`);
  }

  const t = project.loudness.targets;
  const same = t.length === DEFAULT_LOUDNESS_TARGETS.length && t.every((x, i) => JSON.stringify(x) === JSON.stringify(DEFAULT_LOUDNESS_TARGETS[i]));
  if (!same) out.loudnessTargets = structuredClone(t) as LoudnessTarget[];
  if (!project.loudness.resetOnPlay) out.loudnessResetOnPlay = false;
  return out;
}

/** The engine settings of `project` in the runtime's shape (`AudioSettings` minus the mix): `settings` with ADR 0331/0333's keys applied. */
export function engineSectionOf(project: AudioProject, warnings: string[] = []): Omit<AudioSettings, keyof MixSection | "mix"> {
  const { submixes, bedBeyond, dopplerAmount, ...engine } = project.settings;
  // TODO(ADR 0333): `bedBeyond` needs the audio core's panner pick to send a voice past it to its bus's bed (it picks beds
  // by HRTF rank only today); the runtime leaves it out until then.
  if (bedBeyond !== null) warnings.push("settings.bedBeyond needs the audio core's distance-based beds; beds go by HRTF rank until then.");
  const out = structuredClone(engine);
  if (submixes !== DEFAULT_SUBMIXES) out.voices = { ...out.voices, submixes }; // ADR 0331: the instance submix pool (absent: the default)
  // ADR 0333: the global Doppler amount scales every voice's Doppler level (the Doppler pass reads it).
  if (dopplerAmount !== 1) out.doppler = { ...out.doppler, amount: dopplerAmount };
  return out;
}

/**
 * The backends' view of `project` (see the header): its engine settings and the bus tree the backends build, levels
 * without VCAs. What nothing in the runtime runs yet goes to `warnings`, one line each.
 */
export function coreSectionOf(project: AudioProject, warnings: string[] = []): AudioSettings {
  return { ...engineSectionOf(project, warnings), ...sectionOf(project, { foldVca: false }, warnings) };
}

/**
 * The editor's legacy panels' view of `project` (decision D2): the old `audio` section, VCA offsets folded into the
 * levels; what the old shape can't express is left out of this view only (never out of the file), one line each in
 * `warnings`. Disabled ducking rules and bypassed effects and automation are left out silently.
 */
export function legacySectionOf(project: AudioProject, warnings: string[] = []): AudioSettings {
  return { ...engineSectionOf(project, warnings), ...sectionOf(project, { foldVca: true }, warnings) };
}
