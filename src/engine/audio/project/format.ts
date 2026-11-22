/**
 * Internal (ADR 0330): `audio.json` (`myco.audio@1`), read and written. `parseAudioProject` reads leniently (bad values
 * fall back to defaults or are dropped, one problem line each; it never throws); `audioProjectToJson` writes what it
 * reads back unchanged; `toRuntimeSettings` adapts a project to the runtime's current mix model (`AudioSettings`) until
 * the runtime runs the whole of ADR 0330.
 *
 * The engine settings (`settings`) are parsed by `parseAudioSettings`' own rules, so their limits stay declared once
 * (`AUDIO_NUMBERS`, ADR 0306).
 *
 * Pure; no plugin, no DOM.
 */
import type { Curve, CurveKey } from "../../core/curve";
import { effectsToJson, parseEffects as parseEffectChain } from "../effects/catalogue";
import type { Effect } from "../effects/types";
import { audioCurve, parseParameters } from "../eventFormat";
import { BUILTIN_MATERIALS } from "../occlusionMaterials";
import { sameMaterial } from "../audioSection";
import {
  BED_PRIORITY_LIMITS, DEFAULT_BED_PRIORITY, DEFAULT_DUCK_DETECTOR, DEFAULT_DUCK_THRESHOLD, DEFAULT_LOUDNESS_TARGETS, MASTER,
  MAX_BUSES, MAX_DUCK_RULES, MAX_LEVEL_RULES, ROOT_BED_PRIORITY, defaultAudioSettings, parseAudioSettings,
  type AudioParseOptions, type AudioSettings, type BusSettings, type DuckingRule as RuntimeDuckingRule,
  type LoudnessTarget, type SnapshotSettings, type BusAutomation,
} from "../settings";
import { MAX_DB, MIN_DB, dbToGain } from "./gain";
import { isCarrier, isShown, secondsOf, toBusEffect } from "./legacyEffects";
import {
  AUDIO_PROJECT_FORMAT, type AudioEngineSettings, type AudioProject, type AudioProjectParse, type Bus, type ConditionOp,
  type DuckingRule, type MixAutomation, type Return, type Send, type Snapshot, type SnapshotCondition, type SnapshotStart, type Vca,
} from "./types";

/** The `AudioSettings` keys that are the mix (top-level keys of `audio.json`), not engine settings. */
const MIX_KEYS = ["buses", "snapshots", "ducking", "parameters", "automation", "loudnessTargets", "loudnessResetOnPlay"] as const;

/** ADR 0331: the instance submix pool when `settings.submixes` is absent, and its range. */
export const DEFAULT_SUBMIXES = 32;
/** The limits of the mix's lists and numbers (ADR 0306: declared once, here). */
export const MIX_LIMITS = {
  /** dB, for bus, return and VCA levels, sends and snapshot offsets. */
  db: [MIN_DB, MAX_DB],
  submixes: [0, 256],
  dopplerAmount: [0, 2],
  returns: 8,
  vcas: 32,
  snapshots: 128,
  automation: 256,
  effectsPerOwner: 16,
  /** A ducking rule's threshold, dBFS. */
  thresholdDb: [-80, 0],
  /** A ducking rule's amount, dB (0: no dip). */
  amountDb: [MIN_DB, 0],
  /** Ducking attack and release, ms. */
  duckMs: [0, 10000],
  /** Snapshot fades and hold, ms. */
  snapshotMs: [0, 60000],
  snapshotPriority: [0, 100],
} as const;

export const DEFAULT_DUCK_AMOUNT_DB = -8;
export const DEFAULT_DUCK_ATTACK_MS = 100;
export const DEFAULT_DUCK_RELEASE_MS = 500;
export const DEFAULT_SNAPSHOT_FADE_MS = 300;
export const DEFAULT_SNAPSHOT_PRIORITY = 0;
export const CONDITION_OPS: readonly ConditionOp[] = ["lt", "le", "eq", "ne", "ge", "gt", "between", "is", "not"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A number clamped to `[min, max]` (a problem when clamped); absent is `fallback`; anything else is `fallback` plus a problem. */
function ranged(raw: unknown, where: string, [min, max]: readonly [number, number], fallback: number, problems: string[], whole = false): number {
  if (raw === undefined) return fallback;
  if (!isNum(raw)) {
    problems.push(`${where}: must be a number from ${min} to ${max}; using ${fallback}.`);
    return fallback;
  }
  const v = whole ? Math.round(raw) : raw;
  const clamped = Math.min(max, Math.max(min, v));
  if (clamped !== v) problems.push(`${where}: ${raw} is outside ${round2(min)}..${round2(max)}; using ${round2(clamped)}.`);
  return clamped;
}
const round2 = (x: number): number => Math.round(x * 100) / 100;

function bool(raw: unknown, where: string, fallback: boolean, problems: string[]): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw === "boolean") return raw;
  problems.push(`${where}: must be true or false; using ${fallback}.`);
  return fallback;
}

