/**
 * Playlists (ADR 0329): parse and write `*.playlist.json` (`myco.playlist@1`). The shapes are the contract in `types.ts`.
 *
 * The parse is lenient (bad values fall back to defaults with one problem line; it never throws) and canonical: every
 * field the contract has is filled, ids are unique, and the rules the runtime relies on hold:
 *
 * - a sample entry appears only in a Clip playlist: elsewhere it is wrapped in an embedded Clip (the editor's rule),
 *   with the per-use settings (volume, pitch, weight, x/y, at-zero-weight, curves) on the wrapper;
 * - a Clip playlist's entries are samples (others are dropped); a Clip plays its first sample (more are kept, as in the
 *   prototype, with a problem; none is a problem);
 * - a Switch map points at entries that exist, or null;
 * - a sequence clip names exactly one of `sample` / `playlist`;
 * - the type's own block (`queue` for a Queue…) is always there (defaults when missing); another type's block is kept
 *   when the file has one (switching type back and forth keeps its settings) and is null otherwise;
 * - limits, declared once in `PLAYLIST_LIMITS` (ADR 0306): over a limit, the rest is dropped with a problem.
 *
 * `playlistToJson` writes the canonical form in a stable key order, leaving out values equal to their defaults, so that
 * `parsePlaylist(playlistToJson(x)).playlist` deep-equals `x` for any parsed `x`.
 *
 * Pure; no plugin, no DOM.
 */
import { attenuationToJson, parseAttenuation } from "../attenuation/format";
import { effectsToJson, parseEffects } from "../effects/catalogue";
import { curveToJson, IdScope, isFiniteNumber, isRecord, LenientReader, CURVE_KEY_LIMIT, type JsonRecord } from "../lenientRead";
import type { EffectLevel } from "../effects/types";
import { isLabelled, MAX_LOCAL_PARAMETERS, parseParameters, type ParameterDef } from "../eventFormat";
import { loopBehaviourToJson, loopOverrideToJson, parseLoopBehaviour, parseLoopOverride } from "./loopBehaviour";
import {
  PLAYLIST_FORMAT, PLAYLIST_SUFFIX, PLAYLIST_TYPES, type Adsr, type Automation, type BlendAxis, type BlendSettings, type ChangeHow, type ChangeRule,
  type ChangeWhen, type Clip, type CurveInput, type Entry, type EntryUse, type PlaybackRules, type PlaylistAsset, type PlaylistBody, type PlaylistParse,
  type PlaylistSpatial, type PlaylistType, type QueueSettings, type SampleEntry, type SequenceLoop, type SequenceMarker, type SequenceSettings,
  type Stinger, type SwitchSettings, type Track, type VoiceCurve, type VoiceCurveTarget,
} from "./types";

/** Limits of a playlist, declared once (ADR 0306; the first five are ADR 0329's). */
export const PLAYLIST_LIMITS = Object.freeze({
  /** Entries of one playlist. */
  entries: 256,
  /** Embedded playlists inside embedded playlists. */
  nesting: 16,
  /** Tracks of one sequence. */
  tracks: 32,
  /** Clips of one sequence, over all its tracks. */
  clips: 512,
  /** Keys of one curve. */
  curveKeys: CURVE_KEY_LIMIT,
  /** Local parameters (the core's slots per instance). */
  parameters: MAX_LOCAL_PARAMETERS,
  stingers: 32,
  /** Switch change rules. */
  rules: 64,
  /** Loops and markers of one sequence. */
  sequenceLoops: 64,
  sequenceMarkers: 256,
  /** Automation lanes of one clip or track. */
  automation: 32,
  /** Effects of one chain. */
  effects: 16,
});

export const VOICE_CURVE_TARGETS: readonly VoiceCurveTarget[] = ["gain", "pitch", "pan", "lowpass", "highpass"];
export const CHANGE_WHEN: readonly ChangeWhen[] = ["now", "beat", "bar", "exit", "nextTrigger"];
export const TIME_INPUTS = ["voiceTime", "clipTime", "sequenceTime"] as const;

const WHEN_FULL = ["stealOldest", "stealQuietest", "stealFarthest", "refuse"] as const;
const METER = /^\d{1,2}\/\d{1,2}$/;
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;
const FX_TARGET = /^fx:[^:]+:[^:]+$/;

/** True for a playlist asset path. */
export const isPlaylistPath = (path: string): boolean => path.toLowerCase().endsWith(PLAYLIST_SUFFIX);

// --- defaults --------------------------------------------------------------------------------------------------------

export const defaultPlayback = (): PlaybackRules => ({ plays: "oneShot", maxInstances: 0, whenFull: "stealOldest", cooldown: 0, chance: 1, delay: 0, priority: 128 });
export const defaultEntryUse = (): EntryUse => ({ volume: 0, pitch: 0, weight: 1, atZeroWeight: "stop", curves: {} });
export const defaultQueue = (): QueueSettings => ({ pick: "random", avoidRepeat: 1, continuous: null });
export const defaultChange = (when: ChangeWhen = "now"): ChangeHow => ({ when, how: "crossfade", length: when === "now" || when === "nextTrigger" ? { ms: 200 } : { beats: 1 } });
export const defaultSwitch = (): SwitchSettings => ({ parameter: "", map: {}, labelGain: {}, onChange: defaultChange(), rules: [] });
export const defaultAdsr = (): Adsr => ({ attackMs: 10, decayMs: 100, sustain: 1, releaseMs: 200 });
export const defaultBlend = (): BlendSettings => ({
  axes: [{ voiceTime: 2 }], fade: "crossfade", curve: "equalPower", follow: { glideMs: 120 },
  envelope: { mode: "off", low: defaultAdsr(), high: defaultAdsr() },
});
export const defaultSequence = (): SequenceSettings => ({ length: 4, tempo: null, tracks: [], loops: [], markers: [] });

