// What the open playlist plays, in its own words (spec 4.2.8; the prototype's Plays now cards, the entry rows' Now bars
// and the Inspector's "this voice" cards): the samples an entry can reach, each entry's live level from the voices
// playing now, the path from the open playlist down to a voice's sample ("Bike impact › Metal impact › Metal crack"),
// and the preview of the next trigger at the test values (what a Switch label picks, a Blend's weights, a Queue's
// pick of N). Pure: the caller reads the playlists (`load`) and the runtime's voices.
import type { ParameterDef } from "../../../engine/audio/parameters";
import { isLabelled } from "../../../engine/audio/parameters";
import type { Entry, PlaylistBody, PlaylistType } from "../../../engine/audio/playlist/types";
import { liveWeights } from "./blendViewModel";
import { entryName, sampleTitle } from "./playlistPaths";

type Load = (path: string) => PlaylistBody | null;

/** How deep the walks follow nested and linked playlists. */
const DEPTH = 8;

/** The playlist an entry plays (embedded or linked), null for a sample, line or generator, or one that can't be read. */
export function innerOf(e: Entry, load: Load): PlaylistBody | null {
  return e.kind === "embedded" ? e.embedded : e.kind === "linked" ? load(e.playlist) : null;
}

/** Every sample path an entry can play, through nested and linked playlists. */
export function samplesOf(e: Entry, load: Load, depth = DEPTH): Set<string> {
  const out = new Set<string>();
  const walk = (x: Entry, d: number) => {
    if (x.kind === "sample") return void out.add(x.sample);
    if (d <= 0) return;
    const b = innerOf(x, load);
    if (b) for (const y of b.entries) walk(y, d - 1);
  };
  walk(e, depth);
  return out;
}

export interface LiveVoice {
  readonly clip: string;
  /** Linear gain, 0..1. */
  readonly gain: number;
}

/** Each entry's level now: the loudest voice playing one of its samples (0 when none). */
export function entryLevels(body: PlaylistBody, voices: readonly LiveVoice[], load: Load): number[] {
  if (voices.length === 0) return body.entries.map(() => 0);
  return body.entries.map((e) => {
    const reach = samplesOf(e, load);
    let level = 0;
    for (const v of voices) if (reach.has(v.clip)) level = Math.max(level, v.gain);
    return Math.min(1, level);
  });
}

/** The names from the open playlist (`root`, named `rootName`) down to the first entry that plays `clip`. */
export function pathTo(rootName: string, body: PlaylistBody, clip: string, load: Load): string[] {
  const walk = (b: PlaylistBody, d: number): string[] | null => {
    for (let i = 0; i < b.entries.length; i++) {
      const e = b.entries[i]!;
      if (e.kind === "sample") {
        if (e.sample === clip) return b.type === "clip" ? [] : [entryName(e, i)];
        continue;
      }
      if (d <= 0) continue;
      const inner = innerOf(e, load);
      if (!inner) continue;
      const below = walk(inner, d - 1);
      if (below) return [entryName(e, i), ...below];
    }
    return null;
  };
  const found = walk(body, DEPTH);
  return [rootName, ...(found ?? [sampleTitle(clip)])];
}

/** One card of the next-trigger preview. */
export interface PreviewCard {
  /** Its title: an entry's name, or a pick ("Random pick · 1 of 5"). */
  readonly name: string;
  /** Its badge: a playlist type, or a sample. */
  readonly kind: PlaylistType | "sample";
  readonly axes?: 1 | 2;
  /** Its share of the trigger, 0..1 (a Blend's weight; 1 otherwise). */
  readonly weight: number;
  /** Its gain from this level's settings, dB. */
  readonly gainDb: number;
  /** From the open playlist down to it. */
  readonly path: readonly string[];
}

const kindOf = (e: Entry, load: Load): { kind: PlaylistType | "sample"; axes?: 1 | 2 } => {
  const b = innerOf(e, load);
  return b ? { kind: b.type, axes: b.blend?.axes.length === 2 ? 2 : 1 } : { kind: "sample" };
};