/** The default engine settings (every `AudioSettings` key but the mix, plus ADR 0331/0333's). */
export function defaultEngineSettings(): AudioEngineSettings {
  return { ...engineKeys(defaultAudioSettings()), submixes: DEFAULT_SUBMIXES, bedBeyond: null, dopplerAmount: 1 };
}

/** The engine settings of a runtime `AudioSettings` (a copy), with ADR 0331/0333's keys at their defaults. */
export function engineSettingsOf(a: AudioSettings): AudioEngineSettings {
  return { ...structuredClone(engineKeys(a)), submixes: DEFAULT_SUBMIXES, bedBeyond: null, dopplerAmount: 1 };
}

/** `a` without its mix keys. */
function engineKeys(a: AudioSettings): Omit<AudioSettings, (typeof MIX_KEYS)[number]> {
  const out = { ...a } as Record<string, unknown>;
  for (const k of MIX_KEYS) delete out[k];
  return out as Omit<AudioSettings, (typeof MIX_KEYS)[number]>;
}

/** The default mix: Master with Music, SFX, UI and Voice (as the old section's default), no returns. */
export function defaultAudioProject(): AudioProject {
  return {
    format: AUDIO_PROJECT_FORMAT,
    settings: defaultEngineSettings(),
    parameters: [],
    buses: [MASTER, "Music", "SFX", "UI", "Voice"].map((name, i) => newBus(name, i === 0 ? null : MASTER)),
    returns: [],
    vcas: [],
    automation: [],
    ducking: [],
    snapshots: [],
    loudness: { targets: DEFAULT_LOUDNESS_TARGETS.map((t) => ({ ...t })), resetOnPlay: true },
  };
}

/** A bus at unity with nothing on it (Master owns a bed and is metered). */
export function newBus(name: string, parent: string | null): Bus {
  const root = parent === null;
  return { name, parent, volumeDb: 0, mute: false, voiceLimit: null, bed: root ? { own: true, priority: ROOT_BED_PRIORITY } : null, meter: root, effects: [], sends: [] };
}

// --- parse ------------------------------------------------------------------------------------------------------------

function parseEngineSettings(raw: unknown, options: AudioParseOptions, problems: string[]): AudioEngineSettings {
  if (raw === undefined) return defaultEngineSettings();
  if (!isRecord(raw)) {
    problems.push("settings: must be an object; using the defaults.");
    return defaultEngineSettings();
  }
  const input: Record<string, unknown> = { ...raw };
  for (const k of MIX_KEYS) {
    if (input[k] === undefined) continue;
    problems.push(`settings.${k}: the mix lives at the top level of audio.json; ignored here.`);
    delete input[k];
  }
  delete input.submixes; delete input.bedBeyond; delete input.dopplerAmount;
  const parsed = parseAudioSettings(input, options);
  for (const p of parsed.problems) problems.push(p.replace(/^audio\.?/, "settings."));
  const out: AudioEngineSettings = {
    ...engineKeys(parsed.settings),
    submixes: ranged(raw.submixes, "settings.submixes", MIX_LIMITS.submixes, DEFAULT_SUBMIXES, problems, true),
    bedBeyond: null,
    dopplerAmount: ranged(raw.dopplerAmount, "settings.dopplerAmount", MIX_LIMITS.dopplerAmount, 1, problems),
  };
  if (raw.bedBeyond !== undefined && raw.bedBeyond !== null) {
    if (isNum(raw.bedBeyond) && raw.bedBeyond > 0) out.bedBeyond = raw.bedBeyond;
    else problems.push("settings.bedBeyond: must be a distance above 0 or null; using null.");
  }
  return out;
}

/** The first `fxN` not in `taken`. */
export function freeEffectId(taken: ReadonlySet<string> | readonly string[]): string {
  const has = (id: string) => (Array.isArray(taken) ? (taken as readonly string[]).includes(id) : (taken as ReadonlySet<string>).has(id));
  let n = 1;
  while (has(`fx${n}`)) n++;
  return `fx${n}`;
}

/** A bus's or return's insert chain: the catalogue's parse at the bus level (ADR 0331), at most `effectsPerOwner`. */
const parseEffects = (raw: unknown, where: string, problems: string[]): Effect[] =>
  raw === undefined ? [] : parseEffectChain(raw, "bus", where, problems, MIX_LIMITS.effectsPerOwner);

const dbOf = (raw: unknown, where: string, problems: string[], fallback = 0) => ranged(raw, where, MIX_LIMITS.db, fallback, problems);