/** The default of a type's own block. */
function ownBlock(type: PlaylistType): Partial<Pick<PlaylistBody, "queue" | "switch" | "blend" | "sequence">> {
  switch (type) {
    case "queue": return { queue: defaultQueue() };
    case "switch": return { switch: defaultSwitch() };
    case "blend": return { blend: defaultBlend() };
    case "sequence": return { sequence: defaultSequence() };
    default: return {};
  }
}

/** An empty playlist body of `type` (its own block at defaults). */
export function emptyPlaylistBody(type: PlaylistType = "queue"): PlaylistBody {
  return {
    type, output: null, playback: defaultPlayback(), volume: 0, pitch: 0, volumeRandom: [0, 0], pitchRandom: [0, 0], effects: [], automation: [], spatial: null,
    parameters: [], stingers: [], entries: [], queue: null, switch: null, blend: null, sequence: null, ...ownBlock(type),
  };
}

/** An empty playlist asset of `type`. */
export const emptyPlaylist = (type: PlaylistType = "queue"): PlaylistAsset => ({ format: PLAYLIST_FORMAT, ...emptyPlaylistBody(type) });

// --- parse -----------------------------------------------------------------------------------------------------------

class PlaylistReader {
  readonly r: LenientReader;
  constructor(readonly problems: string[]) {
    this.r = new LenientReader(problems);
  }

  body(raw: JsonRecord, where: string, depth: number): PlaylistBody {
    const r = this.r;
    const at = (k: string) => (where ? `${where}.${k}` : k);
    const type = r.pick(raw.type, at("type"), PLAYLIST_TYPES, "queue");
    if (raw.type === undefined) r.problem(at("type"), 'missing; using "queue".');
    const out = emptyPlaylistBody(type);
    out.output = r.strOrNull(raw.output, at("output"), null);
    if (out.output === "") out.output = null;
    out.playback = this.playback(raw.playback, at("playback"));
    out.volume = r.num(raw.volume, at("volume"), 0, -96, 24);
    out.pitch = r.num(raw.pitch, at("pitch"), 0, -48, 48);
    out.volumeRandom = r.pair(raw.volumeRandom, at("volumeRandom"), [0, 0], -48, 48);
    out.pitchRandom = r.pair(raw.pitchRandom, at("pitchRandom"), [0, 0], -24, 24);
    out.effects = this.effects(raw.effects, at("effects"), "instance");
    out.automation = this.automation(raw.automation, at("automation"), "voiceTime", true);
    out.spatial = this.spatial(raw.spatial, at("spatial"));
    out.parameters = parseParameters(raw.parameters, at("parameters"), this.problems, PLAYLIST_LIMITS.parameters);
    const note = r.optStr(raw.note, at("note"));
    if (note) out.note = note;

    r.list(raw.entries, at("entries")).forEach((e, i) => {
      const w = `${at("entries")}[${i}]`;
      if (out.entries.length >= PLAYLIST_LIMITS.entries) return void r.problem(w, `at most ${PLAYLIST_LIMITS.entries} entries; dropped.`);
      const entry = this.entry(e, w, depth, type === "clip");
      if (entry) out.entries.push(entry);
    });
    if (type === "clip") {
      const kept = out.entries.filter((e) => e.kind === "sample");
      if (kept.length < out.entries.length) r.problem(at("entries"), "a Clip plays a sample; its other entries are dropped.");
      out.entries = kept;
      if (kept.length === 0) r.problem(at("entries"), "a Clip needs one sample; it plays nothing.");
      else if (kept.length > 1) r.problem(at("entries"), "a Clip plays one sample; the entries after the first are kept but not played.");
    }

    r.list(raw.stingers, at("stingers")).forEach((s, i) => {
      const w = `${at("stingers")}[${i}]`;
      if (out.stingers.length >= PLAYLIST_LIMITS.stingers) return void r.problem(w, `at most ${PLAYLIST_LIMITS.stingers} stingers; dropped.`);
      const stinger = this.stinger(s, w, depth);
      if (stinger) out.stingers.push(stinger);
    });

    const block = <T>(key: "queue" | "switch" | "blend" | "sequence", read: (o: JsonRecord, w: string) => T): T | null => {
      const v = raw[key];
      if (v === undefined || v === null) return null;
      const o = r.record(v, at(key));
      return o ? read(o, at(key)) : null;
    };
    out.queue = block("queue", (o, w) => this.queue(o, w)) ?? out.queue;
    out.switch = block("switch", (o, w) => this.switchBlock(o, w, depth, out.entries.length)) ?? out.switch;
    out.blend = block("blend", (o, w) => this.blend(o, w)) ?? out.blend;
    out.sequence = block("sequence", (o, w) => this.sequence(o, w, depth)) ?? out.sequence;
    return out;
  }

  playback(raw: unknown, where: string): PlaybackRules {
    const r = this.r;
    const out = defaultPlayback();
    const o = r.record(raw, where);
    if (!o) return out;
    out.plays = r.pick(o.plays, `${where}.plays`, ["oneShot", "untilStopped"] as const, "oneShot");
    out.maxInstances = r.int(o.maxInstances, `${where}.maxInstances`, 0, 0, 32);
    out.whenFull = r.pick(o.whenFull, `${where}.whenFull`, WHEN_FULL, "stealOldest");
    out.cooldown = r.num(o.cooldown, `${where}.cooldown`, 0, 0, 5);
    out.chance = r.num(o.chance, `${where}.chance`, 1, 0, 1);
    out.delay = r.num(o.delay, `${where}.delay`, 0, 0, 2);
    out.priority = r.int(o.priority, `${where}.priority`, 128, 0, 255);
    return out;
  }