/** The label a Switch picks at the test values (its index's label, or the parameter's default). */
export function switchLabel(body: PlaylistBody, defs: readonly ParameterDef[], values: Readonly<Record<string, number>>): string | null {
  const s = body.switch;
  if (!s) return null;
  const def = defs.find((p) => p.name === s.parameter);
  if (!def || !isLabelled(def)) return null;
  const v = values[s.parameter];
  return v !== undefined ? (def.labels[Math.round(v)] ?? def.default) : def.default;
}

const PICK_WORD = { random: "Random pick", shuffle: "Shuffle", roundRobin: "Round robin" } as const;

/**
 * What the next trigger plays at the test values, one level down (two through a Switch's pick, so a label that plays a
 * Queue shows the Queue's pick): a Clip its sample, a Queue "Random pick · 1 of N", a Switch the label's entry, a
 * Blend each entry with weight, a Layer every entry. Empty when nothing would play.
 */
export function previewCards(rootName: string, body: PlaylistBody, defs: readonly ParameterDef[], values: Readonly<Record<string, number>>, load: Load, depth = 2): PreviewCard[] {
  const at = (e: Entry, i: number, weight: number, path: readonly string[], gain = 0): PreviewCard => ({ name: entryName(e, i), ...kindOf(e, load), weight, gainDb: e.volume + gain, path: [...path, entryName(e, i)] });
  const path = [rootName];
  switch (body.type) {
    case "clip": {
      const s = body.entries[0];
      return s ? [{ ...at(s, 0, 1, []), gainDb: body.volume + s.volume, path }] : [];
    }
    case "queue": {
      const live = body.entries.filter((e) => body.queue?.pick !== "random" || e.weight > 0);
      if (live.length === 0) return [];
      if (live.length === 1) return [at(live[0]!, body.entries.indexOf(live[0]!), 1, path)];
      return [{ name: `${PICK_WORD[body.queue?.pick ?? "random"]} · 1 of ${live.length}`, kind: "queue", weight: 1, gainDb: 0, path }];
    }
    case "switch": {
      const label = switchLabel(body, defs, values);
      const i = label !== null ? body.switch!.map[label] : null;
      const e = i !== null && i !== undefined ? body.entries[i] : undefined;
      if (!e) return [];
      const inner = innerOf(e, load);
      const gain = body.switch!.labelGain[label!] ?? 0;
      if (inner && depth > 1 && inner.type !== "clip") {
        const below = previewCards(entryName(e, i!), inner, defs, values, load, depth - 1);
        return below.map((c) => ({ ...c, gainDb: c.gainDb + e.volume + gain, path: [rootName, ...c.path] }));
      }
      return [at(e, i!, 1, path, gain)];
    }
    case "blend": {
      const w = liveWeights(body, defs, values, 0);
      return body.entries.map((e, i) => ({ e, i, w: w[i] ?? 0 })).filter((x) => x.w > 1e-3).sort((a, b) => b.w - a.w).map((x) => at(x.e, x.i, x.w, path, x.w > 0 ? 20 * Math.log10(x.w) : -120));
    }
    case "layer":
      return body.entries.map((e, i) => at(e, i, 1, path));
    case "sequence":
      return body.entries.length || body.sequence ? [{ name: rootName, kind: "sequence", weight: 1, gainDb: body.volume, path: [] }] : [];
  }
}

/** The type summary after a playlist's name ("Switch · Surface", "1D blend · Rain", "Queue · 3 entries", "Clip · glass_shatter"). */
export function typeSummary(body: PlaylistBody): string {
  const n = body.entries.length;
  switch (body.type) {
    case "clip": {
      const s = body.entries[0];
      return `Clip · ${s && s.kind === "sample" ? sampleTitle(s.sample) : "no sample"}`;
    }
    case "switch":
      return `Switch · ${body.switch?.parameter || "no parameter"}`;
    case "blend":
      return `${body.blend?.axes.length === 2 ? "2D" : "1D"} blend · ${(body.blend?.axes ?? []).map((a) => ("voiceTime" in a ? "Voice time" : a.parameter)).join(" × ")}`;
    default:
      return `${body.type.charAt(0).toUpperCase()}${body.type.slice(1)} · ${n === 1 ? "1 entry" : `${n} entries`}`;
  }
}