/** Read `audio.json` leniently: never throws. `options` as for `parseAudioSettings` (the project's physics layers). */
export function parseAudioProject(raw: unknown, options: AudioParseOptions = {}): AudioProjectParse {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (raw === undefined) return { project: defaultAudioProject(), problems, warnings };
  if (!isRecord(raw)) return { project: defaultAudioProject(), problems: ["audio.json must hold an object; using the default mix."], warnings };
  if (raw.format !== AUDIO_PROJECT_FORMAT) problems.push(`format: expected "${AUDIO_PROJECT_FORMAT}", found ${JSON.stringify(raw.format)}; read as ${AUDIO_PROJECT_FORMAT}.`);
  const project = defaultAudioProject();
  project.settings = parseEngineSettings(raw.settings, options, problems);
  project.parameters = parseParameters(raw.parameters, "parameters", problems);
  const names = new Set<string>();
  const nameOk = (name: unknown, where: string): name is string => {
    if (typeof name !== "string" || name.trim() === "") return void problems.push(`${where}: name must be a non-empty string; dropped.`), false;
    if (names.has(name)) return void problems.push(`${where}: "${name}" is taken (names are unique across buses, returns and VCAs); dropped.`), false;
    return true;
  };

  // Buses: Master first, every other bus under an existing bus, no loops.
  if (raw.buses !== undefined) {
    const buses: Bus[] = [];
    const rawSends = new Map<Bus, unknown>();
    if (!Array.isArray(raw.buses)) problems.push("buses: must be a list; using the default buses.");
    else raw.buses.forEach((b, i) => {
      const where = `buses[${i}]`;
      if (!isRecord(b)) return void problems.push(`${where}: must be an object; dropped.`);
      if (!nameOk(b.name, where)) return;
      if (buses.length >= MAX_BUSES) return void problems.push(`${where}: at most ${MAX_BUSES} buses; dropped.`);
      names.add(b.name);
      const bus: Bus = {
        name: b.name,
        parent: typeof b.parent === "string" ? b.parent : null,
        volumeDb: dbOf(b.volumeDb, `${where}.volumeDb`, problems),
        mute: bool(b.mute, `${where}.mute`, false, problems),
        voiceLimit: null,
        bed: null,
        meter: bool(b.meter, `${where}.meter`, false, problems),
        effects: parseEffects(b.effects, `${where}.effects`, problems),
        sends: [],
      };
      if (b.voiceLimit !== undefined && b.voiceLimit !== null) bus.voiceLimit = ranged(b.voiceLimit, `${where}.voiceLimit`, [1, project.settings.voices.logical], project.settings.voices.logical, problems, true);
      if (b.bed !== undefined && b.bed !== null) {
        if (!isRecord(b.bed)) problems.push(`${where}.bed: must be { own, priority } or null; using null.`);
        else bus.bed = { own: bool(b.bed.own, `${where}.bed.own`, true, problems), priority: ranged(b.bed.priority, `${where}.bed.priority`, BED_PRIORITY_LIMITS, DEFAULT_BED_PRIORITY, problems, true) };
      }
      if (b.parent !== undefined && b.parent !== null && typeof b.parent !== "string") problems.push(`${where}.parent: must be a bus name or null.`);
      rawSends.set(bus, b.sends);
      buses.push(bus);
    });
    if (Array.isArray(raw.buses)) {
      // The master bus is the one named "Master", else the first (the old section let the root have any name).
      let root = buses.find((b) => b.name === MASTER) ?? buses[0];
      if (!root) {
        problems.push(`buses: the list has no bus; using a "${MASTER}" bus.`);
        root = newBus(MASTER, null);
        names.add(MASTER);
      } else if (buses[0] !== root) problems.push(`buses: "${root.name}" (the master bus) must come first; moved.`);
      const rest = buses.filter((b) => b !== root);
      if (root.parent !== null) problems.push(`buses: "${root.name}" (the master bus) can't have a parent; using null.`);
      root.parent = null;
      if (root.bed === null) root.bed = { own: true, priority: ROOT_BED_PRIORITY };
      project.buses = [root, ...rest];
      for (const b of rest) {
        if (b.parent === null || b.parent === b.name || !project.buses.some((o) => o.name === b.parent)) {
          problems.push(`buses: "${b.name}" ${b.parent === null ? "has no parent" : `names the unknown parent "${b.parent}"`}; using "${root.name}".`);
          b.parent = root.name;
        }
      }
      for (const b of rest) {
        const seen = new Set([b.name]);
        for (let p = project.buses.find((o) => o.name === b.parent); p; p = project.buses.find((o) => o.name === p!.parent)) {
          if (seen.has(p.name)) { problems.push(`buses: "${b.name}" is in a parent loop; using "${root.name}".`); b.parent = root.name; break; }
          seen.add(p.name);
        }
      }
      // Returns before sends, so a send can name one.
      project.returns = parseReturns(raw.returns, project, nameOk, names, problems);
      for (const [bus, sends] of rawSends) bus.sends = parseSends(sends, bus, project, problems);
    }
  } else {
    for (const b of project.buses) names.add(b.name);
    project.returns = parseReturns(raw.returns, project, nameOk, names, problems);
  }
  project.vcas = parseVcas(raw.vcas, project, nameOk, names, problems);
  project.automation = parseAutomation(raw.automation, project, problems);
  project.ducking = parseDucking(raw.ducking, project, problems);
  project.snapshots = parseSnapshots(raw.snapshots, project, problems);
  project.loudness = parseLoudness(raw.loudness, problems);
  return { project, problems, warnings };
}