  effects(raw: unknown, where: string, level: EffectLevel) {
    return parseEffects(raw, level, where, this.problems, PLAYLIST_LIMITS.effects);
  }

  spatial(raw: unknown, where: string): PlaylistSpatial | null {
    const r = this.r;
    const o = r.record(raw, where);
    if (!o) return null;
    let attenuation: PlaylistSpatial["attenuation"] = null;
    if (typeof o.attenuation === "string") {
      if (o.attenuation !== "") attenuation = o.attenuation;
    } else if (isRecord(o.attenuation)) attenuation = parseAttenuation(o.attenuation, `${where}.attenuation`, this.problems);
    else if (o.attenuation !== undefined && o.attenuation !== null) r.problem(`${where}.attenuation`, "must be a preset path, an attenuation object or null; using none.");
    let spread: number | null = null;
    if (o.spread !== undefined && o.spread !== null) spread = r.num(o.spread, `${where}.spread`, 0, 0, 360);
    return { attenuation, occlusion: r.bool(o.occlusion, `${where}.occlusion`, false), doppler: r.num(o.doppler, `${where}.doppler`, 0, 0, 5), spread };
  }

  /** The per-use fields of an entry. */
  use(o: JsonRecord, where: string): EntryUse {
    const r = this.r;
    const out = defaultEntryUse();
    out.volume = r.num(o.volume, `${where}.volume`, 0, -96, 24);
    out.pitch = r.num(o.pitch, `${where}.pitch`, 0, -48, 48);
    out.weight = r.num(o.weight, `${where}.weight`, 1, 0, 100);
    if (o.x !== undefined) out.x = r.num(o.x, `${where}.x`, 0);
    if (o.y !== undefined) out.y = r.num(o.y, `${where}.y`, 0);
    out.atZeroWeight = r.pick(o.atZeroWeight, `${where}.atZeroWeight`, ["stop", "continue"] as const, "stop");
    const curves = r.record(o.curves, `${where}.curves`);
    if (curves) {
      for (const [k, v] of Object.entries(curves)) {
        const w = `${where}.curves.${k}`;
        if (!(VOICE_CURVE_TARGETS as readonly string[]).includes(k)) { r.problem(w, `unknown target (expected ${VOICE_CURVE_TARGETS.join(", ")}); dropped.`); continue; }
        const c = this.voiceCurve(v, w);
        if (c) out.curves[k as VoiceCurveTarget] = c;
      }
    }
    return out;
  }

  input(raw: unknown, where: string, fallback: CurveInput): CurveInput {
    if (raw === undefined) return fallback;
    if (typeof raw === "string" && (TIME_INPUTS as readonly string[]).includes(raw)) return raw as CurveInput;
    if (typeof raw === "string" && raw !== "") return { parameter: raw };
    if (isRecord(raw) && typeof raw.parameter === "string" && raw.parameter !== "") return { parameter: raw.parameter };
    this.r.problem(where, `must be ${TIME_INPUTS.join(", ")} or a parameter; using ${JSON.stringify(fallback)}.`);
    return fallback;
  }

  voiceCurve(raw: unknown, where: string): VoiceCurve | null {
    const r = this.r;
    if (!isRecord(raw)) { r.problem(where, "a curve must be an object { input, curve }; dropped."); return null; }
    const curve = r.curve(raw.curve, `${where}.curve`);
    if (!curve || curve.length === 0) { if (curve) r.problem(`${where}.curve`, "has no keys; dropped."); return null; }
    return { input: this.input(raw.input, `${where}.input`, "voiceTime"), curve, bypass: r.bool(raw.bypass, `${where}.bypass`, false) };
  }

  /** Automation lanes; `instance` (a playlist's own lanes) takes voice time or a parameter only. */
  automation(raw: unknown, where: string, defaultInput: CurveInput, instance = false): Automation[] {
    const r = this.r;
    const out: Automation[] = [];
    const ids = new IdScope(r);
    r.list(raw, where).forEach((a, i) => {
      const w = `${where}[${i}]`;
      if (out.length >= PLAYLIST_LIMITS.automation) return void r.problem(w, `at most ${PLAYLIST_LIMITS.automation} automation lanes; dropped.`);
      if (!isRecord(a)) return void r.problem(w, "automation must be an object; dropped.");
      const target = a.target;
      if (!(target === "volume" || target === "pitch" || target === "pan" || target === "enabled" || (typeof target === "string" && FX_TARGET.test(target)))) {
        return void r.problem(`${w}.target`, `must be volume, pitch, pan, enabled or fx:<effect id>:<parameter>; dropped.`);
      }
      const curve = r.curve(a.curve, `${w}.curve`);
      if (!curve || curve.length === 0) return void r.problem(`${w}.curve`, "needs keys; dropped.");
      let input = this.input(a.input, `${w}.input`, defaultInput);
      if (instance && (input === "clipTime" || input === "sequenceTime")) {
        r.problem(`${w}.input`, `${input} belongs to sequence clips and tracks; a playlist's own automation reads voiceTime.`);
        input = "voiceTime";
      }
      out.push({ id: ids.take(a.id, w, "a"), target: target as Automation["target"], input, curve, bypass: r.bool(a.bypass, `${w}.bypass`, false) });
    });
    return out;
  }

