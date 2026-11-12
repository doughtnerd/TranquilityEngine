// The Audio Debug panel's M3 rows (ADR 0162 E4, api-and-models §1.6 and §7, architecture §9): `AudioDebugInfo` turned
// into plain sections (a title, a tooltip, columns and rows of text cells with a health colour) that the panel only
// has to draw. Pure: no Preact, no Audio, so the rows are tested against a real loopback run.
//
// Health follows the S8 thresholds (architecture §9):
//
//   oldestOcclusionAgeFrames (0.25 ms budget)   green <= 8      amber 9-30        red > 30
//   occlusionOverruns                           green 0         amber <= 1 / s    red > 1 / s
//   bedsRefused, zonesFaded, kernelRefused      green 0         amber non-zero    -
//   irFailures, bedFilterLoadFailure            green 0         -                 red non-zero
//   wideStarved                                 green 0         -                 red on any increment
//   bedSwitches per voice-second                green <= 2      amber > 2         -
//   m3Shed                                      green 0         -                 red on any step
//
// "Per second" and "any increment" need the previous samples, so a `CounterWatch` sees every sample the panel takes.
import type { AudioDebugInfo, MusicDebugRow, MusicDebugTotals } from "../runtime/backend";

/** green, amber, red; "info" is a number with no threshold (a gauge, not a fault). */
export type Health = "ok" | "warn" | "bad" | "info";

/** One cell: its text, an optional tooltip and a health colour. */
export interface Cell {
  text: string;
  tip?: string;
  health?: Health;
}

/** One row; `id` keys it. A summary section's rows have two cells (label, value). */
export interface Row {
  id: string;
  cells: Cell[];
  /** The row's own health (colours its first cell). */
  health?: Health;
}

/** A column header with a plain-language tooltip. */
export interface Column {
  label: string;
  tip: string;
}

/** A panel section. `columns` absent: a label/value list. */
export interface Section {
  id: "m3Counters" | "ladder" | "beds" | "zones" | "occlusion" | "memory" | "musicTotals" | "music";
  title: string;
  /** What the section is, for a tooltip on its header. */
  tip: string;
  columns?: readonly Column[];
  rows: Row[];
  /** Shown instead of the table when there are no rows. */
  empty: string;
}

/** How long a counter that rose stays red, seconds (the panel refreshes at 4 Hz, so a blink would be missed). */
export const STICKY_SECONDS = 5;
/** The window the per-second rates are measured over, seconds. */
const RATE_WINDOW = 1;

/** The S8 thresholds (architecture §9), exported so tests and docs name the numbers. */
export const HEALTH = { occlusionAgeAmber: 8, occlusionAgeRed: 30, overrunsPerSecondRed: 1, bedSwitchesPerVoiceSecond: 2 } as const;

type Counters = AudioDebugInfo["counters"];
type CounterKey = keyof Counters;

/**
 * Remembers recent samples of the counters whose health is a rate or an increment: `occlusionOverruns` (per second),
 * `bedSwitches` (per voice-second), and `wideStarved` and `m3Shed` (red for `STICKY_SECONDS` after a rise).
 * Feed it every `Audio.debug()` the panel takes.
 */
export class CounterWatch {
  private readonly history = new Map<string, { t: number; v: number }[]>();
  private readonly lastRise = new Map<string, number>();
  private now = 0;

  /** Records one sample (`info.time` is the audio clock, seconds). A clock that went backwards (a rebuild) clears the history. */
  observe(info: AudioDebugInfo): void {
    const t = info.time;
    if (t < this.now) {
      this.history.clear();
      this.lastRise.clear();
    }
    this.now = t;
    for (const k of ["occlusionOverruns", "bedSwitches", "wideStarved", "m3Shed"] as const) {
      const v = info.counters[k];
      if (typeof v !== "number") continue;
      let h = this.history.get(k);
      if (!h) this.history.set(k, (h = []));
      const prev = h[h.length - 1];
      if (prev && v > prev.v) this.lastRise.set(k, t);
      h.push({ t, v });
      while (h.length > 2 && t - h[1]!.t >= RATE_WINDOW) h.shift();
    }
  }

  /** The counter's rise per second over the last second or so, or 0 before two samples. */
  rate(key: CounterKey): number {
    const h = this.history.get(key);
    if (!h || h.length < 2) return 0;
    const a = h[0]!, b = h[h.length - 1]!;
    return b.t > a.t ? Math.max(0, b.v - a.v) / (b.t - a.t) : 0;
  }

  /** Whether the counter rose within `STICKY_SECONDS`. */
  rose(key: CounterKey): boolean {
    const at = this.lastRise.get(key);
    return at !== undefined && this.now - at <= STICKY_SECONDS;
  }
}

const num = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** 1234 -> "1,234"; fractions kept to `digits`. */
const fmt = (v: number, digits = 0): string => v.toLocaleString("en-US", { maximumFractionDigits: digits });