type NameCheck = (name: unknown, where: string) => name is string;

function parseReturns(raw: unknown, project: AudioProject, nameOk: NameCheck, names: Set<string>, problems: string[]): Return[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return void problems.push("returns: must be a list; ignored."), [];
  const out: Return[] = [];
  raw.forEach((r, i) => {
    const where = `returns[${i}]`;
    if (!isRecord(r)) return void problems.push(`${where}: must be an object; dropped.`);
    if (!nameOk(r.name, where)) return;
    if (out.length >= MIX_LIMITS.returns) return void problems.push(`${where}: at most ${MIX_LIMITS.returns} returns; dropped.`);
    names.add(r.name);
    let output = project.buses[0].name;
    if (r.output !== undefined) {
      if (typeof r.output === "string" && project.buses.some((b) => b.name === r.output)) output = r.output;
      else problems.push(`${where}.output: must name a bus; using "${output}".`);
    }
    out.push({ name: r.name, output, volumeDb: dbOf(r.volumeDb, `${where}.volumeDb`, problems), mute: bool(r.mute, `${where}.mute`, false, problems), effects: parseEffects(r.effects, `${where}.effects`, problems) });
  });
  return out;
}

function parseSends(raw: unknown, bus: Bus, project: AudioProject, problems: string[]): Send[] {
  const where = `buses "${bus.name}".sends`;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return void problems.push(`${where}: must be a list; ignored.`), [];
  if (bus.parent === null && raw.length > 0) return void problems.push(`${where}: the master bus can't send; dropped.`), [];
  const out: Send[] = [];
  raw.forEach((s, i) => {
    if (!isRecord(s) || typeof s.to !== "string" || !project.returns.some((r) => r.name === s.to)) return void problems.push(`${where}[${i}]: to must name a return; dropped.`);
    if (out.some((o) => o.to === s.to)) return void problems.push(`${where}[${i}]: a second send to "${s.to}"; dropped.`);
    out.push({ to: s.to, levelDb: dbOf(s.levelDb, `${where}[${i}].levelDb`, problems) });
  });
  return out;
}

function parseVcas(raw: unknown, project: AudioProject, nameOk: NameCheck, names: Set<string>, problems: string[]): Vca[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return void problems.push("vcas: must be a list; ignored."), [];
  const out: Vca[] = [];
  raw.forEach((v, i) => {
    const where = `vcas[${i}]`;
    if (!isRecord(v)) return void problems.push(`${where}: must be an object; dropped.`);
    if (!nameOk(v.name, where)) return;
    if (out.length >= MIX_LIMITS.vcas) return void problems.push(`${where}: at most ${MIX_LIMITS.vcas} VCAs; dropped.`);
    names.add(v.name);
    const members: string[] = [];
    if (v.members !== undefined && !Array.isArray(v.members)) problems.push(`${where}.members: must be a list of bus names; ignored.`);
    for (const m of Array.isArray(v.members) ? v.members : []) {
      if (typeof m !== "string" || !project.buses.some((b) => b.name === m)) problems.push(`${where}.members: ${JSON.stringify(m)} isn't a bus; dropped.`);
      else if (!members.includes(m)) members.push(m);
    }
    out.push({ name: v.name, volumeDb: dbOf(v.volumeDb, `${where}.volumeDb`, problems), members });
  });
  return out;
}

/** A bus or return by name. */
const ownerOf = (project: AudioProject, name: unknown): Bus | Return | undefined =>
  typeof name === "string" ? (project.buses.find((b) => b.name === name) ?? project.returns.find((r) => r.name === name)) : undefined;

function parseAutomation(raw: unknown, project: AudioProject, problems: string[]): MixAutomation[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return void problems.push("automation: must be a list; ignored."), [];
  const out: MixAutomation[] = [];
  raw.forEach((a, i) => {
    const where = `automation[${i}]`;
    if (!isRecord(a)) return void problems.push(`${where}: must be an object; dropped.`);
    if (out.length >= MIX_LIMITS.automation) return void problems.push(`${where}: at most ${MIX_LIMITS.automation} automations; dropped.`);
    const owner = ownerOf(project, a.on);
    if (!owner) return void problems.push(`${where}: on must name a bus or return; dropped.`);
    if (typeof a.parameter !== "string" || !project.parameters.some((p) => p.name === a.parameter)) return void problems.push(`${where}: parameter must name a global parameter; dropped.`);
    const target = a.target;
    if (typeof target !== "string") return void problems.push(`${where}: target must be "volume", "send:<return>" or "fx:<effect>:<param>"; dropped.`);
    if (target.startsWith("send:")) {
      const to = target.slice(5);
      if (!("sends" in owner) || !owner.sends.some((s) => s.to === to)) return void problems.push(`${where}: ${owner.name} has no send to "${to}"; dropped.`);
    } else if (target.startsWith("fx:")) {
      const [, id, name] = target.split(":");
      if (!id || !name || target.split(":").length !== 3) return void problems.push(`${where}: target "${target}" must be fx:<effect id>:<param>; dropped.`);
      if (!owner.effects.some((e) => e.id === id)) return void problems.push(`${where}: ${owner.name} has no effect "${id}"; dropped.`);
    } else if (target !== "volume") return void problems.push(`${where}: target must be "volume", "send:<return>" or "fx:<effect>:<param>"; dropped.`);
    const curve = audioCurve(a.curve, `${where}.curve`, problems);
    if (!curve) return void problems.push(`${where}: the curve has no keys; dropped.`);
    out.push({ on: owner.name, target: target as MixAutomation["target"], parameter: a.parameter, curve, bypass: bool(a.bypass, `${where}.bypass`, false, problems) });
  });
  return out;
}