  /** An entry; a sample outside a Clip is wrapped in an embedded Clip. */
  entry(raw: unknown, where: string, depth: number, inClip: boolean): Entry | null {
    const r = this.r;
    if (!isRecord(raw)) { r.problem(where, "an entry must be an object; dropped."); return null; }
    const kinds = (["sample", "playlist", "embedded"] as const).filter((k) => raw[k] !== undefined);
    if (kinds.length === 0) { r.problem(where, 'an entry needs "sample", "playlist" or "embedded"; dropped.'); return null; }
    if (kinds.length > 1) r.problem(where, `has ${kinds.join(" and ")}; using "${kinds[0]}".`);
    const use = this.use(raw, where);
    const kind = kinds[0];
    if (kind === "sample") {
      if (typeof raw.sample !== "string" || raw.sample === "") { r.problem(`${where}.sample`, "must be a sample path; dropped."); return null; }
      let trim: [number, number] | null = null;
      if (raw.trim !== undefined && raw.trim !== null) {
        const t = raw.trim;
        if (Array.isArray(t) && t.length === 2 && isFiniteNumber(t[0]) && isFiniteNumber(t[1]) && t[0] >= 0 && t[1] > t[0]) trim = [t[0], t[1]];
        else r.problem(`${where}.trim`, "must be [start, end] seconds with 0 ≤ start < end, or null; using the sample's trim.");
      }
      const loop = r.pick(raw.loop, `${where}.loop`, ["inherit", "off", "on"] as const, "inherit");
      if (inClip) return { kind: "sample", sample: raw.sample, trim, loop, ...use };
      r.problem(where, "a sample plays only in a Clip; wrapped in an embedded Clip.");
      const inner: SampleEntry = { kind: "sample", sample: raw.sample, trim, loop, ...defaultEntryUse() };
      return { kind: "embedded", embedded: { ...emptyPlaylistBody("clip"), entries: [inner] }, ...use };
    }
    if (kind === "playlist") {
      if (typeof raw.playlist !== "string" || raw.playlist === "") { r.problem(`${where}.playlist`, "must be a playlist path; dropped."); return null; }
      return { kind: "linked", playlist: raw.playlist, ...use };
    }
    const body = this.embedded(raw.embedded, `${where}.embedded`, depth);
    return body ? { kind: "embedded", embedded: body, ...use } : null;
  }

  /** An embedded body one level down, or null past the nesting limit or for a non-object. */
  embedded(raw: unknown, where: string, depth: number): PlaylistBody | null {
    const r = this.r;
    if (!isRecord(raw)) { r.problem(where, "an embedded playlist must be an object; dropped."); return null; }
    if (depth + 1 > PLAYLIST_LIMITS.nesting) { r.problem(where, `playlists nest at most ${PLAYLIST_LIMITS.nesting} deep; dropped.`); return null; }
    return this.body(raw, where, depth + 1);
  }

  /** An entry outside a body's entry list (a transition, a stinger): a sample is wrapped too. */
  looseEntry(raw: unknown, where: string, depth: number): Entry | null {
    return this.entry(raw, where, depth, false);
  }

  stinger(raw: unknown, where: string, depth: number): Stinger | null {
    const r = this.r;
    if (!isRecord(raw)) { r.problem(where, "a stinger must be an object; dropped."); return null; }
    const playlist = this.looseEntry(raw.playlist, `${where}.playlist`, depth);
    if (!playlist) return null;
    return {
      trigger: r.str(raw.trigger, `${where}.trigger`, ""),
      playlist,
      at: r.pick(raw.at, `${where}.at`, ["now", "beat", "bar", "exit", "hit"] as const, "bar"),
      ifLate: r.pick(raw.ifLate, `${where}.ifLate`, ["nextGrid", "playNow", "skip"] as const, "nextGrid"),
      dontRepeat: r.num(raw.dontRepeat, `${where}.dontRepeat`, 0, 0, 600),
    };
  }

  queue(o: JsonRecord, where: string): QueueSettings {
    const r = this.r;
    let continuous: QueueSettings["continuous"] = null;
    if (o.continuous !== undefined && o.continuous !== null) {
      const c = r.record(o.continuous, `${where}.continuous`);
      if (c) continuous = { gapMs: r.num(c.gapMs, `${where}.continuous.gapMs`, 0, -10000, 60000) };
    }
    return {
      pick: r.pick(o.pick, `${where}.pick`, ["random", "shuffle", "roundRobin"] as const, "random"),
      avoidRepeat: r.int(o.avoidRepeat, `${where}.avoidRepeat`, 1, 0, 5),
      continuous,
    };
  }

  change(o: JsonRecord, where: string, depth: number): ChangeHow {
    const r = this.r;
    const when = r.pick(o.when, `${where}.when`, CHANGE_WHEN, "now");
    const out = defaultChange(when);
    out.how = r.pick(o.how, `${where}.how`, ["crossfade", "cut", "transition"] as const, "crossfade");
    if (o.length !== undefined) {
      const l = o.length;
      if (isRecord(l) && l.ms !== undefined && l.beats === undefined) out.length = { ms: r.num(l.ms, `${where}.length.ms`, 200, 0, 60000) };
      else if (isRecord(l) && l.beats !== undefined && l.ms === undefined) out.length = { beats: r.num(l.beats, `${where}.length.beats`, 1, 0, 9999) };
      else r.problem(`${where}.length`, `must be { "ms": n } or { "beats": n }; using ${JSON.stringify(out.length)}.`);
    }
    if (o.transition !== undefined && o.transition !== null) {
      const t = this.looseEntry(o.transition, `${where}.transition`, depth);
      if (t) out.transition = t;
    }
    if (out.how === "transition" && !out.transition) {
      r.problem(`${where}.how`, 'a transition needs a "transition" playlist; using a crossfade.');
      out.how = "crossfade";
    }
    return out;
  }