/** One "this voice" card (the prototype's `.axr`): what resolves the voice at this level. */
export interface VoiceCard {
  /** D: a discrete pick (Switch, Queue); S: a scalar blend input; T: voice time. */
  readonly badge: "D" | "S" | "T";
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
  /** A Blend's weight per entry, 0..1. */
  readonly rows?: readonly { readonly name: string; readonly weight: number }[];
}

/**
 * The open playlist's "this voice" cards at the test values: a Switch's label and what it plays, a Queue's pick, each
 * scalar Blend input with every entry's weight, and voice time (`time`, seconds since the trigger; null before one).
 */
export function voiceCards(name: string, body: PlaylistBody, defs: readonly ParameterDef[], values: Readonly<Record<string, number>>, time: number | null): VoiceCard[] {
  const out: VoiceCard[] = [];
  if (body.type === "switch" && body.switch) {
    const label = switchLabel(body, defs, values);
    const i = label !== null ? body.switch.map[label] : null;
    const e = i !== null && i !== undefined ? body.entries[i] : undefined;
    out.push({ badge: "D", label: body.switch.parameter || "No parameter", value: label ?? "—", sub: e ? `plays ${entryName(e, i!)}` : label ? "plays nothing" : "pick a labelled parameter" });
  } else if (body.type === "queue" && body.queue) {
    const q = body.queue;
    const n = body.entries.filter((e) => q.pick !== "random" || e.weight > 0).length;
    out.push({ badge: "D", label: name, value: `${PICK_WORD[q.pick]} · ${n === 1 ? "1 entry" : `${n} entries`}`, sub: q.pick === "random" && q.avoidRepeat ? `avoids the last ${q.avoidRepeat}` : q.continuous ? "continuous" : undefined });
  } else if (body.type === "blend" && body.blend) {
    const w = liveWeights(body, defs, values, time ?? 0);
    const scalars = body.blend.axes.filter((a): a is { parameter: string } => "parameter" in a);
    if (scalars.length) {
      const fmt = (p: string) => {
        const def = defs.find((d) => d.name === p);
        const numeric = def && !isLabelled(def) ? def : null;
        const v = values[p] ?? numeric?.default ?? 0;
        return numeric && numeric.min === 0 && numeric.max === 1 ? `${Math.round(v * 100)}%` : String(Math.round(v * 100) / 100);
      };
      out.push({ badge: "S", label: scalars.map((a) => a.parameter).join(" · "), value: scalars.map((a) => fmt(a.parameter)).join(" · "), rows: body.entries.map((e, i) => ({ name: entryName(e, i), weight: w[i] ?? 0 })) });
    }
  }
  if (body.type !== "sequence" && body.type !== "clip") {
    out.push(time === null ? { badge: "T", label: "Voice time", value: "—", sub: "Trigger to run it" } : { badge: "T", label: "Voice time", value: `${time.toFixed(2)} s`, sub: "since the trigger" });
  }
  return out;
}

/** The game parameters a playlist uses (its Switch, Blend axes, curves and automation, and those of what it plays). */
export function usedParameters(body: PlaylistBody, load: Load): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = (b: PlaylistBody, d: number) => {
    if (b.switch?.parameter) out.add(b.switch.parameter);
    for (const a of b.blend?.axes ?? []) if ("parameter" in a) out.add(a.parameter);
    for (const a of b.automation) if (typeof a.input !== "string") out.add(a.input.parameter);
    for (const p of b.parameters) out.add(p.name);
    for (const e of b.entries) {
      for (const c of Object.values(e.curves)) if (c && typeof c.input !== "string") out.add(c.input.parameter);
      if (d <= 0) continue;
      if (e.kind === "embedded") walk(e.embedded, d - 1);
      else if (e.kind === "linked" && !seen.has(e.playlist)) {
        seen.add(e.playlist);
        const inner = load(e.playlist);
        if (inner) walk(inner, d - 1);
      }
    }
  };
  walk(body, DEPTH);
  return out;
}
