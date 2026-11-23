// What the Take screen reads from the playlists a take plays, in the current project (spec §4.5.3-§4.5.5; the
// prototype's lane subs, "Drives …" lines and Inspector knob cards): how a lane's playlist plays ("until stopped ·
// Layer", "one-shot · sustain · Switch"), a one-line summary for "In this take", what a game parameter drives ("Drives
// pitch, low-pass on engine"), and the property cards: each property's authored value beside its live value, the
// game's values at the playhead put through the playlist's own curves (instance automation, entries' voice curves),
// with the mapping ("← Speed · −3 to +7 st · ease-in"). Pure.
import { EFFECT_CATALOGUE, isBuiltinEffectType } from "../../../engine/audio/effects/catalogue";
import type { ParameterDef } from "../../../engine/audio/parameters";
import type { CurveInput, Entry, PlaylistBody, VoiceCurveTarget } from "../../../engine/audio/playlist/types";
import { evalCurve, type Curve } from "../../../engine/core/curve";

const TYPE_NAME: Readonly<Record<PlaylistBody["type"], string>> = { clip: "Clip", queue: "Queue", switch: "Switch", blend: "Blend", layer: "Layer", sequence: "Sequence" };

/** A playlist type's name ("Switch"). */
export const typeName = (body: Pick<PlaylistBody, "type">): string => TYPE_NAME[body.type] ?? body.type;