  switchBlock(o: JsonRecord, where: string, depth: number, entries: number): SwitchSettings {
    const r = this.r;
    const out = defaultSwitch();
    out.parameter = r.str(o.parameter, `${where}.parameter`, "");
    const map = r.record(o.map, `${where}.map`);
    if (map) {
      for (const [label, v] of Object.entries(map)) {
        if (v === null) out.map[label] = null;
        else if (Number.isInteger(v) && (v as number) >= 0 && (v as number) < entries) out.map[label] = v as number;
        else {
          r.problem(`${where}.map.${label}`, `must be an entry index 0..${entries - 1} or null; plays nothing.`);
          out.map[label] = null;
        }
      }
    }
    const gains = r.record(o.labelGain, `${where}.labelGain`);
    if (gains) for (const [label, v] of Object.entries(gains)) out.labelGain[label] = r.num(v, `${where}.labelGain.${label}`, 0, -24, 12);
    const onChange = r.record(o.onChange, `${where}.onChange`);
    if (onChange) out.onChange = this.change(onChange, `${where}.onChange`, depth);
    r.list(o.rules, `${where}.rules`).forEach((raw, i) => {
      const w = `${where}.rules[${i}]`;
      if (out.rules.length >= PLAYLIST_LIMITS.rules) return void r.problem(w, `at most ${PLAYLIST_LIMITS.rules} rules; dropped.`);
      if (!isRecord(raw)) return void r.problem(w, "a rule must be an object; dropped.");
      const rule: ChangeRule = { from: r.str(raw.from, `${w}.from`, "*") || "*", to: r.str(raw.to, `${w}.to`, "*") || "*", ...this.change(raw, w, depth) };
      out.rules.push(rule);
    });
    return out;
  }

  adsr(raw: unknown, where: string): Adsr {
    const r = this.r;
    const o = r.record(raw, where);
    const d = defaultAdsr();
    if (!o) return d;
    return {
      attackMs: r.num(o.attackMs, `${where}.attackMs`, d.attackMs, 0, 10000),
      decayMs: r.num(o.decayMs, `${where}.decayMs`, d.decayMs, 0, 10000),
      sustain: r.num(o.sustain, `${where}.sustain`, d.sustain, 0, 1),
      releaseMs: r.num(o.releaseMs, `${where}.releaseMs`, d.releaseMs, 0, 10000),
    };
  }

  axis(raw: unknown, where: string): BlendAxis | null {
    const r = this.r;
    if (isRecord(raw) && typeof raw.parameter === "string") return { parameter: raw.parameter };
    if (isRecord(raw) && raw.voiceTime !== undefined) return { voiceTime: r.num(raw.voiceTime, `${where}.voiceTime`, 2, 0.2, 30) };
    if (typeof raw === "string" && raw !== "") return { parameter: raw };
    r.problem(where, 'an axis must be { "parameter": name } or { "voiceTime": seconds }; dropped.');
    return null;
  }

  blend(o: JsonRecord, where: string): BlendSettings {
    const r = this.r;
    const out = defaultBlend();
    if (o.axes !== undefined) {
      const axes = r.list(o.axes, `${where}.axes`).map((a, i) => this.axis(a, `${where}.axes[${i}]`)).filter((a): a is BlendAxis => a !== null);
      if (axes.length === 0) r.problem(`${where}.axes`, "needs one or two axes; using voice time.");
      else {
        if (axes.length > 2) r.problem(`${where}.axes`, "at most two axes; the rest are dropped.");
        out.axes = axes.length === 1 ? [axes[0]] : [axes[0], axes[1]];
      }
    }
    out.fade = r.pick(o.fade, `${where}.fade`, ["crossfade", "layer"] as const, "crossfade");
    out.curve = r.pick(o.curve, `${where}.curve`, ["linear", "equalPower"] as const, "equalPower");
    if (o.follow === "hold") out.follow = "hold";
    else if (isRecord(o.follow)) out.follow = { glideMs: r.num(o.follow.glideMs, `${where}.follow.glideMs`, 120, 0, 5000) };
    else if (o.follow !== undefined) r.problem(`${where}.follow`, 'must be { "glideMs": n } or "hold"; using a 120 ms glide.');
    const env = r.record(o.envelope, `${where}.envelope`);
    if (env) {
      out.envelope = {
        mode: r.pick(env.mode, `${where}.envelope.mode`, ["off", "morph", "zone"] as const, "off"),
        low: this.adsr(env.low, `${where}.envelope.low`),
        high: this.adsr(env.high, `${where}.envelope.high`),
      };
    }
    return out;
  }