/** The parent of a bus, or a return's output. */
const upOf = (project: AudioProject, name: string): string | null => {
  const b = project.buses.find((o) => o.name === name);
  if (b) return b.parent;
  return project.returns.find((r) => r.name === name)?.output ?? null;
};

/** True when `ancestor` is `name` or above it (through parents and a return's output). */
function isAbove(project: AudioProject, ancestor: string, name: string): boolean {
  const seen = new Set<string>();
  for (let at: string | null = name; at !== null && !seen.has(at); at = upOf(project, at)) {
    if (at === ancestor) return true;
    seen.add(at);
  }
  return false;
}

function parseDucking(raw: unknown, project: AudioProject, problems: string[]): DuckingRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return void problems.push("ducking: must be a list; ignored."), [];
  const out: DuckingRule[] = [];
  raw.forEach((d, i) => {
    const where = `ducking[${i}]`;
    if (out.length >= MAX_DUCK_RULES) return void (out.length === MAX_DUCK_RULES && i === MAX_DUCK_RULES && problems.push(`ducking: at most ${MAX_DUCK_RULES} rules; the rest are dropped.`));
    if (!isRecord(d) || !ownerOf(project, d.target) || !ownerOf(project, d.trigger)) return void problems.push(`${where}: target and trigger must name buses or returns; dropped.`);
    const target = d.target as string, trigger = d.trigger as string;
    if (isAbove(project, trigger, target)) return void problems.push(`${where}: the trigger "${trigger}" is ${trigger === target ? "the target" : `above "${target}"`}, so its level can't be measured before "${target}" is mixed; dropped.`);
    if (d.mode !== "presence" && d.mode !== "level") return void problems.push(`${where}: mode must be "presence" or "level"; dropped.`);
    if (d.mode === "level" && out.filter((r) => r.mode === "level").length >= MAX_LEVEL_RULES) return void problems.push(`${where}: at most ${MAX_LEVEL_RULES} level rules; dropped.`);
    let detector = DEFAULT_DUCK_DETECTOR;
    if (d.detector !== undefined) {
      if (d.detector === "peak" || d.detector === "rms") detector = d.detector;
      else problems.push(`${where}.detector: must be "peak" or "rms"; using "${DEFAULT_DUCK_DETECTOR}".`);
    }
    out.push({
      target, trigger, mode: d.mode, detector,
      thresholdDb: ranged(d.thresholdDb, `${where}.thresholdDb`, MIX_LIMITS.thresholdDb, DEFAULT_DUCK_THRESHOLD, problems),
      amountDb: ranged(d.amountDb, `${where}.amountDb`, MIX_LIMITS.amountDb, DEFAULT_DUCK_AMOUNT_DB, problems),
      attackMs: ranged(d.attackMs, `${where}.attackMs`, MIX_LIMITS.duckMs, DEFAULT_DUCK_ATTACK_MS, problems),
      releaseMs: ranged(d.releaseMs, `${where}.releaseMs`, MIX_LIMITS.duckMs, DEFAULT_DUCK_RELEASE_MS, problems),
      enabled: bool(d.enabled, `${where}.enabled`, true, problems),
    });
  });
  return out;
}