/** How a lane's playlist plays: "until stopped · Layer", "one-shot · sustain · Switch"; "" without a playlist. */
export function playsText(body: PlaylistBody | null, held: boolean): string {
  if (!body) return held ? "sustain" : "";
  return [body.playback.plays === "untilStopped" ? "until stopped" : "one-shot", held ? "sustain" : "", typeName(body)].filter(Boolean).join(" · ");
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const PICK: Readonly<Record<string, string>> = { random: "random", shuffle: "shuffle", roundRobin: "round robin" };

/** "In this take"'s summary line: "3 takes, round robin", "Surface · 4 entries", "2 tracks". */
export function playlistSummary(body: PlaylistBody | null): string {
  if (!body) return "";
  const n = body.entries.length;
  switch (body.type) {
    case "queue":
      return `${plural(n, "take")}, ${PICK[body.queue?.pick ?? "random"] ?? "random"}${body.queue?.continuous ? ", continuous" : ""}`;
    case "switch":
      return `${body.switch?.parameter || "Switch"} · ${plural(n, "entry", "entries")}`;
    case "blend":
      return `${(body.blend?.axes ?? []).map((a) => ("parameter" in a ? a.parameter : "voice time")).join(" × ") || "Blend"} · ${plural(n, "zone")}`;
    case "layer":
      return plural(n, "layer");
    case "sequence":
      return plural(body.sequence?.tracks.length ?? 0, "track");
    default:
      return plural(n, "sound");
  }
}

const nameOfPath = (p: string): string => {
  const name = p.slice(p.lastIndexOf("/") + 1);
  const dot = name.indexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

/** An entry's name as the cards say it ("dirt_02", "engine_low"). */
export function entryName(e: Entry, i: number): string {
  switch (e.kind) {
    case "sample":
      return nameOfPath(e.sample);
    case "linked":
      return nameOfPath(e.playlist);
    case "generator":
      return typeof e.generator === "string" ? nameOfPath(e.generator) : "generator";
    case "line":
      return typeof e.line === "string" ? e.line : "line";
    default:
      return `${typeName(e.embedded)} ${i + 1}`;
  }
}

const paramOf = (input: CurveInput): string | null => (typeof input === "string" ? null : input.parameter);

// --- what a parameter drives --------------------------------------------------------------------------------------------

const TARGET_WORD: Readonly<Record<string, string>> = { volume: "volume", gain: "volume", pitch: "pitch", pan: "pan", lowpass: "low-pass", highpass: "high-pass", enabled: "on/off" };

function targetWord(target: string, body: PlaylistBody): string {
  if (target.startsWith("fx:")) {
    const [, id, param] = target.split(":");
    const fx = body.effects.find((f) => f.id === id);
    const spec = fx && isBuiltinEffectType(fx.type) ? EFFECT_CATALOGUE[fx.type] : null;
    return `${spec?.label.toLowerCase() ?? fx?.type ?? "effect"} ${spec?.params.find((p) => p.name === param)?.label.toLowerCase() ?? param}`;
  }
  if (target.startsWith("gen:")) return target.slice(4);
  return TARGET_WORD[target] ?? target;
}

/** The properties `parameter` moves in `body` (and its embedded playlists), in words, without repeats. */
export function drivenBy(body: PlaylistBody, parameter: string): string[] {
  const out = new Set<string>();
  const walk = (b: PlaylistBody) => {
    for (const a of b.automation) if (paramOf(a.input) === parameter && !a.bypass) out.add(targetWord(a.target, b));
    if (b.switch?.parameter === parameter) out.add("which entry plays");
    if (b.blend?.axes.some((a) => "parameter" in a && a.parameter === parameter)) out.add("the blend");
    for (const e of b.entries) {
      for (const [t, c] of Object.entries(e.curves)) if (c && !c.bypass && paramOf(c.input) === parameter) out.add(targetWord(t, b));
      if (e.kind === "embedded") walk(e.embedded);
    }
  };
  walk(body);
  return [...out];
}

/** A game parameter lane's "Drives …" line over the take's playlists: "Drives pitch, low-pass on engine". "" for none. */
export function drivesText(parameter: string, playlists: readonly { readonly label: string; readonly body: PlaylistBody | null }[]): string {
  const parts: string[] = [];
  for (const p of playlists) {
    if (!p.body) continue;
    const what = drivenBy(p.body, parameter);
    if (what.length) parts.push(`${what.join(", ")} on ${p.label}`);
  }
  if (parts.length === 0) return "";
  return `Drives ${parts.slice(0, 2).join("; ")}${parts.length > 2 ? `; +${parts.length - 2} more` : ""}`;
}

// --- property cards -------------------------------------------------------------------------------------------------------

/** How a property reads: its unit, range and scale (the bar), and how its curve's output combines with the authored value. */
interface PropertyScale {
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly scale: "linear" | "log";
  /** The curve's output adds to the authored value (dB, semitones) or replaces it (a cutoff). */
  readonly adds: boolean;
}

const SCALES: Readonly<Record<string, PropertyScale>> = {
  volume: { unit: "dB", min: -60, max: 12, scale: "linear", adds: true },
  gain: { unit: "dB", min: -60, max: 12, scale: "linear", adds: true },
  pitch: { unit: "st", min: -24, max: 24, scale: "linear", adds: true },
  pan: { unit: "%", min: -100, max: 100, scale: "linear", adds: false },
  lowpass: { unit: "Hz", min: 20, max: 20000, scale: "log", adds: false },
  highpass: { unit: "Hz", min: 20, max: 20000, scale: "log", adds: false },
  enabled: { unit: "", min: 0, max: 1, scale: "linear", adds: false },
};
const LABEL: Readonly<Record<string, string>> = { volume: "Volume", gain: "Volume", pitch: "Pitch", pan: "Pan", lowpass: "Low-pass", highpass: "High-pass", enabled: "On" };
/** What a property is with no curve (a voice curve's plain value). */
const PLAIN: Readonly<Record<string, number>> = { volume: 0, gain: 0, pitch: 0, pan: 0, lowpass: 20000, highpass: 20, enabled: 1 };

/** The driver of a card: the parameter and the mapping, for the "← Speed · −3 to +7 st · ease-in" line. */
export interface CardDriver {
  readonly parameter: string;
  /** "−3 to +7 st · ease-in · seek 50/s". */
  readonly mapping: string;
}

export interface PropertyCard {
  readonly key: string;
  readonly label: string;
  /** The authored value and the live one, in `unit`. */
  readonly authored: number;
  readonly live: number;
  readonly unit: string;
  /** Where the authored tick and the live fill sit on the bar, 0..1. */
  readonly authoredAt: number;
  readonly liveAt: number;
  /** "−6.0 dB", "8.2 kHz". */
  readonly text: string;
  /** Null for a static property (its fill is muted). */
  readonly driver: CardDriver | null;
  /** A note for a static property with randomness ("random ± 1.0 st"). */
  readonly note?: string;
}

const minus = (s: string) => s.replace(/^-/, "−");

/** A value in its unit: "−6.0 dB", "+4.2 st", "8.2 kHz", "800 Hz". */
export function unitText(v: number, unit: string): string {
  if (unit === "Hz") return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`;
  if (unit === "dB" || unit === "st") return `${v > 0.05 ? "+" : ""}${minus(v.toFixed(1))} ${unit}`;
  if (unit === "%") return `${Math.round(v)}%`;
  if (unit === "") return v >= 0.5 ? "on" : "off";
  return `${minus(String(Math.round(v * 100) / 100))} ${unit}`;
}

const SHAPE: Readonly<Record<string, string>> = { linear: "linear", step: "steps", smooth: "smooth", easeIn: "ease-in", easeOut: "ease-out", bezier: "custom curve" };

/** A curve's shape in a word: the shape of its segments when they share one. */
export function curveShapeText(curve: Curve): string {
  const kinds = new Set(curve.slice(0, -1).map((k) => (k.length >= 3 ? (k[2] as string) : "linear")));
  return kinds.size === 1 ? SHAPE[[...kinds][0]!] ?? "custom curve" : "custom curve";
}

function position(v: number, s: PropertyScale): number {
  if (s.scale === "log") {
    const lo = Math.log(s.min), hi = Math.log(s.max);
    return Math.min(1, Math.max(0, (Math.log(Math.max(s.min, v)) - lo) / (hi - lo)));
  }
  return Math.min(1, Math.max(0, (v - s.min) / (s.max - s.min)));
}

function mappingText(curve: Curve, s: PropertyScale, def: ParameterDef | undefined): string {
  const ys = curve.map((k) => k[1]);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const num = (v: number) => `${v > 0.05 ? "+" : ""}${minus(v.toFixed(1).replace(/\.0$/, ""))}`;
  const range = s.unit === "Hz" ? `${unitText(lo, "Hz")} to ${unitText(hi, "Hz")}` : `${num(lo)} to ${num(hi)}${s.unit ? ` ${s.unit}` : ""}`;
  const parts = [range, s.scale === "log" ? "log" : curveShapeText(curve)];
  if (def && "seekSpeed" in def && def.seekSpeed > 0) parts.push(`seek ${def.seekSpeed}/s`);
  return parts.join(" · ");
}

/**
 * The property cards of `body` at the playhead: Volume and Pitch always; then every property a game parameter moves
 * (instance automation, each entry's voice curves). `valueOf` is the game's value of a parameter at the playhead (null:
 * the take never set it, so the curve isn't evaluated and the card shows the authored value).
 */
export function propertyCards(body: PlaylistBody, valueOf: (parameter: string) => number | null, defs: readonly ParameterDef[] = []): PropertyCard[] {
  const cards: PropertyCard[] = [];
  const defOf = (name: string) => defs.find((d) => d.name === name) ?? body.parameters.find((d) => d.name === name);
  const card = (key: string, label: string, target: string, authored: number, curve: Curve | null, parameter: string | null, note?: string) => {
    const s = SCALES[target] ?? { unit: "", min: Math.min(0, ...(curve ?? []).map((k) => k[1])), max: Math.max(1, ...(curve ?? []).map((k) => k[1])), scale: "linear" as const, adds: false };
    const v = parameter !== null ? valueOf(parameter) : null;
    const out = curve && curve.length && v !== null ? evalCurve(curve, v) : null;
    const live = out === null ? authored : s.adds ? authored + out : out;
    cards.push({
      key, label, authored, live, unit: s.unit, authoredAt: position(authored, s), liveAt: position(live, s), text: unitText(live, s.unit),
      driver: curve && parameter !== null ? { parameter, mapping: mappingText(curve, s, defOf(parameter)) } : null,
      ...(note ? { note } : {}),
    });
  };
  const auto = (target: string) => body.automation.find((a) => a.target === target && !a.bypass && paramOf(a.input) !== null);
  const vol = auto("volume");
  card("volume", "Volume", "volume", body.volume, vol?.curve ?? null, vol ? paramOf(vol.input) : null, body.volumeRandom[0] || body.volumeRandom[1] ? `random ${body.volumeRandom[0]} to ${body.volumeRandom[1]} dB` : undefined);
  const pitch = auto("pitch");
  const pr = Math.max(Math.abs(body.pitchRandom[0]), Math.abs(body.pitchRandom[1]));
  card("pitch", "Pitch", "pitch", body.pitch, pitch?.curve ?? null, pitch ? paramOf(pitch.input) : null, pr ? `random ± ${pr.toFixed(1)} st` : undefined);
  for (const a of body.automation) {
    if (a.bypass || a.target === "volume" || a.target === "pitch") continue;
    const parameter = paramOf(a.input);
    if (parameter === null) continue;
    if (a.target.startsWith("fx:")) {
      const [, id, param] = a.target.split(":");
      const fx = body.effects.find((f) => f.id === id);
      const spec = fx && isBuiltinEffectType(fx.type) ? EFFECT_CATALOGUE[fx.type] : null;
      const ps = spec?.params.find((p) => p.name === param);
      const authored = fx?.params[param!] ?? ps?.default ?? 0;
      const label = `${spec?.label ?? fx?.type ?? "Effect"} ${ps?.label.toLowerCase() ?? param}`;
      if (ps && ps.unit === "Hz") card(a.id, label, "lowpass", authored, a.curve, parameter);
      else card(a.id, label, `fx:${ps?.unit ?? ""}`, authored, a.curve, parameter);
      continue;
    }
    card(a.id, LABEL[a.target] ?? a.target, a.target, PLAIN[a.target] ?? 0, a.curve, parameter);
  }
  const many = body.entries.filter((e) => Object.values(e.curves).some((c) => c && !c.bypass && paramOf(c.input) !== null)).length > 1;
  body.entries.forEach((e, i) => {
    for (const [t, c] of Object.entries(e.curves) as [VoiceCurveTarget, NonNullable<Entry["curves"][VoiceCurveTarget]>][]) {
      if (!c || c.bypass) continue;
      const parameter = paramOf(c.input);
      if (parameter === null) continue;
      const base = t === "gain" ? e.volume : t === "pitch" ? e.pitch : (PLAIN[t] ?? 0);
      card(`entry${i}:${t}`, many || body.entries.length > 1 ? `${entryName(e, i)} · ${LABEL[t] ?? t}` : (LABEL[t] ?? t), t, base, c.curve, parameter);
    }
  });
  return cards;
}