  sequence(o: JsonRecord, where: string, depth: number): SequenceSettings {
    const r = this.r;
    const out = defaultSequence();
    out.length = r.num(o.length, `${where}.length`, 4, 0, 86400);
    if (o.tempo !== undefined && o.tempo !== null) {
      const t = r.record(o.tempo, `${where}.tempo`);
      if (t) {
        let meter = "4/4";
        if (t.meter !== undefined) {
          if (typeof t.meter === "string" && METER.test(t.meter) && !t.meter.split("/").some((n) => Number(n) === 0)) meter = t.meter;
          else r.problem(`${where}.tempo.meter`, 'must be a meter like "4/4"; using "4/4".');
        }
        out.tempo = { bpm: r.num(t.bpm, `${where}.tempo.bpm`, 120, 20, 400), meter };
      }
    }
    const trackIds = new IdScope(r);
    const clipIds = new IdScope(r);
    let clips = 0;
    r.list(o.tracks, `${where}.tracks`).forEach((raw, i) => {
      const w = `${where}.tracks[${i}]`;
      if (out.tracks.length >= PLAYLIST_LIMITS.tracks) return void r.problem(w, `at most ${PLAYLIST_LIMITS.tracks} tracks; dropped.`);
      if (!isRecord(raw)) return void r.problem(w, "a track must be an object; dropped.");
      const kind = r.pick(raw.kind, `${w}.kind`, ["audio", "playlist"] as const, "audio");
      let color: number | string = 1;
      if (raw.color !== undefined) {
        if ((Number.isInteger(raw.color) && (raw.color as number) >= 1 && (raw.color as number) <= 8) || (typeof raw.color === "string" && HEX_COLOUR.test(raw.color))) color = raw.color as number | string;
        else r.problem(`${w}.color`, "must be a series index 1..8 or #rrggbb; using 1.");
      }
      const track: Track = {
        id: trackIds.take(raw.id, w, "t"),
        name: r.str(raw.name, `${w}.name`, `Track ${out.tracks.length + 1}`),
        kind, color,
        volume: r.num(raw.volume, `${w}.volume`, 0, -96, 24),
        pan: r.num(raw.pan, `${w}.pan`, 0, -1, 1),
        output: r.strOrNull(raw.output, `${w}.output`, null) || null,
        mute: r.bool(raw.mute, `${w}.mute`, false),
        solo: r.bool(raw.solo, `${w}.solo`, false),
        enabled: r.bool(raw.enabled, `${w}.enabled`, true),
        effects: this.effects(raw.effects, `${w}.effects`, "instance"),
        automation: this.automation(raw.automation, `${w}.automation`, "sequenceTime"),
        clips: [],
      };
      r.list(raw.clips, `${w}.clips`).forEach((c, j) => {
        const cw = `${w}.clips[${j}]`;
        if (clips >= PLAYLIST_LIMITS.clips) return void r.problem(cw, `a sequence holds at most ${PLAYLIST_LIMITS.clips} clips; dropped.`);
        const clip = this.clip(c, cw, depth, kind, clipIds);
        if (clip) { track.clips.push(clip); clips++; }
      });
      out.tracks.push(track);
    });
    const loopIds = new IdScope(r);
    r.list(o.loops, `${where}.loops`).forEach((raw, i) => {
      const w = `${where}.loops[${i}]`;
      if (out.loops.length >= PLAYLIST_LIMITS.sequenceLoops) return void r.problem(w, `at most ${PLAYLIST_LIMITS.sequenceLoops} loops; dropped.`);
      if (!isRecord(raw)) return void r.problem(w, "a loop must be an object; dropped.");
      let start = r.num(raw.start, `${w}.start`, 0, 0);
      let end = r.num(raw.end, `${w}.end`, start, 0);
      if (end < start) { r.problem(w, "end was before start; swapped."); [start, end] = [end, start]; }
      const loop: SequenceLoop = { id: loopIds.take(raw.id, w, "l"), start, end, ...parseLoopBehaviour(raw, w, this.problems, "always") };
      out.loops.push(loop);
    });
    const markerIds = new IdScope(r);
    r.list(o.markers, `${where}.markers`).forEach((raw, i) => {
      const w = `${where}.markers[${i}]`;
      if (out.markers.length >= PLAYLIST_LIMITS.sequenceMarkers) return void r.problem(w, `at most ${PLAYLIST_LIMITS.sequenceMarkers} markers; dropped.`);
      if (!isRecord(raw)) return void r.problem(w, "a marker must be an object; dropped.");
      const marker: SequenceMarker = { id: markerIds.take(raw.id, w, "m"), name: r.str(raw.name, `${w}.name`, "Marker"), at: r.num(raw.at, `${w}.at`, 0, 0) };
      if (raw.type === "cue" || raw.type === "exit") marker.type = raw.type;
      else if (raw.type !== undefined && raw.type !== "note") r.problem(`${w}.type`, `"${String(raw.type)}" isn't note, cue or exit; using note.`);
      out.markers.push(marker);
    });
    return out;
  }

  clip(raw: unknown, where: string, depth: number, trackKind: Track["kind"], ids: IdScope): Clip | null {
    const r = this.r;
    if (!isRecord(raw)) { r.problem(where, "a clip must be an object; dropped."); return null; }
    const hasSample = raw.sample !== undefined, hasPlaylist = raw.playlist !== undefined;
    if (!hasSample && !hasPlaylist) { r.problem(where, 'a clip needs "sample" or "playlist"; dropped.'); return null; }
    let useSample = hasSample;
    if (hasSample && hasPlaylist) {
      useSample = trackKind === "audio";
      r.problem(where, `has both "sample" and "playlist"; using "${useSample ? "sample" : "playlist"}" (the track's kind).`);
    }
    let source: Pick<Clip, "sample" | "playlist">;
    if (useSample) {
      if (typeof raw.sample !== "string" || raw.sample === "") { r.problem(`${where}.sample`, "must be a sample path; dropped."); return null; }
      source = { sample: raw.sample };
    } else if (typeof raw.playlist === "string" && raw.playlist !== "") source = { playlist: raw.playlist };
    else if (isRecord(raw.playlist)) {
      const body = this.embedded(raw.playlist, `${where}.playlist`, depth);
      if (!body) return null;
      source = { playlist: body };
    } else { r.problem(`${where}.playlist`, "must be a playlist path or an embedded playlist; dropped."); return null; }
    const loops: Clip["loops"] = {};
    const overrides = r.record(raw.loops, `${where}.loops`);
    if (overrides) {
      for (const [id, v] of Object.entries(overrides)) {
        const o = parseLoopOverride(v, `${where}.loops.${id}`, this.problems);
        if (o) loops[id] = o;
      }
    }
    const hidden = [...new Set(r.list(raw.hiddenMarkers, `${where}.hiddenMarkers`).filter((m): m is string => {
      if (typeof m === "string" && m !== "") return true;
      r.problem(`${where}.hiddenMarkers`, "must list marker ids; dropped a value.");
      return false;
    }))];
    return {
      id: ids.take(raw.id, where, "c"),
      ...source,
      at: r.num(raw.at, `${where}.at`, 0, 0),
      length: r.num(raw.length, `${where}.length`, 1, 0),
      offset: r.num(raw.offset, `${where}.offset`, 0, 0),
      gain: r.num(raw.gain, `${where}.gain`, 0, -96, 24),
      pitch: r.num(raw.pitch, `${where}.pitch`, 0, -48, 48),
      pan: r.num(raw.pan, `${where}.pan`, 0, -1, 1),
      reverse: r.bool(raw.reverse, `${where}.reverse`, false),
      sync: r.bool(raw.sync, `${where}.sync`, false),
      enabled: r.bool(raw.enabled, `${where}.enabled`, true),
      loops,
      hiddenMarkers: hidden,
      effects: this.effects(raw.effects, `${where}.effects`, "voice"),
      automation: this.automation(raw.automation, `${where}.automation`, "clipTime"),
    };
  }
}