function parseStart(raw: unknown, where: string, project: AudioProject, problems: string[]): SnapshotStart {
  if (raw === undefined) return { kind: "code" };
  if (!isRecord(raw) || !["base", "code", "never", "conditions"].includes(raw.kind as string)) {
    problems.push(`${where}: kind must be "base", "code", "never" or "conditions"; using "code".`);
    return { kind: "code" };
  }
  if (raw.kind !== "conditions") return { kind: raw.kind as "base" | "code" | "never" };
  let match: "all" | "any" = "all";
  if (raw.match !== undefined) {
    if (raw.match === "all" || raw.match === "any") match = raw.match;
    else problems.push(`${where}.match: must be "all" or "any"; using "all".`);
  }
  const conditions: SnapshotCondition[] = [];
  if (raw.conditions !== undefined && !Array.isArray(raw.conditions)) problems.push(`${where}.conditions: must be a list; ignored.`);
  (Array.isArray(raw.conditions) ? raw.conditions : []).forEach((c: unknown, i: number) => {
    const w = `${where}.conditions[${i}]`;
    if (!isRecord(c) || typeof c.parameter !== "string" || !project.parameters.some((p) => p.name === c.parameter)) return void problems.push(`${w}: parameter must name a global parameter; dropped.`);
    if (!CONDITION_OPS.includes(c.op as ConditionOp)) return void problems.push(`${w}: op must be one of ${CONDITION_OPS.join(", ")}; dropped.`);
    if (!isNum(c.value) && typeof c.value !== "string") return void problems.push(`${w}: value must be a number or a label; dropped.`);
    const cond: SnapshotCondition = { parameter: c.parameter, op: c.op as ConditionOp, value: c.value };
    if (c.op === "between") {
      if (!isNum(c.value) || !isNum(c.value2)) return void problems.push(`${w}: between needs two numbers, value and value2; dropped.`);
      cond.value2 = c.value2;
    }
    conditions.push(cond);
  });
  return { kind: "conditions", match, conditions };
}

function parseSnapshots(raw: unknown, project: AudioProject, problems: string[]): Snapshot[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return void problems.push("snapshots: must be a list; ignored."), [];
  const out: Snapshot[] = [];
  raw.forEach((s, i) => {
    const where = `snapshots[${i}]`;
    if (!isRecord(s) || typeof s.name !== "string" || s.name.trim() === "") return void problems.push(`${where}: name must be a non-empty string; dropped.`);
    if (out.some((o) => o.name === s.name)) return void problems.push(`${where}: another snapshot is already named "${s.name}"; dropped.`);
    if (out.length >= MIX_LIMITS.snapshots) return void problems.push(`${where}: at most ${MIX_LIMITS.snapshots} snapshots; dropped.`);
    let combine: Snapshot["combine"] = "override";
    if (s.combine !== undefined) {
      if (s.combine === "override" || s.combine === "add") combine = s.combine;
      else problems.push(`${where}.combine: must be "override" or "add"; using "override".`);
    }
    const buses: Record<string, number> = {};
    if (s.buses !== undefined && !isRecord(s.buses)) problems.push(`${where}.buses: must be an object of dB offsets; ignored.`);
    for (const [name, v] of Object.entries(isRecord(s.buses) ? s.buses : {})) {
      if (!ownerOf(project, name)) problems.push(`${where}.buses: "${name}" isn't a bus or return; dropped.`);
      else if (!isNum(v)) problems.push(`${where}.buses.${name}: must be a number of dB; dropped.`);
      else buses[name] = dbOf(v, `${where}.buses.${name}`, problems);
    }
    const effects: Snapshot["effects"] = {};
    if (s.effects !== undefined && !isRecord(s.effects)) problems.push(`${where}.effects: must be an object; ignored.`);
    for (const [name, byId] of Object.entries(isRecord(s.effects) ? s.effects : {})) {
      const owner = ownerOf(project, name);
      if (!owner || !isRecord(byId)) { problems.push(`${where}.effects: "${name}" isn't a bus or return; dropped.`); continue; }
      for (const [id, params] of Object.entries(byId)) {
        if (!owner.effects.some((e) => e.id === id) || !isRecord(params)) { problems.push(`${where}.effects.${name}: ${owner.name} has no effect "${id}"; dropped.`); continue; }
        for (const [p, v] of Object.entries(params)) {
          if (!isNum(v)) { problems.push(`${where}.effects.${name}.${id}.${p}: must be a number; dropped.`); continue; }
          ((effects[name] ??= {})[id] ??= {})[p] = v;
        }
      }
    }
    out.push({
      name: s.name,
      folder: typeof s.folder === "string" ? s.folder : (s.folder !== undefined && problems.push(`${where}.folder: must be a folder path; using "".`), ""),
      start: parseStart(s.start, `${where}.start`, project, problems),
      fadeInMs: ranged(s.fadeInMs, `${where}.fadeInMs`, MIX_LIMITS.snapshotMs, DEFAULT_SNAPSHOT_FADE_MS, problems),
      fadeOutMs: ranged(s.fadeOutMs, `${where}.fadeOutMs`, MIX_LIMITS.snapshotMs, DEFAULT_SNAPSHOT_FADE_MS, problems),
      holdMs: ranged(s.holdMs, `${where}.holdMs`, MIX_LIMITS.snapshotMs, 0, problems),
      priority: ranged(s.priority, `${where}.priority`, MIX_LIMITS.snapshotPriority, DEFAULT_SNAPSHOT_PRIORITY, problems, true),
      combine, buses, effects,
    });
  });
  return out;
}