/** Bytes as KB or MB. */
export function formatBytes(bytes: number): string {
  if (!(bytes > 0)) return "0";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Hz as "800 Hz" or "5.0 kHz"; at or above 20 kHz the filter is open. */
export function formatHz(hz: number): string {
  if (hz >= 20000) return "open";
  return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`;
}

/** A gain as a fraction and decibels ("0.35 (-9 dB)"), or "1 (open)". */
export function formatGain(g: number): string {
  if (g >= 0.9995) return "1 (open)";
  if (!(g > 0)) return "0 (silent)";
  return `${g.toFixed(2)} (${(20 * Math.log10(g)).toFixed(0)} dB)`;
}

// --- The §9 health rules -----------------------------------------------------------------------------------------

/** Health of the occlusion result age, S8 (frames at 0.25 ms). */
export const occlusionAgeHealth = (frames: number): Health => (frames <= HEALTH.occlusionAgeAmber ? "ok" : frames <= HEALTH.occlusionAgeRed ? "warn" : "bad");

const nonZeroWarn = (v: number): Health => (v > 0 ? "warn" : "ok");
const nonZeroBad = (v: number): Health => (v > 0 ? "bad" : "ok");

// --- Sections ----------------------------------------------------------------------------------------------------

const kv = (id: string, label: string, text: string, tip: string, health?: Health): Row => ({ id, cells: [{ text: label, tip }, { text, tip, health }], health });

/** The M3 counters (§1.6, C24) with their health. Counters a backend doesn't have are left out. */
function counterRows(info: AudioDebugInfo, watch: CounterWatch | undefined): Row[] {
  const c = info.counters;
  const rows: Row[] = [];
  const add = (key: keyof Counters, label: string, tip: string, health?: (v: number) => Health, text?: (v: number) => string): void => {
    const raw = c[key];
    if (typeof raw !== "number") return;
    rows.push(kv(String(key), label, text ? text(raw) : fmt(raw), tip, health ? health(raw) : "info"));
  };
  add("bedVoices", "Bed voices", "Spatial voices heard through an ambisonic bed (the distant ones) instead of their own HRTF panner.");
  add("beds", "Beds in use", "Bed slots with at least one bus or clip on them.");
  add("bedDenied", "Beds denied", "Buses that asked for a bed and did not get one (no slot free). They fall back to a parent's bed or none.", nonZeroWarn);
  add("bedsRefused", "Beds refused", "Bed requests the core turned down. Amber when non-zero: raise Max beds in Project Settings > Audio.", nonZeroWarn);
  add("bedSwitches", "Panner switches", "How often a voice changed between HRTF and bed panning. A voice should switch at most about twice a second; more is audible as a flutter.", undefined);
  add("bedFilterLoadFailure", "Bed filter failed to load", "The MagLS decoder filters did not load, so beds use the flatter built-in decoder. Red when non-zero.", nonZeroBad);
  add("belowHorizonVoices", "Voices below the horizon", "Bed voices more than 45 degrees below the listener; beds only approximate those.");
  add("fxVoices", "Voices with effects", "Voices running a per-voice filter or send.");
  add("ambisonicVoices", "Ambisonic voices", "Playing ambisonic clips.");
  add("zonesActive", "Zones active", "Reverb zones holding a convolver slot right now.");
  add("zonesRinging", "Zones ringing out", "Zones the listener has left whose reverb tail is still sounding. Informational.");
  add("zonesFaded", "Zones faded", "Zones silenced because more were wanted than Max active zones allows. See the Zones table for which and why.", nonZeroWarn);
  add("zoneMemoryKB", "Zone memory", "Reverb kernels resident in memory.", undefined, (v) => `${fmt(v)} KB`);
  add("kernelRefused", "Kernels refused", "Reverb impulse responses the audio core refused to take (too big for the arena). Amber when non-zero.", nonZeroWarn);
  add("irFailures", "Impulse responses failed", "Reverb impulse responses that failed to load, decode or prepare. Red when non-zero; the Zones table names the zone.", nonZeroBad);
  add("irTruncated", "Impulse responses cut", "Impulse responses longer than Max IR seconds, cut short with a fade.");
  add("irPrepInCore", "Kernels prepared in core", "Kernels the audio core prepared itself because the decoder worker was missing; the zone is late by a fraction of a second.");
  add("occlusionRays", "Occlusion rays", "Rays cast by the occlusion pass in the last frame.");
  add("occlusionUsedMs", "Occlusion time", "Time the last occlusion pass took.", undefined, (v) => `${fmt(v, 3)} ms`);
  add("occlusionSources", "Sources tested", "Spatial voices the occlusion pass looked at.");
  add("oldestOcclusionAgeFrames", "Oldest occlusion result", "How many frames old the stalest occlusion result is. When there are more sources than the ray budget allows, results age. Amber above 8 frames, red above 30.", occlusionAgeHealth, (v) => `${fmt(v)} frames`);
  add("dopplerClamps", "Doppler clamps", "Frames where a Doppler factor hit its limit.");
  add("dopplerTeleports", "Doppler teleports", "Source jumps too big to be motion; Doppler ignored them.");
  add("dopplerGuardTrips", "Doppler guard trips", "Times the Doppler safety guard replaced an out-of-range factor.");

  // The rate-based ones: overruns per second and switches per voice-second need the samples.
  if (typeof c.occlusionOverruns === "number") {
    const rate = watch?.rate("occlusionOverruns") ?? 0;
    const health: Health = rate > HEALTH.overrunsPerSecondRed ? "bad" : rate > 0 ? "warn" : "ok";
    rows.push(kv("occlusionOverruns", "Occlusion overruns", `${fmt(c.occlusionOverruns)} (${fmt(rate, 1)}/s)`, "Passes that took more than twice the ray budget; the next pass casts fewer rays. Amber up to 1 per second, red above.", health));
  }
  if (typeof c.bedSwitches === "number") {
    const voices = Math.max(1, num(c.bedVoices));
    const perVoice = (watch?.rate("bedSwitches") ?? 0) / voices;
    const row = rows.find((r) => r.id === "bedSwitches")!;
    const health: Health = perVoice > HEALTH.bedSwitchesPerVoiceSecond ? "warn" : "ok";
    row.cells[1] = { ...row.cells[1]!, text: `${fmt(c.bedSwitches)} (${fmt(perVoice, 1)}/voice/s)`, health };
    row.health = health;
  }
  if (typeof c.wideStarved === "number") {
    const bad = watch?.rose("wideStarved") === true;
    rows.push(kv("wideStarved", "Wide streams starved", fmt(c.wideStarved), "A 16-channel ambisonic stream ran out of decoded data and dropped out. Red for a few seconds after any increase.", bad ? "bad" : "ok"));
  }
  return rows;
}

/** The load-shedding ladder and `m3Shed` (OD3, architecture §7.3). */
function ladderRows(info: AudioDebugInfo, watch: CounterWatch | undefined): Row[] {
  const steps = num(info.counters.m3Shed);
  const state = typeof info.core.ladderState === "string" ? info.core.ladderState : "unknown";
  const shed = steps > 0 || watch?.rose("m3Shed") === true;
  return [
    kv("ladderState", "Ladder", state, "The load-shedding ladder. idle: nothing shed. cap at floor: the mixer is already at its lowest voice cap, so the ladder is the next resort. shedding: reverb tails were cut, then one active zone fewer.", shed ? "bad" : state === "cap at floor" ? "warn" : "ok"),
    kv("m3Shed", "Shed steps", fmt(steps), "How many steps the ladder has taken (tails cut, then zones fewer) because the audio thread was running late. Red on any step.", shed ? "bad" : "ok"),
  ];
}

/** `beds[]`: one row per bed slot. */
function bedRows(info: AudioDebugInfo): Row[] {
  return (info.beds ?? []).map((b) => ({
    id: `bed${b.slot}`,
    cells: [
      { text: String(b.slot) },
      { text: b.bus, tip: "The bus that hosts this bed." },
      { text: b.sharing.join(", ") || "-", tip: "Buses that mix into this bed." },
      { text: b.denied.length ? b.denied.map((d) => `${d.bus}: ${d.reason}`).join("; ") : "-", tip: "Buses that asked for a bed and were turned away, and why.", health: b.denied.length ? "warn" : undefined },
      { text: fmt(b.voices) },
      { text: fmt(b.clips) },
      { text: `${fmt(b.costUs)} us` },
    ],
  }));
}

/** `zones[]`: one row per zone slot, with its `why`. */
function zoneRows(info: AudioDebugInfo): Row[] {
  return (info.zones ?? []).map((z, k) => {
    const failed = z.why.startsWith("IR failed");
    const faded = z.why.startsWith("faded");
    const health: Health = failed ? "bad" : faded ? "warn" : "ok";
    return {
      id: `zone${k}:${z.node}`,
      health,
      cells: [
        { text: z.node, health },
        { text: z.slot >= 0 ? String(z.slot) : "-", tip: "The convolver slot, or - when the zone has none." },
        { text: z.state },
        { text: z.ir, tip: "The impulse response asset, or the preset." },
        { text: `${fmt(z.irSeconds, 2)} s` },
        { text: `${fmt(z.kernelKB)} KB` },
        { text: `${fmt(z.prepareMs, 1)} ms (${z.by})`, tip: "How long the kernel took to prepare, and who did it: the decoder worker or the audio core." },
        { text: fmt(z.sendEnergy, 3), tip: "How much of the sources' sound goes into this zone; the loudest zones win the slots." },
        { text: String(z.rank) },
        { text: z.why || "-", tip: "Why the zone is silent, if it is.", health: z.why ? health : undefined },
      ],
    };
  });
}

/** `occlusion`: the pass's state. */
function occlusionRows(info: AudioDebugInfo): Row[] {
  const o = info.occlusion;
  if (!o) return [];
  const age = o.oldestAgeFrames;
  return [
    kv("enabled", "Occlusion", o.enabled ? "on" : `off${o.note ? `: ${o.note}` : ""}`, "Whether sources behind walls are muffled. Off in a 2D World or without the 3D physics service.", o.enabled ? "ok" : "warn"),
    kv("rays", "Rays", `${fmt(o.rays)} / ${fmt(o.budgetRays)} per frame`, "Rays cast in the last frame against the budget the pass allows itself."),
    kv("rayCostUs", "Ray cost", `${fmt(o.rayCostUs, 2)} us`, "Measured time per ray. The budget (Project Settings > Audio > Occlusion) divided by this is the ray count."),
    kv("oldestAge", "Oldest result", `${fmt(age)} frames`, "How stale the oldest occlusion result is. Amber above 8, red above 30.", occlusionAgeHealth(age)),
  ];
}

/** `memory`: the fixed M3 memory. */
function memoryRows(info: AudioDebugInfo): Row[] {
  const m = info.memory;
  if (!m) return [];
  const used = m.kernelBudget > 0 ? m.kernels / m.kernelBudget : 0;
  return [
    kv("beds", "Beds", formatBytes(m.beds), "Memory laid out for the bed slots."),
    kv("zones", "Zones", formatBytes(m.zones), "Memory laid out for the reverb zone slots."),
    kv("kernels", "Kernels", `${formatBytes(m.kernels)} of ${formatBytes(m.kernelBudget)}`, "Reverb kernels resident now, against the arena the preset reserves for them.", used > 1 ? "bad" : used > 0.9 ? "warn" : "info"),
    kv("wideRings", "Wide rings", formatBytes(m.wideRings), "Buffers for 16-channel ambisonic streams."),
  ];
}

/** All M3 sections, in the order the panel shows them. A section the backend has no data for is still returned (with `empty` set). */
export function debugSections(info: AudioDebugInfo, watch?: CounterWatch, musicWatch?: MusicWatch): Section[] {
  const music = info.music ?? [];
  return [
    {
      id: "m3Counters",
      title: "Spatial counters",
      tip: "Counters of the spatial audio features (beds, reverb zones, occlusion, Doppler), coloured green, amber or red by how worrying they are.",
      rows: counterRows(info, watch),
      empty: "No spatial counters on this backend",
    },
    {
      id: "ladder",
      title: "Load shedding",
      tip: "When the audio thread runs late with the mixer already at its lowest cap, reverb tails are cut and then zones are dropped, one step at a time.",
      rows: ladderRows(info, watch),
      empty: "",
    },
    {
      id: "beds",
      title: "Beds",
      tip: "A bed is a shared ambisonic mix that distant spatial voices are placed into, so a crowd costs one decode.",
      columns: [
        { label: "Slot", tip: "The bed's slot in the audio core." },
        { label: "Bus", tip: "The bus that hosts the bed." },
        { label: "Sharing", tip: "Buses that mix into this bed." },
        { label: "Denied", tip: "Buses that asked for a bed and did not get one, and why." },
        { label: "Voices", tip: "Voices playing through the bed." },
        { label: "Clips", tip: "Ambisonic clips decoded into the bed." },
        { label: "Cost", tip: "Audio-thread time the bed takes per block." },
      ],
      rows: bedRows(info),
      empty: info.beds ? "No beds in use" : "No beds on this backend",
    },
    {
      id: "zones",
      title: "Zones",
      tip: "Reverb zones: the room each one models, whether it has a convolver slot, and why a silent one is silent.",
      columns: [
        { label: "Zone", tip: "The node holding the AudioReverbZone." },
        { label: "Slot", tip: "The convolver slot, or - when none." },
        { label: "State", tip: "Where the zone is in fading in, playing and ringing out." },
        { label: "IR", tip: "The impulse response asset or preset." },
        { label: "Length", tip: "Impulse response length." },
        { label: "Kernel", tip: "Memory the prepared kernel takes." },
        { label: "Prepare", tip: "Time to prepare the kernel, and who prepared it." },
        { label: "Energy", tip: "Sound sent into the zone; the top zones get the slots." },
        { label: "Rank", tip: "Position among the zones by energy." },
        { label: "Why", tip: "The reason a zone is silent: faded, IR failed, wet 0, no sources inside." },
      ],
      rows: zoneRows(info),
      empty: info.zones ? "No zones" : "No zones on this backend",
    },
    {
      id: "occlusion",
      title: "Occlusion",
      tip: "Walls between a source and the listener muffle it. The pass casts a limited number of rays per frame, so results can age.",
      rows: occlusionRows(info),
      empty: "No occlusion on this backend",
    },
    {
      id: "memory",
      title: "Memory",
      tip: "Memory the spatial features laid out when the core started, chosen by the Voices preset.",
      rows: memoryRows(info),
      empty: "No memory figures on this backend",
    },
    {
      id: "musicTotals",
      title: "Music totals",
      tip: "Engine-wide interactive music counters: the stream pool, late starts, split quanta and refusals. Red and amber follow architecture 9.",
      rows: info.musicTotals ? musicTotalsRows(music, info.musicTotals, musicWatch) : [],
      empty: "No music on this backend",
    },
    {
      id: "music",
      title: "Music",
      tip: "Each playing music event: where it is, the pending change and the rule that chose it, priming, re-plans and refusals.",
      columns: MUSIC_COLUMNS,
      rows: musicInstanceRows(music, info.sampleRate, musicWatch),
      empty: "No music playing",
    },
  ];
}

// --- The voice columns -------------------------------------------------------------------------------------------

type DebugVoice = AudioDebugInfo["voices"][number];

/** Headers for the voice columns M3 adds, in order. */
export const VOICE_COLUMNS: readonly Column[] = [
  { label: "Panner", tip: "How the voice is placed: flat (not spatial), equalPower, hrtf (head-related, the nearest voices), bed (shared ambisonic mix, the distant ones) or ambisonic (a clip with its own decoder). Hover a cell for the bed slot and how long it has held that panner." },
  { label: "Doppler", tip: "The pitch factor the source's and listener's motion adds. 1 is none." },
  { label: "Occlusion", tip: "The gain walls leave the voice (1 is open) and the cutoff they add, with the wall material. Hover for the hit count, material and the collider hit." },
  { label: "Low-pass", tip: "The low-pass filter in effect, and in brackets who set it: occlusion, event, automation, bus, snapshot or parent." },
  { label: "Sends", tip: "Reverb zones the voice sends to with the level, and its aux bus send." },
];

/** The cells of one voice row for `VOICE_COLUMNS`. A voice from a backend without a field shows "-". */
export function voiceCells(v: DebugVoice): Cell[] {
  const dash: Cell = { text: "-" };
  const panner: Cell = v.panner
    ? { text: v.panner, tip: `${v.bed !== null && v.bed !== undefined ? `Bed slot ${v.bed}. ` : ""}${v.kindDwellMs !== undefined ? `Held this panner for ${fmt(v.kindDwellMs)} ms.` : ""}`.trim() || undefined }
    : dash;
  const doppler: Cell = v.doppler === undefined ? dash : { text: v.doppler.toFixed(3), health: v.doppler !== 1 ? "info" : undefined };
  const o = v.occlusion;
  const occlusion: Cell = o
    ? {
        text: o.gain >= 0.9995 && o.cutoffHz >= 20000 ? "open" : `${o.gain.toFixed(2)} · ${formatHz(o.cutoffHz)}`,
        tip: `Gain ${formatGain(o.gain)}; ${o.hits} ${o.hits === 1 ? "wall" : "walls"} hit; material ${o.material || "none"}; collider ${o.collider ?? "none"}; result ${o.ageFrames} frames old.`,
        health: occlusionAgeHealth(o.ageFrames) === "ok" ? undefined : occlusionAgeHealth(o.ageFrames),
      }
    : dash;
  const f = v.filter;
  const lowpass: Cell = f ? { text: `${formatHz(f.lowpassHz)}${f.lowpassBy ? ` (${f.lowpassBy})` : ""}`, tip: `High-pass ${f.highpassHz > 20 ? formatHz(f.highpassHz) : "off"}.` } : dash;
  const parts = [...(v.sends ?? []).map((s) => `${s.zone} ${s.level.toFixed(2)}`), ...(v.aux ? [`aux ${v.aux.bus} ${v.aux.level.toFixed(2)}`] : [])];
  const sends: Cell = v.sends === undefined && v.aux === undefined ? dash : { text: parts.join(", ") || "-" };
  return [panner, doppler, occlusion, lowpass, sends];
}

// --- ADR 0166 interactive music (M4, P10): the Music section's rows -----------------------------------------------
//
// Filled by leaf L-P10a. Spec: api-and-models §1.6 (the row and totals shape, `MusicDebugRow` and
// `MusicDebugTotals` in `runtime/backend.ts`) and architecture §9 (the thresholds in `MUSIC_HEALTH` below). Pure, like the
// builders above. P10's lead wires them into `debugSections` (a "music" and a "musicTotals" section) and the panel.

/** The architecture §9 music thresholds, exported so tests and docs name the numbers. */
export const MUSIC_HEALTH = {
  /** `replans.deadline` per 100 transitions: green below `deadlineAmber`, amber up to `deadlineRed`, red above. */
  deadlineAmber: 1,
  deadlineRed: 10,
  /** `groupTimeouts` and the recoveries total: amber up to this many per minute, red above. */
  perMinuteAmber: 1,
  /** Lead (`leadMs`): green up to `leadGreenMs`, amber up to one beat (`60000 / tempo` ms), red above the beat. */
  leadGreenMs: 150,
  leadAmberMs: 330,
} as const;

/** The window the per-minute rates and the deadline ratio are measured over, seconds. */
const MUSIC_WINDOW = 60;

/** Cumulative counts at one sample: transitions (any row's pass rose or its segment changed) and the summed counters. */
interface MusicSample {
  t: number;
  transitions: number;
  deadline: number;
  groupTimeouts: number;
  recoveries: number;
}

/** What the watch remembers of a row between samples: its pass and segment, and its counters as last seen. */
interface MusicSeen {
  pass: number;
  segment: string | null;
  deadline: number;
  groupTimeouts: number;
  recoveries: number;
}

/** A row's counter rise since it was last seen; a row new to the watch counts from zero. */
const riseSince = (prev: number | undefined, v: number): number => (prev === undefined ? num(v) : Math.max(0, num(v) - prev));

/** Sum of a count record's values (a missing or non-finite value counts 0). */
const recordTotal = (rec: Record<string, number>): number => Object.values(rec).reduce((a, v) => a + num(v), 0);

/** "deadline 2, primeLate 1" for the non-zero causes, or "0". */
const causesText = (rec: Record<string, number>): string => {
  const parts = Object.entries(rec)
    .filter(([, v]) => num(v) > 0)
    .map(([k, v]) => `${k} ${fmt(v)}`);
  return parts.length ? parts.join(", ") : "0";
};

/** Refusal causes that are amber when non-zero (§9); any other cause, `neverFits` among them, is permanent and red. */
const AMBER_REFUSALS: readonly string[] = ["poolFull", "leadOverBeat", "tailRefused"];
const refusalHealth = (cause: string, count: number): Health => (count <= 0 ? "ok" : AMBER_REFUSALS.includes(cause) ? "warn" : "bad");

/** The worst of several healths: bad, then warn, then info, then ok. */
const worstOf = (...hs: Health[]): Health => (hs.includes("bad") ? "bad" : hs.includes("warn") ? "warn" : hs.includes("info") ? "info" : "ok");

/** A refusal record's health: the worst of its causes. */
const refusalsHealth = (rec: Record<string, number>): Health => worstOf(...Object.entries(rec).map(([k, v]) => refusalHealth(k, num(v))));

/**
 * Per-minute counters (§9): green at 0, amber up to `perMinuteAmber` a minute, red above. `perMinute` is undefined when
 * there is no watch; a count with no rate reads amber.
 */
function perMinuteHealth(count: number, perMinute: number | undefined): Health {
  if (!(count > 0) && !(perMinute !== undefined && perMinute > 0)) return "ok";
  return perMinute !== undefined && perMinute > MUSIC_HEALTH.perMinuteAmber ? "bad" : "warn";
}

/** Deadline re-plans per 100 transitions (§9): green below 1, amber 1 to 10, red above 10. */
function deadlineHealth(per100: number): Health {
  return per100 < MUSIC_HEALTH.deadlineAmber ? "ok" : per100 <= MUSIC_HEALTH.deadlineRed ? "warn" : "bad";
}

/** One stem for the Stems cell: "drums ring 2", "pad decoded", with "(unprimed)" while it is not primed. */
const stemLabel = (s: MusicDebugRow["stems"][number]): string => `${s.name} ${s.ring === null ? "decoded" : `ring ${s.ring}`}${s.primed ? "" : " (unprimed)"}`;

/**
 * Remembers recent samples of the music counters whose health is a rate (`replans.deadline` per 100 transitions,
 * `groupTimeouts` and `recoveries` per minute). Feed it every `Audio.debug()` the panel takes.
 */
export class MusicWatch {
  private readonly samples: MusicSample[] = [];
  private seen = new Map<number, MusicSeen>();
  private transitions = 0;
  private deadline = 0;
  private groupTimeouts = 0;
  private recoveries = 0;
  private now = 0;

  /** Records one sample (`time` is the audio clock, seconds); a clock that went backwards clears the history. */
  observe(time: number, rows: readonly MusicDebugRow[], _totals: MusicDebugTotals | undefined): void {
    if (time < this.now) this.reset();
    this.now = time;
    const seen = new Map<number, MusicSeen>();
    for (const r of rows) {
      const prev = this.seen.get(r.id);
      if (prev && (r.pass > prev.pass || r.segment !== prev.segment)) this.transitions += 1;
      const deadline = num(r.replans.deadline);
      const groupTimeouts = num(r.groupTimeouts);
      const recoveries = recordTotal(r.recoveries);
      this.deadline += riseSince(prev?.deadline, deadline);
      this.groupTimeouts += riseSince(prev?.groupTimeouts, groupTimeouts);
      this.recoveries += riseSince(prev?.recoveries, recoveries);
      seen.set(r.id, { pass: r.pass, segment: r.segment, deadline, groupTimeouts, recoveries });
    }
    this.seen = seen;
    this.samples.push({ t: time, transitions: this.transitions, deadline: this.deadline, groupTimeouts: this.groupTimeouts, recoveries: this.recoveries });
    while (this.samples.length > 2 && time - this.samples[1]!.t >= MUSIC_WINDOW) this.samples.shift();
  }

  /** `groupTimeouts` rise per minute, summed over rows, over the last minute or so. */
  groupTimeoutsPerMinute(): number {
    return this.perMinute("groupTimeouts");
  }

  /** Recoveries (every cause, every row) rise per minute. */
  recoveriesPerMinute(): number {
    return this.perMinute("recoveries");
  }

  /**
   * `replans.deadline` per 100 transitions over the window; a transition is a rise of any row's `pass` or a change of its
   * `segment`. 0 before the first transition; Infinity when re-plans rise with no transition (red).
   */
  deadlineReplansPer100(): number {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (this.samples.length < 2 || !first || !last) return 0;
    const transitions = last.transitions - first.transitions;
    const replans = last.deadline - first.deadline;
    if (transitions <= 0) return replans > 0 ? Infinity : 0;
    return (Math.max(0, replans) * 100) / transitions;
  }

  /** A cumulative counter's rise per minute across the window, or 0 before two samples. */
  private perMinute(key: "groupTimeouts" | "recoveries"): number {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (this.samples.length < 2 || !first || !last) return 0;
    const span = last.t - first.t;
    return span > 0 ? (Math.max(0, last[key] - first[key]) * 60) / span : 0;
  }

  private reset(): void {
    this.samples.length = 0;
    this.seen = new Map();
    this.transitions = 0;
    this.deadline = 0;
    this.groupTimeouts = 0;
    this.recoveries = 0;
  }
}

/** Lead health (§9: <= 150 ms green, 150-330 amber, > one beat red): green to 150, red above `60000 / tempo`, amber between (the table leaves 330 to the beat open when a beat is longer; this reading is the lead's). */
export function leadHealth(leadMs: number, tempo: number): Health {
  if (leadMs <= MUSIC_HEALTH.leadGreenMs) return "ok";
  const beatMs = tempo > 0 ? 60000 / tempo : Infinity;
  return leadMs > beatMs ? "bad" : "warn";
}

/** One-line text of `pending` ("verse at 5:1, tier 2 rule intro>verse from parent, exit nextBar, enter cue:in") or "none". */
export function pendingText(p: MusicDebugRow["pending"]): string {
  if (!p) return "none";
  return `${p.to} at ${p.time}, tier ${p.tier} rule ${p.ruleKey} from ${p.parent}, exit ${p.exit}, enter ${p.enter}`;
}

/**
 * The "Music instances" section's rows: one per `MusicDebugRow`, cells per `MUSIC_COLUMNS` (event, state, segment and
 * pass, bar:beat:tick, tempo, pending, groups primed n/N, stems primed n/N, prime last / Ê / lead in ms with lead health,
 * re-plans, refusals, late / held / timeouts, last slip in frames and ms, recoveries, missed beats, stingers).
 */
export function musicInstanceRows(rows: readonly MusicDebugRow[], sampleRate: number, watch?: MusicWatch): Row[] {
  const deadline = watch?.deadlineReplansPer100();
  return rows.map((r): Row => {
    const groupsPrimed = r.groups.reduce((a, g) => a + num(g.primed), 0);
    const groupsOf = r.groups.reduce((a, g) => a + num(g.of), 0);
    const stemsPrimed = r.stems.filter((s) => s.primed).length;
    const slipMs = sampleRate > 0 ? (num(r.lastSlipFrames) / sampleRate) * 1000 : 0;
    const recovered = recordTotal(r.recoveries);
    const timeouts = num(r.groupTimeouts);
    const { stingers } = r;
    const cells: Cell[] = [
      { text: `${r.id}: ${r.asset}`, tip: "The event instance id and its asset path." },
      { text: r.state, tip: "priming, playing, transitioning, recovering or ending." },
      { text: `${r.segment ?? "none yet"}, pass ${fmt(r.pass)}`, tip: "The playing segment's node id, and its pass (its loop count, from 1)." },
      { text: `${fmt(r.bar)}:${fmt(r.beat)}:${fmt(r.tick)}`, tip: `bar:beat:tick (960 ticks per beat); heard at ${fmt(r.time, 3)} s.` },
      { text: `${fmt(r.tempo, 1)} BPM, ${fmt(r.beatsPerBar)} per bar`, tip: "Beats per minute (BPM) and beats per bar." },
      { text: pendingText(r.pending), tip: "The change waiting to land: when, and the rule that supplied it." },
      {
        text: r.groups.length ? `${fmt(groupsPrimed)} of ${fmt(groupsOf)} primed` : "none",
        tip: r.groups.map((g) => `Group ${g.id}: ${g.state}, ${g.primed} of ${g.of} primed`).join("\n") || "No live groups.",
      },
      {
        text: r.stems.length ? `${stemsPrimed} of ${r.stems.length} primed (${r.stems.map(stemLabel).join("; ")})` : "none",
        tip:
          r.stems
            .map((s) => `${s.name}: ${s.primed ? "primed" : "not primed"}, ${s.streamed ? "streamed" : "decoded"}, ${s.ring === null ? "no music ring" : `music ring ${s.ring}`}`)
            .join("\n") || "No stems.",
      },
      {
        text: `${fmt(r.primeLastMs, 1)} / ${fmt(r.primeEmaMs, 1)} / ${fmt(r.leadMs, 1)} ms`,
        tip: "Last group prime time, the estimator Ê, and the prime lead, in milliseconds. Lead: green to 150 ms, amber to one beat, red above a beat.",
        health: leadHealth(r.leadMs, r.tempo),
      },
      {
        text: causesText(r.replans),
        tip: "Re-plans by reason (counts). Deadline re-plans colour per 100 transitions across all music instances.",
        health: deadline === undefined ? undefined : deadlineHealth(deadline),
      },
      {
        text: causesText(r.refusals),
        tip: "Refusals by cause (counts). Pool full, lead over a beat and tail refused are amber; never fits and other causes are red.",
        health: refusalsHealth(r.refusals),
      },
      {
        text: `${fmt(r.lateGroups)} / ${fmt(r.groupsHeld)} / ${fmt(timeouts)}`,
        tip: "Groups that started late, groups held by a starving member, and groups the core gave up on (counts). Timeouts: amber up to 1 per minute, red above.",
        health: worstOf(
          r.lateGroups > 0 ? "bad" : "ok",
          r.groupsHeld > 0 ? "bad" : "ok",
          perMinuteHealth(timeouts, timeouts > 0 ? watch?.groupTimeoutsPerMinute() : undefined),
        ),
      },
      {
        text: `${fmt(r.lastSlipFrames)} frames (${fmt(slipMs, 2)} ms)`,
        tip: "The slip of the last late or held group: audio frames, and milliseconds at the sample rate.",
      },
      {
        text: causesText(r.recoveries),
        tip: "Recoveries by cause (counts): rebuild, hidden, reload, crash. Amber up to 1 per minute, red above.",
        health: perMinuteHealth(recovered, recovered > 0 ? watch?.recoveriesPerMinute() : undefined),
      },
      { text: `${fmt(r.missedBeats)} beats`, tip: "Beats coalesced into missed since the instance started (beats)." },
      {
        text: `${fmt(stingers.played)} played, ${fmt(stingers.late)} late, ${fmt(stingers.skipped)} skipped, ${fmt(stingers.dropped)} dropped`,
        tip: "Stinger outcomes (counts). Skipped is amber when non-zero.",
        health: nonZeroWarn(stingers.skipped),
      },
    ];
    return { id: `music${r.id}`, cells };
  });
}

/** Column headers (label and tooltip) for `musicInstanceRows`, one per cell. */
export const MUSIC_COLUMNS: readonly Column[] = [
  { label: "Event", tip: "The event instance id and its asset path." },
  { label: "State", tip: "priming (the first segment's streams are filling), playing, transitioning, recovering (after a rebuild, hide or reload), or ending." },
  { label: "Segment", tip: "The playing segment and its pass (its loop count, from 1)." },
  { label: "Position", tip: "Bar:beat:tick of the heard position (960 ticks per beat), with the heard time in seconds." },
  { label: "Tempo", tip: "Beats per minute (BPM) and beats per bar." },
  { label: "Pending", tip: "The change waiting to land: its target, bar:beat, and the rule that supplied it (tier, from>to, parent, exit, enter)." },
  { label: "Groups", tip: "Members primed out of the members of the live groups (counts)." },
  { label: "Stems", tip: "Stems primed out of the playing segment's stems. Each shows its music ring, or decoded when it has none." },
  { label: "Prime (ms)", tip: "Last group prime time, the estimator Ê, and the prime lead, in milliseconds. Green to 150 ms, red above one beat." },
  { label: "Re-plans", tip: "Re-plans by reason (counts). Deadline re-plans are judged per 100 transitions in the totals." },
  { label: "Refusals", tip: "Refusals by cause (counts). Pool full, lead over a beat and tail refused are amber; never fits and other causes are red." },
  { label: "Late / held / timeouts", tip: "Groups that started late, groups held by a starving member, and groups the core gave up on (counts)." },
  { label: "Last slip", tip: "The slip of the last late or held group, in audio frames and in milliseconds at the sample rate." },
  { label: "Recoveries", tip: "Recoveries by cause (counts): rebuild, hidden, reload, crash." },
  { label: "Missed beats", tip: "Beats coalesced into missed since the instance started (beats)." },
  { label: "Stingers", tip: "Stinger outcomes (counts): played, late, skipped, dropped." },
];

/**
 * The "Music totals" section's label/value rows with the §9 health: pool used of size and high-water (info; amber at
 * `poolUsed >= poolSize`), `musicRingRefused`, `splitQuanta`, `groupTableFull` (red when non-zero), `streamStartsLate`
 * (red), `curvePoolFull` (amber), `voiceSplits` and `maxSlipFrames` (info), plus rows summed from the instance rows:
 * late groups (red), holds (red), timeouts and recoveries (`watch`), `refusals.poolFull` / `leadOverBeat` / `tailRefused`
 * and `stingers.skipped` (amber), `refusals.neverFits` and other permanent refusals (red).
 */
export function musicTotalsRows(rows: readonly MusicDebugRow[], totals: MusicDebugTotals | undefined, watch?: MusicWatch): Row[] {
  const out: Row[] = [];
  const sum = (f: (r: MusicDebugRow) => number): number => rows.reduce((a, r) => a + num(f(r)), 0);
  if (totals) {
    const size = num(totals.poolSize);
    const used = num(totals.poolUsed);
    out.push(
      kv(
        "poolUsed",
        "Music rings in use",
        `${fmt(used)} of ${fmt(size)} (high-water ${fmt(num(totals.poolHighWater))})`,
        "Music rings in use now, the pool's size (music.rings) and the most ever in use at once (rings). Amber when every ring is in use.",
        size > 0 && used >= size ? "warn" : "info",
      ),
    );
    const refused = num(totals.musicRingRefused);
    out.push(kv("musicRingRefused", "Music rings refused", fmt(refused), "Streamed stems refused for lack of a music ring (counts). Red on any.", nonZeroBad(refused)));
    const late = num(totals.streamStartsLate);
    out.push(kv("streamStartsLate", "Stream starts late", fmt(late), "Streams that started after their group's start (counts). Red on any.", nonZeroBad(late)));
    const splits = num(totals.splitQuanta);
    out.push(kv("splitQuanta", "Quantum splits (music)", fmt(splits), "Whole-quantum splits caused by music, cumulative (counts). Red on any: a bug.", nonZeroBad(splits)));
    out.push(kv("voiceSplits", "Voice splits", fmt(num(totals.voiceSplits)), "Voice-local splits, cumulative (counts). Informational.", "info"));
    out.push(kv("maxSlipFrames", "Largest slip", `${fmt(num(totals.maxSlipFrames))} frames`, "The largest slip since init, in audio frames. Informational.", "info"));
    const curve = num(totals.curvePoolFull);
    out.push(kv("curvePoolFull", "Curve pool full", fmt(curve), "Fade curves that found the curve pool full (counts). Amber when non-zero.", nonZeroWarn(curve)));
    const table = num(totals.groupTableFull);
    out.push(kv("groupTableFull", "Group table full", fmt(table), "A PLAY whose group found no core table entry (counts). Red on any: a bug.", nonZeroBad(table)));
  }
  const timeouts = sum((r) => r.groupTimeouts);
  const timeoutRate = watch?.groupTimeoutsPerMinute();
  out.push(
    kv(
      "groupTimeouts",
      "Groups abandoned",
      `${fmt(timeouts)}${timeoutRate === undefined ? "" : ` (${fmt(timeoutRate, 1)}/min)`}`,
      "Groups the core gave up on, summed over the music instances (counts; the rate is over the last minute). Green at 0, amber up to 1 per minute, red above.",
      perMinuteHealth(timeouts, timeoutRate),
    ),
  );
  const recovered = sum((r) => recordTotal(r.recoveries));
  const recoveryRate = watch?.recoveriesPerMinute();
  out.push(
    kv(
      "recoveries",
      "Music recoveries",
      `${fmt(recovered)}${recoveryRate === undefined ? "" : ` (${fmt(recoveryRate, 1)}/min)`}`,
      "Recoveries of every cause, summed over the music instances (counts; the rate is over the last minute). Green at 0, amber up to 1 per minute, red above.",
      perMinuteHealth(recovered, recoveryRate),
    ),
  );
  const late = sum((r) => r.lateGroups);
  out.push(kv("lateGroups", "Late groups", fmt(late), "Groups that started late, summed over the music instances (counts). Red on any.", nonZeroBad(late)));
  const held = sum((r) => r.groupsHeld);
  out.push(kv("groupsHeld", "Groups held", fmt(held), "Groups held by a starving member, summed (counts). Red on any.", nonZeroBad(held)));
  if (watch) {
    const per100 = watch.deadlineReplansPer100();
    out.push(
      kv(
        "replansDeadline",
        "Deadline re-plans",
        `${fmt(per100, 1)} per 100 transitions`,
        "Deadline re-plans per 100 transitions over the last minute (a transition: a row's pass rises or its segment changes). Green below 1, amber 1 to 10, red above 10; re-plans with no transition read red.",
        deadlineHealth(per100),
      ),
    );
  }
  // Refusals by cause: the named causes always, then any other cause the instances report.
  const causes = new Map<string, number>();
  for (const k of ["poolFull", "leadOverBeat", "tailRefused", "neverFits"]) causes.set(k, 0);
  for (const r of rows) for (const [k, v] of Object.entries(r.refusals)) causes.set(k, (causes.get(k) ?? 0) + num(v));
  for (const [k, v] of causes) {
    const tip = AMBER_REFUSALS.includes(k)
      ? `Refusals with cause ${k}, summed over the music instances (counts). Amber when non-zero.`
      : `Refusals with cause ${k}, summed over the music instances (counts). Red on any: permanent, or a cause the panel does not know.`;
    out.push(kv(`refusal:${k}`, `Refusals: ${k}`, fmt(v), tip, refusalHealth(k, v)));
  }
  const skipped = sum((r) => r.stingers.skipped);
  out.push(kv("stingersSkipped", "Stingers skipped", fmt(skipped), "Stingers skipped, summed over the music instances (counts). Amber when non-zero.", nonZeroWarn(skipped)));
  return out;
}