/**
 * A playlist body (an embedded playlist, or an asset without its `format` check) from JSON, leniently. `where` prefixes
 * problem lines.
 */
export function parsePlaylistBody(raw: unknown, where: string, problems: string[]): PlaylistBody {
  const reader = new PlaylistReader(problems);
  if (!isRecord(raw)) {
    reader.r.problem(where || "playlist", "a playlist must be an object; using an empty Queue.");
    return emptyPlaylistBody("queue");
  }
  return reader.body(raw, where, 0);
}

/**
 * A `*.playlist.json` value, leniently: never throws; a wrong or missing `format` is a problem but the rest is still
 * read. Problem lines start with `path` when given.
 */
export function parsePlaylist(raw: unknown, path?: string): PlaylistParse {
  const problems: string[] = [];
  if (isRecord(raw) && raw.format !== PLAYLIST_FORMAT) {
    problems.push(`format: expected "${PLAYLIST_FORMAT}"${raw.format === undefined ? "" : `, found ${JSON.stringify(raw.format)}`}; reading it anyway.`);
  }
  let body: PlaylistBody;
  if (!isRecord(raw)) {
    problems.push("a playlist must be a JSON object; using an empty Queue.");
    body = emptyPlaylistBody("queue");
  } else body = new PlaylistReader(problems).body(raw, "", 0);
  return { playlist: { format: PLAYLIST_FORMAT, ...body }, problems: path ? problems.map((p) => `${path}: ${p}`) : problems };
}

// --- write -----------------------------------------------------------------------------------------------------------

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function inputToJson(input: CurveInput): unknown {
  return typeof input === "string" ? input : { parameter: input.parameter };
}

function useToJson(e: EntryUse, out: JsonRecord): void {
  if (e.volume !== 0) out.volume = e.volume;
  if (e.pitch !== 0) out.pitch = e.pitch;
  if (e.weight !== 1) out.weight = e.weight;
  if (e.x !== undefined) out.x = e.x;
  if (e.y !== undefined) out.y = e.y;
  if (e.atZeroWeight !== "stop") out.atZeroWeight = e.atZeroWeight;
  const curves: JsonRecord = {};
  for (const t of VOICE_CURVE_TARGETS) {
    const c = e.curves[t];
    if (!c) continue;
    const json: JsonRecord = { input: inputToJson(c.input), curve: curveToJson(c.curve) };
    if (c.bypass) json.bypass = true;
    curves[t] = json;
  }
  if (Object.keys(curves).length) out.curves = curves;
}

/** An entry as JSON: its reference first, then the per-use fields that differ from their defaults. */
export function entryToJson(e: Entry): JsonRecord {
  const out: JsonRecord = {};
  if (e.kind === "sample") {
    out.sample = e.sample;
    if (e.trim) out.trim = [e.trim[0], e.trim[1]];
    if (e.loop !== "inherit") out.loop = e.loop;
  } else if (e.kind === "linked") out.playlist = e.playlist;
  else out.embedded = playlistBodyToJson(e.embedded);
  useToJson(e, out);
  return out;
}

function automationToJson(list: readonly Automation[]): JsonRecord[] {
  return list.map((a) => {
    const out: JsonRecord = { id: a.id, target: a.target, input: inputToJson(a.input), curve: curveToJson(a.curve) };
    if (a.bypass) out.bypass = true;
    return out;
  });
}

function changeToJson(c: ChangeHow): JsonRecord {
  const out: JsonRecord = { when: c.when, how: c.how, length: { ...c.length } };
  if (c.transition) out.transition = entryToJson(c.transition);
  return out;
}

function clipToJson(c: Clip): JsonRecord {
  const out: JsonRecord = { id: c.id };
  if (c.sample !== undefined) out.sample = c.sample;
  else if (typeof c.playlist === "string") out.playlist = c.playlist;
  else if (c.playlist) out.playlist = playlistBodyToJson(c.playlist);
  out.at = c.at;
  out.length = c.length;
  if (c.offset !== 0) out.offset = c.offset;
  if (c.gain !== 0) out.gain = c.gain;
  if (c.pitch !== 0) out.pitch = c.pitch;
  if (c.pan !== 0) out.pan = c.pan;
  if (c.reverse) out.reverse = true;
  if (c.sync) out.sync = true;
  if (!c.enabled) out.enabled = false;
  const loops = Object.entries(c.loops);
  if (loops.length) out.loops = Object.fromEntries(loops.map(([id, o]) => [id, loopOverrideToJson(o)]));
  if (c.hiddenMarkers.length) out.hiddenMarkers = [...c.hiddenMarkers];
  if (c.effects.length) out.effects = effectsToJson(c.effects);
  if (c.automation.length) out.automation = automationToJson(c.automation);
  return out;
}