/** `loudness`: the targets by `parseAudioSettings`' rules (absent: the defaults), and `resetOnPlay` (absent: true). */
function parseLoudness(raw: unknown, problems: string[]): AudioProject["loudness"] {
  const out = { targets: DEFAULT_LOUDNESS_TARGETS.map((t) => ({ ...t })), resetOnPlay: true };
  if (raw === undefined) return out;
  if (!isRecord(raw)) return void problems.push("loudness: must be an object; using the defaults."), out;
  const parsed = parseAudioSettings({ loudnessTargets: raw.targets, loudnessResetOnPlay: raw.resetOnPlay });
  for (const p of parsed.problems) problems.push(p.replace(/^audio\.loudnessTargets/, "loudness.targets").replace(/^audio\.loudnessResetOnPlay/, "loudness.resetOnPlay"));
  if (parsed.settings.loudnessTargets) out.targets = parsed.settings.loudnessTargets;
  out.resetOnPlay = parsed.settings.loudnessResetOnPlay !== false;
  return out;
}

// --- write ------------------------------------------------------------------------------------------------------------

/**
 * `project` as `audio.json`'s JSON value (`JSON.stringify(v, null, 2)` for the file). Engine settings at their default
 * are left out, and so are built-in occlusion materials left as they ship (the parse re-adds both); everything else is
 * written, so `parseAudioProject(audioProjectToJson(p)).project` equals `p`.
 */
export function audioProjectToJson(project: AudioProject): Record<string, unknown> {
  const clone = <T>(v: T): T => structuredClone(v);
  return {
    format: AUDIO_PROJECT_FORMAT,
    settings: settingsToJson(project.settings),
    parameters: clone(project.parameters),
    buses: project.buses.map((b) => ({ name: b.name, parent: b.parent, volumeDb: b.volumeDb, mute: b.mute, voiceLimit: b.voiceLimit, bed: b.bed && { ...b.bed }, meter: b.meter, effects: effectsToJson(b.effects), sends: b.sends.map((s) => ({ ...s })) })),
    returns: project.returns.map((r) => ({ name: r.name, output: r.output, volumeDb: r.volumeDb, mute: r.mute, effects: effectsToJson(r.effects) })),
    vcas: project.vcas.map((v) => ({ name: v.name, volumeDb: v.volumeDb, members: [...v.members] })),
    automation: project.automation.map((a) => ({ on: a.on, target: a.target, parameter: a.parameter, curve: clone(a.curve), bypass: a.bypass })),
    ducking: project.ducking.map((d) => ({ ...d })),
    snapshots: project.snapshots.map((s) => clone(s)),
    loudness: { targets: project.loudness.targets.map((t) => ({ ...t })), resetOnPlay: project.loudness.resetOnPlay },
  };
}

function settingsToJson(s: AudioEngineSettings): Record<string, unknown> {
  const defaults = defaultEngineSettings() as unknown as Record<string, unknown>;
  const pruned = { ...s, occlusion: { ...s.occlusion, materials: s.occlusion.materials.filter((m) => { const b = BUILTIN_MATERIALS.find((x) => x.name === m.name); return !b || !sameMaterial(m, b); }) } };
  const defaultPruned = { ...(defaults.occlusion as AudioEngineSettings["occlusion"]), materials: [] };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(pruned)) {
    if (v === undefined) continue;
    const d = k === "occlusion" ? defaultPruned : defaults[k];
    if (JSON.stringify(v) !== JSON.stringify(d)) out[k] = structuredClone(v);
  }
  return out;
}

// --- the runtime's view ----------------------------------------------------------------------------------------------

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

/** The return a bus's legacy reverb send stands for: the first of its sends to a return with an `on` reverb. */
export function reverbSendOf(project: Pick<AudioProject, "returns">, bus: Bus): { send: Send; ret: Return } | null {
  for (const send of bus.sends) {
    const ret = project.returns.find((r) => r.name === send.to);
    if (ret && ret.effects.some((e) => e.type === "reverb" && e.on)) return { send, ret };
  }
  return null;
}

const clampGain = (g: number, max: number) => Math.min(max, Math.max(0, g));
const curveToGain = (curve: Curve): CurveKey[] => curve.map((k) => (k.length === 3 ? [k[0], dbToGain(k[1]), k[2]] : [k[0], dbToGain(k[1])]) as CurveKey);

