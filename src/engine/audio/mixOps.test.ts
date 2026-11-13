// L-Mo1a (api-and-models §6.2; the M5c table row's acceptance): `invert` round trip for every op, and `diffOps(a, b)`
// applied to `a` gives `b`, including property-style random settings pairs. Skeleton by Mo1; the leaf fills the cases.
import { describe, expect, it } from "vitest";
import { applyOpToSettings, diffOps, invert, LIVE_KEYS, opRefusal, type MixOp } from "./mixOps";
import type { ParameterDef } from "./eventFormat";
import {
  BUS_BEDS, DEFAULT_BED_PRIORITY, defaultAudioSettings, ROOT_BED_PRIORITY,
  type AudioSettings, type BusAutomation, type BusEffect, type BusSettings, type DuckingRule, type LoudnessTarget, type SnapshotSettings,
} from "./settings";

// --- seeded generators and checks -----------------------------------------------------------------------------------------

type Rng = () => number;

/** mulberry32: a small seeded PRNG, so a failing pair replays from its seed (the failure message names it). */
function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (rng: Rng, lo: number, hi: number): number => lo + rng() * (hi - lo);
const int = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
const chance = (rng: Rng, p: number): boolean => rng() < p;
/** Three decimals, and never -0 (`toEqual` tells -0 from 0). */
const r3 = (x: number): number => Math.round(x * 1000) / 1000 + 0;
const notOne = (v: number): number => (v === 1 ? 0.5 : v);
function choose<T>(rng: Rng, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)] as T;
}
function shuffle<T>(rng: Rng, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** §2.1, written out here so the checks test the contract rather than the code under test. */
const METER_LIMIT = 8;
const TARGET_LIMIT = 8;
const TARGET_NAME_LIMIT = 32;
const DEFAULT_TARGETS: LoudnessTarget[] = [
  { name: "console", integrated: -24, tolerance: 2, truePeak: -1 },
  { name: "mobile", integrated: -18, tolerance: 2, truePeak: -1 },
];
const ROOT_NAMES = ["Master", "Main", "Output"] as const;
const CHILD_NAMES = ["Music", "SFX", "UI", "Voice", "Ambience", "Lead", "Pad", "Crowd", "Foley", "Dialog"] as const;
const SNAPSHOT_NAMES = ["Paused", "Menu", "Cutscene", "Muffled"] as const;
const TARGET_NAMES = ["console", "mobile", "podcast", "cinematic", "broadcast", "web", "stream", "cinema"] as const;
/** The global parameters every generated settings has: a rule can't name a parameter the other side lacks, so a pair never differs in them. */
const PARAMS: ParameterDef[] = [
  { name: "Intensity", min: 0, max: 1, default: 0.5, seekSpeed: 1 },
  { name: "Area", labels: ["Outdoor", "Cave"], default: "Outdoor" },
];
/** Every top-level `AudioSettings` key that no live op serves (the complement of `LIVE_KEYS`). */
const NON_LIVE_KEYS = [
  "parameters", "seed", "voices", "background", "clipMemoryMB", "clipFormat", "codecs", "spatial", "backend", "limiterLookaheadMs",
  "bed", "ambisonic", "occlusion", "zones", "doppler", "speedOfSound", "music", "rhythmMode",
] as const satisfies readonly (keyof AudioSettings)[];

/** Deep equality for plain data; an absent key and an `undefined` one are the same, as `toEqual` treats them. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ra = a as Record<string, unknown>, rb = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) if (!same(ra[k], rb[k])) return false;
  return true;
}

/** True when `ancestor` is above `name` in the tree (walks the parent links). */
function isAncestor(buses: readonly BusSettings[], ancestor: string, name: string): boolean {
  let p = buses.find((b) => b.name === name)?.parent;
  for (let steps = 0; p !== undefined && steps <= buses.length; steps++) {
    if (p === ancestor) return true;
    const from = p;
    p = buses.find((b) => b.name === from)?.parent;
  }
  return false;
}

function hasCycle(nodes: readonly string[], edges: readonly [string, string][]): boolean {
  const adj = new Map<string, string[]>(nodes.map((n): [string, string[]] => [n, []]));
  for (const [from, to] of edges) adj.get(from)?.push(to);
  const state = new Map<string, "visiting" | "done">();
  const visit = (n: string): boolean => {
    const s = state.get(n);
    if (s === "visiting") return true;
    if (s === "done") return false;
    state.set(n, "visiting");
    for (const m of adj.get(n) ?? []) if (visit(m)) return true;
    state.set(n, "done");
    return false;
  };
  return nodes.some(visit);
}

/** §2.2 rule 2: child-to-parent edges plus one trigger-to-target edge per level rule. */
function levelCycle(buses: readonly BusSettings[], rules: readonly DuckingRule[]): boolean {
  const edges: [string, string][] = [];
  for (const b of buses) if (b.parent !== undefined) edges.push([b.name, b.parent]);
  for (const r of rules) if (r.mode === "level") edges.push([r.trigger, r.target]);
  return hasCycle(buses.map((b) => b.name), edges);
}

/** What the canonical form forbids (api-and-models §2.1 and the canonical-form note in mixOps.ts). [] when canonical. */
function canonicalProblems(s: AudioSettings): string[] {
  const names = s.buses.map((b) => b.name);
  if (names.length === 0) return ["no buses"];
  const problems: string[] = [];
  if (new Set(names).size !== names.length) problems.push("bus names are not unique");
  s.buses.forEach((b, i) => {
    const root = i === 0;
    if (root && b.parent !== undefined) problems.push(`${b.name}: the root has a parent`);
    if (!root && (b.parent === undefined || !names.includes(b.parent))) problems.push(`${b.name}: the parent is not a bus`);
    if (b.maxVoices !== undefined && !(Number.isInteger(b.maxVoices) && b.maxVoices >= 1 && b.maxVoices <= s.voices.logical)) {
      problems.push(`${b.name}: maxVoices outside 1..voices.logical`);
    }
    if (b.bed === (root ? "own" : "parent")) problems.push(`${b.name}: bed written at its default`);
    if (b.bedPriority !== undefined) {
      const bad = !Number.isInteger(b.bedPriority) || b.bedPriority < 0 || b.bedPriority > 255;
      if (bad || b.bedPriority === (root ? ROOT_BED_PRIORITY : DEFAULT_BED_PRIORITY)) problems.push(`${b.name}: bedPriority`);
    }
    if (b.meter !== undefined && (root || b.meter !== "loudness")) problems.push(`${b.name}: meter on the root or not "loudness"`);
  });
  for (const b of s.buses) {
    let p = b.parent;
    for (let steps = 0; p !== undefined && steps <= s.buses.length; steps++) {
      if (p === b.name) { problems.push(`${b.name}: parent loop`); break; }
      const from = p;
      p = s.buses.find((o) => o.name === from)?.parent;
    }
  }
  if (s.buses.filter((b, i) => i > 0 && b.meter !== undefined).length > METER_LIMIT) problems.push("more than 8 metered buses");
  if (new Set(s.snapshots.map((x) => x.name)).size !== s.snapshots.length) problems.push("snapshot names are not unique");
  for (const snap of s.snapshots) {
    for (const bus of [...Object.keys(snap.volumes), ...Object.keys(snap.lowpass)]) {
      if (!names.includes(bus)) problems.push(`snapshot ${snap.name}: unknown bus ${bus}`);
    }
  }
  for (const r of s.ducking) {
    if (!names.includes(r.target) || !names.includes(r.trigger)) problems.push(`ducking ${r.target}<-${r.trigger}: unknown bus`);
    if (r.target === r.trigger) problems.push(`ducking ${r.target}: a bus ducks itself`);
    if (isAncestor(s.buses, r.trigger, r.target)) problems.push(`ducking ${r.target}<-${r.trigger}: the trigger is above the target`);
    if (r.mode !== "level" && r.mode !== "presence") problems.push(`ducking ${r.target}<-${r.trigger}: mode`);
    if (r.mode === "level" && (r.detector === undefined || r.threshold === undefined)) problems.push(`ducking ${r.target}: level rule without detector or threshold`);
  }
  if (levelCycle(s.buses, s.ducking)) problems.push("ducking: a level-rule cycle");
  for (const au of s.automation) {
    if (!names.includes(au.bus)) problems.push(`automation: unknown bus ${au.bus}`);
    if (!s.parameters.some((p) => p.name === au.parameter)) problems.push(`automation: unknown parameter ${au.parameter}`);
    if (au.curve.length === 0) problems.push("automation: empty curve");
  }
  if (s.loudnessTargets !== undefined) {
    const t = s.loudnessTargets;
    if (same(t, DEFAULT_TARGETS)) problems.push("loudnessTargets written at its default");
    if (t.length < 1 || t.length > TARGET_LIMIT) problems.push("loudnessTargets: 1..8 entries");
    if (new Set(t.map((x) => x.name)).size !== t.length) problems.push("loudnessTargets: names not unique");
    for (const x of t) {
      if (x.name === "" || x.name.length > TARGET_NAME_LIMIT) problems.push(`loudnessTargets: name "${x.name}"`);
      if (x.integrated < -70 || x.integrated > 0) problems.push(`loudnessTargets ${x.name}: integrated`);
      if (x.tolerance < 0 || x.tolerance > 12) problems.push(`loudnessTargets ${x.name}: tolerance`);
      if (x.truePeak < -20 || x.truePeak > 0) problems.push(`loudnessTargets ${x.name}: truePeak`);
    }
  }
  if (s.loudnessResetOnPlay !== undefined && s.loudnessResetOnPlay !== false) problems.push("loudnessResetOnPlay written as true");
  if (s.voices.mixed > s.voices.logical) problems.push("voices.mixed above voices.logical");
  return problems;
}

// --- fixtures -------------------------------------------------------------------------------------------------------------

/** A canonical settings with every kind of content: a child bus, effects of each type, snapshots, ducking, automation, meters, targets. */
function fixture(): AudioSettings {
  const s = defaultAudioSettings();
  s.parameters = structuredClone(PARAMS);
  s.buses = [
    { name: "Master", volume: 1, mute: false, effects: [] },
    {
      name: "Music", parent: "Master", volume: 0.8, mute: false, maxVoices: 16, meter: "loudness",
      effects: [{ type: "lowpass", frequency: 18000, q: 1 }, { type: "reverb", send: 0.2 }, { type: "highpass", frequency: 40, q: 0.7 }],
    },
    {
      name: "Lead", parent: "Music", volume: 0.6, mute: false, bed: "none", bedPriority: 200, meter: "loudness",
      effects: [{ type: "compressor", threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }],
    },
    { name: "SFX", parent: "Master", volume: 1, mute: false, effects: [{ type: "highpass", frequency: 120, q: 0.7 }] },
    { name: "UI", parent: "Master", volume: 0.9, mute: true, effects: [] },
    { name: "Voice", parent: "Master", volume: 1, mute: false, effects: [] },
  ];
  s.snapshots = [
    { name: "Paused", volumes: { Music: 0.3, SFX: 0 }, lowpass: { Music: 800 } },
    { name: "Menu", volumes: { UI: 0.5 }, lowpass: {} },
  ];
  s.ducking = [
    { target: "Music", trigger: "Voice", mode: "presence", amount: 0.4, attack: 0.1, release: 0.6 },
    { target: "SFX", trigger: "Voice", mode: "level", detector: "rms", threshold: -30, amount: 0.5, attack: 0.05, release: 0.4 },
  ];
  s.automation = [{ bus: "Music", parameter: "Intensity", target: "volume", curve: [[0, 0.4], [1, 1]] }];
  s.loudnessTargets = [
    { name: "console", integrated: -24, tolerance: 2, truePeak: -1 },
    { name: "mobile", integrated: -18, tolerance: 2, truePeak: -1 },
    { name: "podcast", integrated: -16, tolerance: 1, truePeak: -1.5 },
  ];
  s.loudnessResetOnPlay = false;
  return s;
}

/** Ten non-root buses, the first eight metered: the ninth meter toggle is refused. */
function nineMetered(): AudioSettings {
  const s = defaultAudioSettings();
  const buses: BusSettings[] = [{ name: "Master", volume: 1, mute: false, effects: [] }];
  for (let i = 1; i <= 9; i++) {
    const bus: BusSettings = { name: `B${i}`, parent: "Master", volume: 1, mute: false, effects: [] };
    if (i <= 8) bus.meter = "loudness";
    buses.push(bus);
  }
  s.buses = buses;
  return s;
}

/** The root and its children renamed in every reference (snapshots, ducking, automation, parents): the bus is renamed, not replaced. */
function renameByHand(s: AudioSettings, from: string, to: string): AudioSettings {
  const ren = (n: string): string => (n === from ? to : n);
  const renKeys = (rec: Record<string, number>): Record<string, number> =>
    Object.fromEntries(Object.entries(rec).map(([k, v]) => [ren(k), v]));
  const b = structuredClone(s);
  for (const bus of b.buses) {
    bus.name = ren(bus.name);
    if (bus.parent !== undefined) bus.parent = ren(bus.parent);
  }
  for (const snap of b.snapshots) {
    snap.volumes = renKeys(snap.volumes);
    snap.lowpass = renKeys(snap.lowpass);
  }
  for (const rule of b.ducking) {
    rule.target = ren(rule.target);
    rule.trigger = ren(rule.trigger);
  }
  for (const au of b.automation) au.bus = ren(au.bus);
  return b;
}

// --- random canonical settings --------------------------------------------------------------------------------------------

function randomEffects(rng: Rng): BusEffect[] {
  const out: BusEffect[] = [];
  let compressor = false;
  const count = int(rng, 0, 3);
  for (let i = 0; i < count; i++) {
    const kind = choose(rng, ["lowpass", "highpass", "compressor", "reverb"] as const);
    if (kind === "lowpass" || kind === "highpass") {
      out.push({ type: kind, frequency: r3(between(rng, 10, 24000)), q: r3(between(rng, 0.1, 30)) });
    } else if (kind === "compressor") {
      if (compressor) continue;
      compressor = true;
      out.push({
        type: "compressor", threshold: r3(between(rng, -100, 0)), knee: r3(between(rng, 0, 40)), ratio: r3(between(rng, 1, 20)),
        attack: r3(between(rng, 0, 1)), release: r3(between(rng, 0, 1)),
      });
    } else {
      out.push({ type: "reverb", send: r3(between(rng, 0, 1)) });
    }
  }
  return out;
}

/** Buses in list order: the root first, each child under an earlier bus (so the tree is acyclic). */
function randomBuses(rng: Rng, logical: number): BusSettings[] {
  const names: string[] = [choose(rng, ROOT_NAMES), ...shuffle(rng, CHILD_NAMES).slice(0, int(rng, 0, 6))];
  const buses: BusSettings[] = [];
  let metered = 0;
  names.forEach((name, i) => {
    const root = i === 0;
    const bus: BusSettings = { name, volume: r3(between(rng, 0, 2)), mute: chance(rng, 0.3), effects: randomEffects(rng) };
    if (!root) bus.parent = choose(rng, buses).name;
    if (chance(rng, 0.3)) bus.maxVoices = int(rng, 1, Math.min(64, logical));
    if (chance(rng, 0.3)) {
      const bed = choose(rng, BUS_BEDS);
      if (bed !== (root ? "own" : "parent")) bus.bed = bed;
    }
    if (chance(rng, 0.3)) {
      const priority = int(rng, 0, 255);
      if (priority !== (root ? ROOT_BED_PRIORITY : DEFAULT_BED_PRIORITY)) bus.bedPriority = priority;
    }
    if (!root && metered < METER_LIMIT && chance(rng, 0.4)) {
      bus.meter = "loudness";
      metered++;
    }
    buses.push(bus);
  });
  return buses;
}

function randomSnapshots(rng: Rng, buses: readonly BusSettings[]): SnapshotSettings[] {
  return shuffle(rng, SNAPSHOT_NAMES).slice(0, int(rng, 0, 3)).map((name) => {
    const volumes: Record<string, number> = {};
    const lowpass: Record<string, number> = {};
    for (const b of buses) {
      if (chance(rng, 0.3)) volumes[b.name] = notOne(r3(between(rng, 0, 2)));
      if (chance(rng, 0.2)) lowpass[b.name] = r3(between(rng, 10, 20000));
    }
    return { name, volumes, lowpass };
  });
}

function randomDucking(rng: Rng, buses: readonly BusSettings[]): DuckingRule[] {
  const rules: DuckingRule[] = [];
  const want = int(rng, 0, 4);
  for (let tries = 0; rules.length < want && tries < 30; tries++) {
    const target = choose(rng, buses).name;
    const trigger = choose(rng, buses).name;
    if (target === trigger || isAncestor(buses, trigger, target)) continue;
    if (rules.some((r) => r.target === target && r.trigger === trigger)) continue;
    const common = { target, trigger, amount: r3(between(rng, 0, 1)), attack: r3(between(rng, 0, 10)), release: r3(between(rng, 0, 10)) };
    const rule: DuckingRule = chance(rng, 0.5)
      ? { ...common, mode: "presence" }
      : { ...common, mode: "level", detector: choose(rng, ["peak", "rms"] as const), threshold: r3(between(rng, -80, 0)) };
    if (levelCycle(buses, [...rules, rule])) continue;
    rules.push(rule);
  }
  return rules;
}

function randomAutomation(rng: Rng, buses: readonly BusSettings[]): BusAutomation[] {
  const out: BusAutomation[] = [];
  const count = int(rng, 0, 2);
  for (let i = 0; i < count; i++) {
    const bus = choose(rng, buses).name;
    const parameter = choose(rng, PARAMS).name;
    const target = choose(rng, ["volume", "lowpass"] as const);
    if (out.some((a) => a.bus === bus && a.parameter === parameter && a.target === target)) continue;
    const y = (): number => (target === "volume" ? r3(between(rng, 0, 2)) : r3(between(rng, 10, 20000)));
    const curve: [number, number][] = [[0, y()], [1, y()]];
    if (chance(rng, 0.5)) curve.splice(1, 0, [0.5, y()]);
    out.push({ bus, parameter, target, curve });
  }
  return out;
}

/** Targets for a settings: `undefined` when the list is the default (absent is canonical). */
function randomTargets(rng: Rng): LoudnessTarget[] | undefined {
  const list: LoudnessTarget[] = shuffle(rng, TARGET_NAMES).slice(0, int(rng, 1, 4)).map((name) => ({
    name, integrated: r3(between(rng, -70, 0)), tolerance: r3(between(rng, 0, 12)), truePeak: r3(between(rng, -20, 0)),
  }));
  return same(list, DEFAULT_TARGETS) ? undefined : list;
}

/** A canonical random settings. Voices are fixed at the presets' logical count so a `maxVoices` is valid on both sides of a pair. */
function randomSettings(rng: Rng): AudioSettings {
  const s = defaultAudioSettings();
  s.voices = { mixed: 128, logical: 4096, hrtf: int(rng, 0, 32) };
  s.background = choose(rng, ["mute", "pause", "play"] as const);
  s.clipFormat = choose(rng, ["i16", "f32"] as const);
  s.codecs = { aac: chance(rng, 0.5) };
  s.spatial = choose(rng, ["hrtf", "equalPower"] as const);
  s.backend = choose(rng, ["babylon", "core"] as const);
  s.limiterLookaheadMs = r3(between(rng, 0, 5));
  s.bed = { maxBeds: int(rng, 0, 4) };
  s.ambisonic = { maxClips: int(rng, 0, 4) };
  s.occlusion = { ...s.occlusion, budgetMs: r3(between(rng, 0.02, 2)), smoothingMs: r3(between(rng, 10, 1000)) };
  s.zones = { maxActive: int(rng, 0, 2), standby: int(rng, 0, 1), maxIrSeconds: r3(between(rng, 0.5, 8)) };
  s.doppler = { maxSpeed: r3(between(rng, 1, 500)) };
  s.speedOfSound = r3(between(rng, 10, 100000));
  s.music = { rings: int(rng, 0, 16) };
  s.rhythmMode = chance(rng, 0.2);
  s.parameters = structuredClone(PARAMS);
  s.buses = randomBuses(rng, s.voices.logical);
  s.snapshots = randomSnapshots(rng, s.buses);
  s.ducking = randomDucking(rng, s.buses);
  s.automation = randomAutomation(rng, s.buses);
  if (chance(rng, 0.6)) {
    const targets = randomTargets(rng);
    if (targets !== undefined) s.loudnessTargets = targets;
  }
  if (chance(rng, 0.3)) s.loudnessResetOnPlay = false;
  return s;
}

/** One small canonical edit of `a` (a live value, or a non-live one, so both kinds of key are exercised). */
function mutate(rng: Rng, a: AudioSettings): AudioSettings {
  const b = structuredClone(a);
  const bus = choose(rng, b.buses);
  switch (int(rng, 0, 6)) {
    case 0: bus.volume = r3(between(rng, 0, 2)); break;
    case 1: bus.mute = !bus.mute; break;
    case 2: if (b.snapshots.length > 0) choose(rng, b.snapshots).volumes[bus.name] = 0.7; break;
    case 3: if (b.ducking.length > 0) choose(rng, b.ducking).amount = r3(between(rng, 0, 1)); break;
    case 4: b.loudnessTargets = [{ name: "stream", integrated: r3(between(rng, -30, -10)), tolerance: 2, truePeak: -1 }]; break;
    case 5:
      if (b.loudnessResetOnPlay === false) delete b.loudnessResetOnPlay;
      else b.loudnessResetOnPlay = false;
      break;
    default:
      b.voices = { ...b.voices, hrtf: int(rng, 0, 32) };
      b.speedOfSound = r3(between(rng, 10, 1000));
      break;
  }
  return b;
}

// --- the checks -----------------------------------------------------------------------------------------------------------

/** Round trip: `invert(op, s)` applied to `applyOpToSettings(s, op)` gives `s` back, and the op changes `s` and leaves it canonical. */
function expectRoundTrip(s: AudioSettings, op: MixOp, label: string): void {
  const before = structuredClone(s);
  const s1 = applyOpToSettings(s, op);
  expect(s1, `${label}: the op changes the settings`).not.toEqual(s);
  expect(canonicalProblems(s1), `${label}: canonical after the op`).toEqual([]);
  const inverse = invert(op, s);
  const back = inverse.reduce((acc: AudioSettings, o) => applyOpToSettings(acc, o), s1);
  expect(back, `${label}: the inverse ${JSON.stringify(inverse)} gives the settings back`).toEqual(s);
  expect(canonicalProblems(back), `${label}: canonical after the inverse`).toEqual([]);
  expect(s, `${label}: the input is not mutated`).toEqual(before);
}

/** A refused or no-op op: the same settings object back, and no inverse. */
function expectNoOp(s: AudioSettings, op: MixOp, label: string): void {
  expect(applyOpToSettings(s, op), `${label}: the same object`).toBe(s);
  expect(invert(op, s), `${label}: no inverse`).toEqual([]);
}

/**
 * The diff lands on `b`: each op is accepted where it applies (opRefusal null), the result equals `b` on the live keys,
 * the non-live keys that differ are listed in `restartRequired` (and give no ops), and the non-live keys are `b`'s.
 */
function landsOn(a: AudioSettings, b: AudioSettings, label: string): { ops: MixOp[]; restartRequired: string[] } {
  const result = diffOps(a, b);
  let cur = a;
  result.ops.forEach((op, i) => {
    expect(opRefusal(cur, op), `${label}: op ${i} ${JSON.stringify(op)} is accepted where it applies`).toBeNull();
    cur = applyOpToSettings(cur, op);
  });
  const landed: Record<string, unknown> = { ...cur };
  for (const key of NON_LIVE_KEYS) landed[key] = b[key];
  expect(landed, `${label}: the diff of a lands on b`).toEqual(b);
  const restartExpected = NON_LIVE_KEYS.filter((key) => !same(a[key], b[key])).sort();
  expect([...result.restartRequired].sort(), `${label}: restartRequired`).toEqual(restartExpected);
  return result;
}

/** One seeded pair: `a` random; `b` a random settings, or a small edit of `a`. */
function checkPair(seed: number, kind: "independent" | "mutated"): void {
  const rng = mulberry32(seed);
  const a = randomSettings(rng);
  const b = kind === "mutated" ? mutate(rng, a) : randomSettings(rng);
  const label = `seed ${seed} (${kind})`;
  expect(canonicalProblems(a), `${label}: a is canonical`).toEqual([]);
  expect(canonicalProblems(b), `${label}: b is canonical`).toEqual([]);
  landsOn(a, b, label);
}

// --- the cases ------------------------------------------------------------------------------------------------------------

describe("invert: applying op then its inverse gives the settings back (L-Mo1a)", () => {
  it("setBus volume, mute, maxVoices (set and null), bed (set and null), bedPriority (set and null), meter (on and off)", () => {
    const s = fixture();
    expectRoundTrip(s, { op: "setBus", bus: "SFX", key: "volume", value: 0.5 }, "volume");
    expectRoundTrip(s, { op: "setBus", bus: "SFX", key: "mute", value: true }, "mute on");
    expectRoundTrip(s, { op: "setBus", bus: "UI", key: "mute", value: false }, "mute off");
    expectRoundTrip(s, { op: "setBus", bus: "SFX", key: "maxVoices", value: 4 }, "maxVoices set");
    expectRoundTrip(s, { op: "setBus", bus: "Music", key: "maxVoices", value: null }, "maxVoices null");
    expectRoundTrip(s, { op: "setBus", bus: "SFX", key: "bed", value: "none" }, "bed set");
    expectRoundTrip(s, { op: "setBus", bus: "Lead", key: "bed", value: null }, "bed null");
    expectRoundTrip(s, { op: "setBus", bus: "SFX", key: "bedPriority", value: 200 }, "bedPriority set");
    expectRoundTrip(s, { op: "setBus", bus: "Lead", key: "bedPriority", value: null }, "bedPriority null");
    expectRoundTrip(s, { op: "setBus", bus: "SFX", key: "meter", value: "loudness" }, "meter on");
    expectRoundTrip(s, { op: "setBus", bus: "Music", key: "meter", value: null }, "meter off");
  });

  it("addBus at the end, at an index, under an unknown parent (falls back to the root)", () => {
    const s = fixture();
    expectRoundTrip(s, { op: "addBus", name: "Ambience", parent: "Master" }, "at the end");
    expect(applyOpToSettings(s, { op: "addBus", name: "Ambience", parent: "Music", index: 1 }).buses[1].name, "at an index").toBe("Ambience");
    expectRoundTrip(s, { op: "addBus", name: "Ambience", parent: "Music", index: 1 }, "at an index");
    expect(applyOpToSettings(s, { op: "addBus", name: "Ambience", parent: "Nowhere" }).buses.at(-1)?.parent, "unknown parent").toBe("Master");
    expectRoundTrip(s, { op: "addBus", name: "Ambience", parent: "Nowhere" }, "under an unknown parent");
  });

  it("removeBus of a leaf, and of a bus with descendants, effects, snapshot entries, ducking rules, automation and a meter", () => {
    const s = fixture();
    expectRoundTrip(s, { op: "removeBus", bus: "UI" }, "a leaf with a snapshot entry");
    expectRoundTrip(s, { op: "removeBus", bus: "SFX" }, "a leaf with a ducking target and an effect");
    expectRoundTrip(s, { op: "removeBus", bus: "Music" }, "a bus with a child, effects, snapshot entries, ducking, automation and a meter");
    expectRoundTrip(s, { op: "removeBus", bus: "Voice" }, "a ducking trigger");
  });

  it("renameBus (references in snapshots, ducking and automation follow)", () => {
    const s = fixture();
    const renamed = applyOpToSettings(s, { op: "renameBus", from: "Music", to: "Songs" });
    expect(renamed.snapshots[0].volumes, "snapshot volume").toHaveProperty("Songs");
    expect(renamed.ducking[0].target, "ducking target").toBe("Songs");
    expect(renamed.automation[0].bus, "automation bus").toBe("Songs");
    expect(renamed.buses[2].parent, "child parent").toBe("Songs");
    expectRoundTrip(s, { op: "renameBus", from: "Music", to: "Songs" }, "rename");
  });

  it("moveBus", () => {
    const s = fixture();
    expectRoundTrip(s, { op: "moveBus", bus: "Voice", parent: "Music" }, "under a sibling");
    expectRoundTrip(s, { op: "moveBus", bus: "Lead", parent: "Master" }, "up to the root");
  });

  it("addEffect at the end and before the end", () => {
    const s = fixture();
    expectRoundTrip(s, { op: "addEffect", bus: "SFX", index: 1, effect: { type: "reverb", send: 0.3 } }, "at the end");
    expectRoundTrip(s, { op: "addEffect", bus: "Music", index: 0, effect: { type: "lowpass", frequency: 4000, q: 0.7 } }, "before the end");
  });

  it("removeEffect", () => {
    const s = fixture();
    expectRoundTrip(s, { op: "removeEffect", bus: "Music", index: 0 }, "a filter");
    expectRoundTrip(s, { op: "removeEffect", bus: "Lead", index: 0 }, "a compressor");
  });

  it("moveEffect forwards and backwards", () => {
    const s = fixture();
    expectRoundTrip(s, { op: "moveEffect", bus: "Music", from: 0, to: 2 }, "forwards");
    expectRoundTrip(s, { op: "moveEffect", bus: "Music", from: 2, to: 0 }, "backwards");
  });

  it("setEffect on a filter, a compressor and a reverb send", () => {
    const s = fixture();
    expectRoundTrip(s, { op: "setEffect", bus: "Music", index: 0, key: "frequency", value: 800 }, "filter frequency");
    expectRoundTrip(s, { op: "setEffect", bus: "Music", index: 2, key: "q", value: 2 }, "filter q");
    expectRoundTrip(s, { op: "setEffect", bus: "Lead", index: 0, key: "ratio", value: 4 }, "compressor");
    expectRoundTrip(s, { op: "setEffect", bus: "Music", index: 1, key: "send", value: 0.5 }, "reverb send");
  });

  it("addSnapshot with and without a name", () => {
    const s = fixture();
    expectRoundTrip(s, { op: "addSnapshot", index: 2, name: "Quiet" }, "with a name");
    expectRoundTrip(s, { op: "addSnapshot", index: 0 }, "without a name");
  });

  it("removeSnapshot with volume and low-pass entries", () => {
    const s = fixture();
    expectRoundTrip(s, { op: "removeSnapshot", index: 0 }, "volumes and a low-pass");
    expectRoundTrip(s, { op: "removeSnapshot", index: 1 }, "volumes only");
  });

  it("renameSnapshot", () => {
    expectRoundTrip(fixture(), { op: "renameSnapshot", index: 1, name: "Pause Menu" }, "rename");
  });

  it("setSnapshot volume and lowpass, set and null", () => {
    const s = fixture();
    expectRoundTrip(s, { op: "setSnapshot", index: 0, bus: "Voice", key: "volume", value: 0.6 }, "volume set");
    expectRoundTrip(s, { op: "setSnapshot", index: 0, bus: "SFX", key: "volume", value: null }, "volume null");
    expectRoundTrip(s, { op: "setSnapshot", index: 1, bus: "Music", key: "lowpass", value: 1200 }, "lowpass set");
    expectRoundTrip(s, { op: "setSnapshot", index: 0, bus: "Music", key: "lowpass", value: null }, "lowpass null");
  });

  it("setDucking insert, replace and remove (level and presence rules)", () => {
    const s = fixture();
    expectRoundTrip(s, { op: "setDucking", index: 2, rule: { target: "UI", trigger: "Voice", mode: "presence", amount: 0.3, attack: 0.1, release: 0.5 }, insert: true }, "insert presence");
    expectRoundTrip(s, { op: "setDucking", index: 0, rule: { target: "Music", trigger: "UI", mode: "level", detector: "peak", threshold: -20, amount: 0.5, attack: 0.05, release: 0.3 }, insert: true }, "insert level");
    expectRoundTrip(s, { op: "setDucking", index: 0, rule: { target: "Music", trigger: "Voice", mode: "presence", amount: 0.2, attack: 0.2, release: 1 } }, "replace");
    expectRoundTrip(s, { op: "setDucking", index: 1, rule: null }, "remove a level rule");
    expectRoundTrip(s, { op: "setDucking", index: 0, rule: null }, "remove a presence rule");
  });

  it("setAutomation insert, replace and remove", () => {
    const s = fixture();
    expectRoundTrip(s, { op: "setAutomation", index: 1, rule: { bus: "SFX", parameter: "Area", target: "lowpass", curve: [[0, 8000], [1, 800]] }, insert: true }, "insert");
    expectRoundTrip(s, { op: "setAutomation", index: 0, rule: { bus: "Music", parameter: "Intensity", target: "volume", curve: [[0, 0.2], [0.5, 0.8], [1, 1.5]] } }, "replace");
    expectRoundTrip(s, { op: "setAutomation", index: 0, rule: null }, "remove");
  });

  it("setTarget insert, replace and remove, from the default list and from an authored one", () => {
    const fromDefault = defaultAudioSettings();
    expectRoundTrip(fromDefault, { op: "setTarget", index: 2, target: { name: "podcast", integrated: -16, tolerance: 2, truePeak: -1 }, insert: true }, "default list: insert");
    expectRoundTrip(fromDefault, { op: "setTarget", index: 0, target: { name: "console", integrated: -23, tolerance: 2, truePeak: -1 } }, "default list: replace");
    expectRoundTrip(fromDefault, { op: "setTarget", index: 1, target: null }, "default list: remove");
    const authored = fixture();
    expectRoundTrip(authored, { op: "setTarget", index: 3, target: { name: "cinema", integrated: -14, tolerance: 2, truePeak: -1 }, insert: true }, "authored list: insert");
    expectRoundTrip(authored, { op: "setTarget", index: 0, target: { name: "console", integrated: -23, tolerance: 2, truePeak: -1 } }, "authored list: replace");
    expectRoundTrip(authored, { op: "setTarget", index: 2, target: null }, "authored list: remove back to the defaults");
  });

  it("setOption loudnessResetOnPlay both ways", () => {
    expectRoundTrip(fixture(), { op: "setOption", key: "loudnessResetOnPlay", value: true }, "false to true");
    expectRoundTrip(defaultAudioSettings(), { op: "setOption", key: "loudnessResetOnPlay", value: false }, "absent to false");
  });

  it("a refused or no-op op inverts to no ops", () => {
    const s = fixture();
    expectNoOp(s, { op: "setBus", bus: "Master", key: "meter", value: "loudness" }, "a root meter");
    expect(opRefusal(s, { op: "setBus", bus: "Master", key: "meter", value: "loudness" }), "a root meter is refused").not.toBeNull();
    expectNoOp(s, { op: "addBus", name: "Music", parent: "Master" }, "a duplicate name");
    expect(opRefusal(s, { op: "addBus", name: "Music", parent: "Master" }), "a duplicate name is refused").not.toBeNull();
    expectNoOp(s, { op: "setBus", bus: "Music", key: "volume", value: 0.8 }, "a volume it already has");
    expectNoOp(s, { op: "setEffect", bus: "Music", index: 0, key: "frequency", value: 18000 }, "an effect value it already has");
    expectNoOp(s, { op: "setOption", key: "loudnessResetOnPlay", value: false }, "an option it already has");
    const full = nineMetered();
    const ninth: MixOp = { op: "setBus", bus: "B9", key: "meter", value: "loudness" };
    expectNoOp(full, ninth, "the ninth meter");
    expect(opRefusal(full, ninth), "the ninth meter").toBe("At most 8 buses can be metered");
  });
});

describe("diffOps(a, b) applied to a gives b (L-Mo1a)", () => {
  it("identical settings give no ops and no restartRequired", () => {
    for (const s of [defaultAudioSettings(), fixture()]) {
      const result = landsOn(s, structuredClone(s), "identical");
      expect(result.ops).toEqual([]);
      expect(result.restartRequired).toEqual([]);
    }
  });

  it("one case per op kind: the single edit's settings pair diffs back to b", () => {
    const s = fixture();
    const edits: [string, MixOp][] = [
      ["setBus volume", { op: "setBus", bus: "SFX", key: "volume", value: 0.5 }],
      ["setBus mute", { op: "setBus", bus: "SFX", key: "mute", value: true }],
      ["setBus maxVoices", { op: "setBus", bus: "Music", key: "maxVoices", value: null }],
      ["setBus bed", { op: "setBus", bus: "SFX", key: "bed", value: "none" }],
      ["setBus bedPriority", { op: "setBus", bus: "SFX", key: "bedPriority", value: 200 }],
      ["setBus meter", { op: "setBus", bus: "SFX", key: "meter", value: "loudness" }],
      ["addBus", { op: "addBus", name: "Ambience", parent: "Master" }],
      ["removeBus", { op: "removeBus", bus: "UI" }],
      ["renameBus", { op: "renameBus", from: "Music", to: "Songs" }],
      ["moveBus", { op: "moveBus", bus: "Lead", parent: "Master" }],
      ["addEffect", { op: "addEffect", bus: "Music", index: 0, effect: { type: "reverb", send: 0.1 } }],
      ["removeEffect", { op: "removeEffect", bus: "Music", index: 0 }],
      ["moveEffect", { op: "moveEffect", bus: "Music", from: 0, to: 2 }],
      ["setEffect", { op: "setEffect", bus: "Music", index: 0, key: "frequency", value: 800 }],
      ["addSnapshot", { op: "addSnapshot", index: 2, name: "Quiet" }],
      ["removeSnapshot", { op: "removeSnapshot", index: 0 }],
      ["renameSnapshot", { op: "renameSnapshot", index: 1, name: "Pause Menu" }],
      ["setSnapshot", { op: "setSnapshot", index: 0, bus: "Voice", key: "volume", value: 0.6 }],
      ["setDucking", { op: "setDucking", index: 0, rule: null }],
      ["setAutomation", { op: "setAutomation", index: 0, rule: null }],
      ["setTarget", { op: "setTarget", index: 0, target: { name: "console", integrated: -23, tolerance: 2, truePeak: -1 } }],
      ["setOption", { op: "setOption", key: "loudnessResetOnPlay", value: true }],
    ];
    for (const [label, op] of edits) {
      const b = applyOpToSettings(s, op);
      expect(b, `${label} changes the settings`).not.toBe(s);
      expect(canonicalProblems(b), `${label}: b is canonical`).toEqual([]);
      const result = landsOn(s, b, label);
      expect(result.ops.length, `${label}: gives ops`).toBeGreaterThan(0);
      expect(result.restartRequired, label).toEqual([]);
    }
  });

  it("a rename it can't see is remove plus add; a reordered bus list still lands on b", () => {
    const s = fixture();
    const result = landsOn(s, renameByHand(s, "Music", "Songs"), "rename by hand");
    expect(result.ops.some((o) => o.op === "removeBus" && o.bus === "Music"), "remove Music").toBe(true);
    expect(result.ops.some((o) => o.op === "addBus" && o.name === "Songs"), "add Songs").toBe(true);
    const reordered = structuredClone(s);
    reordered.buses = [reordered.buses[0], ...reordered.buses.slice(1).reverse()];
    landsOn(s, reordered, "reordered");
  });

  it("a changed root name lands on b", () => {
    const s = fixture();
    const result = landsOn(s, renameByHand(s, "Master", "Main"), "root name");
    expect(result.restartRequired).toEqual([]);
  });

  it("swapped snapshot and target names land on b", () => {
    const s = fixture();
    const b = structuredClone(s);
    const [snap0, snap1] = b.snapshots;
    b.snapshots = [{ ...snap0, name: snap1.name }, { ...snap1, name: snap0.name }];
    const [t0, t1, t2] = b.loudnessTargets ?? [];
    b.loudnessTargets = [{ ...t0, name: t1.name }, { ...t1, name: t0.name }, t2];
    expect(canonicalProblems(b)).toEqual([]);
    landsOn(s, b, "swapped names");
  });

  it("keys outside LIVE_KEYS are listed in restartRequired and give no ops", () => {
    const s = fixture();
    const b = structuredClone(s);
    b.voices = { ...b.voices, hrtf: 4 };
    b.backend = s.backend === "core" ? "babylon" : "core";
    b.limiterLookaheadMs = 3;
    b.zones = { ...b.zones, maxActive: 1 };
    b.occlusion = { ...b.occlusion, budgetMs: 0.5 };
    const result = landsOn(s, b, "restart keys");
    expect(result.ops).toEqual([]);
    expect([...result.restartRequired].sort()).toEqual(["backend", "limiterLookaheadMs", "occlusion", "voices", "zones"]);
    b.buses[3].volume = 0.5;
    const withLive = landsOn(s, b, "restart keys and a live edit");
    expect(withLive.ops).toHaveLength(1);
    expect(withLive.ops[0]).toMatchObject({ op: "setBus", bus: "SFX", key: "volume", value: 0.5 });
    expect([...withLive.restartRequired].sort()).toEqual(["backend", "limiterLookaheadMs", "occlusion", "voices", "zones"]);
  });

  it("the key lists cover every top-level key of the settings", () => {
    for (const key of Object.keys(defaultAudioSettings())) {
      expect([...LIVE_KEYS, ...NON_LIVE_KEYS], key).toContain(key);
    }
  });

  it("property: random canonical settings pairs (seeded, ≥ 500 pairs) diff and apply to b", () => {
    for (let seed = 1; seed <= 300; seed++) checkPair(seed, "independent");
    for (let seed = 301; seed <= 600; seed++) checkPair(seed, "mutated");
  });

  it("property: diffOps' ops are each accepted (opRefusal null) at the point they apply", () => {
    for (let seed = 1000; seed < 1300; seed++) {
      const rng = mulberry32(seed);
      const a = randomSettings(rng);
      const b = seed % 2 === 0 ? mutate(rng, a) : randomSettings(rng);
      let cur = a;
      for (const [i, op] of diffOps(a, b).ops.entries()) {
        expect(opRefusal(cur, op), `seed ${seed}: op ${i} ${JSON.stringify(op)}`).toBeNull();
        cur = applyOpToSettings(cur, op);
      }
    }
  });
});