function trackToJson(t: Track): JsonRecord {
  const out: JsonRecord = { id: t.id, name: t.name, kind: t.kind, color: t.color };
  if (t.volume !== 0) out.volume = t.volume;
  if (t.pan !== 0) out.pan = t.pan;
  if (t.output !== null) out.output = t.output;
  if (t.mute) out.mute = true;
  if (t.solo) out.solo = true;
  if (!t.enabled) out.enabled = false;
  if (t.effects.length) out.effects = effectsToJson(t.effects);
  if (t.automation.length) out.automation = automationToJson(t.automation);
  out.clips = t.clips.map(clipToJson);
  return out;
}

function sequenceToJson(s: SequenceSettings): JsonRecord {
  const out: JsonRecord = { length: s.length };
  if (s.tempo) out.tempo = { bpm: s.tempo.bpm, meter: s.tempo.meter };
  out.tracks = s.tracks.map(trackToJson);
  if (s.loops.length) out.loops = s.loops.map((l) => ({ id: l.id, start: l.start, end: l.end, ...loopBehaviourToJson(l) }));
  if (s.markers.length) out.markers = s.markers.map((m) => ({ id: m.id, name: m.name, at: m.at, ...(m.type && m.type !== "note" ? { type: m.type } : {}) }));
  return out;
}

function switchToJson(s: SwitchSettings): JsonRecord {
  const out: JsonRecord = { parameter: s.parameter, map: { ...s.map } };
  if (Object.keys(s.labelGain).length) out.labelGain = { ...s.labelGain };
  out.onChange = changeToJson(s.onChange);
  if (s.rules.length) out.rules = s.rules.map((r) => ({ from: r.from, to: r.to, ...changeToJson(r) }));
  return out;
}

function blendToJson(b: BlendSettings): JsonRecord {
  return {
    axes: b.axes.map((a) => ("parameter" in a ? { parameter: a.parameter } : { voiceTime: a.voiceTime })),
    fade: b.fade, curve: b.curve,
    follow: b.follow === "hold" ? "hold" : { glideMs: b.follow.glideMs },
    envelope: { mode: b.envelope.mode, low: { ...b.envelope.low }, high: { ...b.envelope.high } },
  };
}

function parameterToJson(p: ParameterDef): JsonRecord {
  return isLabelled(p) ? { name: p.name, labels: [...p.labels], default: p.default } : { name: p.name, min: p.min, max: p.max, default: p.default, seekSpeed: p.seekSpeed };
}

/** A playlist body as JSON (no `format`): stable key order, defaults left out. */
export function playlistBodyToJson(b: PlaylistBody): JsonRecord {
  const out: JsonRecord = { type: b.type };
  if (b.note !== undefined) out.note = b.note;
  if (b.output !== null) out.output = b.output;
  const pb: JsonRecord = {};
  const d = defaultPlayback();
  for (const k of Object.keys(d) as (keyof PlaybackRules)[]) if (b.playback[k] !== d[k]) pb[k] = b.playback[k];
  if (Object.keys(pb).length) out.playback = pb;
  if (b.volume !== 0) out.volume = b.volume;
  if (b.pitch !== 0) out.pitch = b.pitch;
  if (b.volumeRandom[0] !== 0 || b.volumeRandom[1] !== 0) out.volumeRandom = [...b.volumeRandom];
  if (b.pitchRandom[0] !== 0 || b.pitchRandom[1] !== 0) out.pitchRandom = [...b.pitchRandom];
  if (b.effects.length) out.effects = effectsToJson(b.effects);
  if (b.automation.length) out.automation = automationToJson(b.automation);
  if (b.spatial) {
    const s = b.spatial;
    out.spatial = { attenuation: typeof s.attenuation === "string" || s.attenuation === null ? s.attenuation : attenuationToJson(s.attenuation), occlusion: s.occlusion, doppler: s.doppler, spread: s.spread };
  }
  if (b.parameters.length) out.parameters = b.parameters.map(parameterToJson);
  if (b.stingers.length) {
    out.stingers = b.stingers.map((s) => ({ trigger: s.trigger, playlist: entryToJson(s.playlist), at: s.at, ifLate: s.ifLate, dontRepeat: s.dontRepeat }));
  }
  out.entries = b.entries.map(entryToJson);
  const own = ownBlock(b.type);
  const block = <K extends "queue" | "switch" | "blend" | "sequence">(key: K, write: (v: NonNullable<PlaylistBody[K]>) => JsonRecord) => {
    const v = b[key];
    if (v === null) return;
    const json = write(v as NonNullable<PlaylistBody[K]>);
    // The type's own block is left out when it is all defaults (the parse fills it back).
    if (key in own && sameJson(json, write(own[key] as NonNullable<PlaylistBody[K]>))) return;
    out[key] = json;
  };
  block("queue", (q) => ({ pick: q.pick, avoidRepeat: q.avoidRepeat, continuous: q.continuous ? { gapMs: q.continuous.gapMs } : null }));
  block("switch", switchToJson);
  block("blend", blendToJson);
  block("sequence", sequenceToJson);
  return out;
}

/** A playlist asset as JSON: `format` first, then the body. */
export const playlistToJson = (p: PlaylistBody): JsonRecord => ({ format: PLAYLIST_FORMAT, ...playlistBodyToJson(p) });

/** The asset's file text: two-space JSON and a final newline. */
export const formatPlaylist = (p: PlaylistBody): string => `${JSON.stringify(playlistToJson(p), null, 2)}\n`;