/** The runtime bus of `bus` (warnings into `warn`). */
function runtimeBus(project: AudioProject, bus: Bus, warn: (line: string) => void): BusSettings {
  const root = bus.parent === null;
  const out: BusSettings = { name: bus.name, ...(root ? {} : { parent: bus.parent! }), volume: clampGain(dbToGain(bus.volumeDb + vcaOffsetDb(project, bus.name)), 2), mute: bus.mute, effects: [] };
  for (const e of bus.effects) {
    if (isShown(project, bus.name, e)) {
      const lost: string[] = [];
      out.effects.push(toBusEffect(e, lost));
      if (lost.length > 0) warn(`bus "${bus.name}": the ${e.type} "${e.id}" ${lost.join(" and ")} needs the new mixer; left out until then.`);
    } else if (e.on && !isCarrier(project, bus.name, e)) warn(`bus "${bus.name}": the ${e.type} effect "${e.id}" needs the new mixer; left out until then.`);
  }
  const reverb = reverbSendOf(project, bus);
  for (const s of bus.sends) {
    if (reverb && s === reverb.send) {
      const g = reverb.ret.mute ? 0 : dbToGain(s.levelDb + reverb.ret.volumeDb);
      if (g > 1) warn(`bus "${bus.name}": the send to "${s.to}" is above the runtime's reverb send of 1; using 1.`);
      out.effects.push({ type: "reverb", send: clampGain(g, 1) });
    } else warn(`bus "${bus.name}": the send to "${s.to}" needs the new mixer; left out until then.`);
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

/**
 * `project` as the runtime's current mix model (ADR 0330 until the runtime runs the whole mix): levels in linear gain
 * with each bus's VCA offsets folded in; a send to a return holding a reverb becomes the old `reverb` send effect (its
 * level plus the return's); snapshot offsets become multipliers and a snapshot override of a low-pass cutoff the old
 * snapshot low-pass; `volume` automation becomes the old volume automation (its dB curve as multipliers) and
 * `fx:<id>:cutoff` on a low-pass the old low-pass automation. What the runtime can't express is left out of this view
 * only (never out of the file), with one line in `warnings` each. Disabled ducking rules and bypassed effects and
 * automation are left out silently: the runtime wouldn't play them.
 */
export function toRuntimeSettings(project: AudioProject, warnings: string[] = []): AudioSettings {
  const warn = (line: string) => void warnings.push(line);
  const { submixes: _submixes, bedBeyond, dopplerAmount, ...engine } = project.settings;
  // TODO(ADR 0333): `bedBeyond` needs the audio core's panner pick to send a voice past it to its bus's bed (it picks beds
  // by HRTF rank only today); the runtime view leaves it out until then.
  if (bedBeyond !== null) warn("settings.bedBeyond needs the audio core's distance-based beds; beds go by HRTF rank until then.");
  const isBus = (name: string) => project.buses.some((b) => b.name === name);
  const out: AudioSettings = { ...structuredClone(engine), buses: [], snapshots: [], ducking: [], parameters: structuredClone(project.parameters), automation: [] };
  // ADR 0333: the global Doppler amount scales every voice's Doppler level (the Doppler pass reads it).
  if (dopplerAmount !== 1) out.doppler = { ...out.doppler, amount: dopplerAmount };
  out.buses = project.buses.map((b) => runtimeBus(project, b, warn));
  for (const r of project.returns) {
    if (r.output !== project.buses[0]?.name) warn(`return "${r.name}": its output "${r.output}" needs the new mixer; it plays into the master bus until then.`);
    for (const e of r.effects) if (e.on && e.type !== "reverb") warn(`return "${r.name}": the ${e.type} effect "${e.id}" needs the new mixer; left out until then.`);
  }

  for (const s of project.snapshots) {
    if (s.start.kind === "base" || s.start.kind === "conditions") warn(`snapshot "${s.name}": starting ${s.start.kind === "base" ? "with the base mix" : "on conditions"} needs the new mixer; it starts from code until then.`);
    if (s.combine === "add") warn(`snapshot "${s.name}": Add needs the new mixer; it overrides until then.`);
    const snap: SnapshotSettings = { name: s.name, volumes: {}, lowpass: {} };
    for (const [name, db] of Object.entries(s.buses)) {
      if (isBus(name)) snap.volumes[name] = clampGain(dbToGain(db), 2);
      else warn(`snapshot "${s.name}": the offset on "${name}" needs the new mixer; left out until then.`);
    }
    for (const [name, byId] of Object.entries(s.effects)) {
      const bus = project.buses.find((b) => b.name === name);
      for (const [id, params] of Object.entries(byId)) {
        const e = bus?.effects.find((x) => x.id === id);
        for (const [p, v] of Object.entries(params)) {
          if (bus && e?.type === "lowpass" && p === "cutoff") snap.lowpass[name] = Math.min(snap.lowpass[name] ?? Infinity, v);
          else warn(`snapshot "${s.name}": the override of ${name} ${id}.${p} needs the new mixer; left out until then.`);
        }
      }
    }
    out.snapshots.push(snap);
  }

  for (const d of project.ducking) {
    if (!d.enabled) continue;
    if (!isBus(d.target) || !isBus(d.trigger)) { warn(`ducking: "${d.trigger}" ducking "${d.target}" needs the new mixer (a return); left out until then.`); continue; }
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
    else warn(`automation: ${a.target} on "${a.on}" needs the new mixer; left out until then.`);
  }

  const t = project.loudness.targets;
  const same = t.length === DEFAULT_LOUDNESS_TARGETS.length && t.every((x, i) => JSON.stringify(x) === JSON.stringify(DEFAULT_LOUDNESS_TARGETS[i]));
  if (!same) out.loudnessTargets = structuredClone(t) as LoudnessTarget[];
  if (!project.loudness.resetOnPlay) out.loudnessResetOnPlay = false;
  return out;
}
