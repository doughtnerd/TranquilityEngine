/**
 * The one-way migration `myco.audioevent@1` → `myco.playlist@1` (ADR 0329 §"Migration"; attenuation per ADR 0333).
 * Pure: it takes the existing parse output (`parseAudioEvent(...).value`) and returns the playlist, any extra assets it
 * chose to write beside it, and lint notes naming every approximation. It never throws.
 *
 * The migration has no audio files. Clip, loop and marker times that depend on a sample's length (a segment's `"end"`,
 * a sustain's sections, a start offset's trim) need `options.sampleSeconds`. Without it, clip and sequence lengths are
 * 0, which the playlist contract reads as "to the end" (D5), an exit at the end needs no marker, and a loop over a whole
 * segment replays the sequence through a continuous Queue; what still can't be placed is dropped with a note. Callers
 * that can read the audio (`migrateProjectAudio` in `project.ts`, so `npm run audio:migrate`) pass it.
 *
 * The mapping, in short (each choice is explained where it is made):
 * - `clip` → Clip (a looping region or sustain → a one-clip Sequence with a sequence loop); `random` → Queue random;
 *   step `sequence` → Queue round robin; continuous ones → Queue `continuous`; `switch` → Switch; `blend` → Blend 1D at
 *   range midpoints; `layer` → Layer; `sustain` → Sequence with a held loop.
 * - `segment` → Sequence (tempo from the first marker, stems as sync audio tracks, alternatives as a Queue on a
 *   playlist track, cues as markers, regions as loops); music `playlist` → continuous Queue; `musicSwitch` → Switch
 *   with its transition rules; stingers kept; library segments → embedded playlists.
 * - Event fields → `playback`, `volume`/`pitch` in dB/semitones, `output`, `spatial` (rolloff sampled into curves),
 *   `filter` → playlist low-/high-pass effects, automation → entry voice curves (or track automation in a Sequence).
 */
import type { Curve, CurveKey } from "../../core/curve";
import type { Attenuation } from "../attenuation/types";
import type { Effect } from "../effects/types";
import {
  eventRootNode, isLabelled, REVERB_SEND_KEY, type AnyEventNode, type AudioEventAsset, type Automation as EventAutomation,
  type BlendNode, type ClipNode, type EventSpatial, type LayerNode, type ParameterDef, type RandomNode, type SequenceNode,
  type SustainNode, type SwitchNode,
} from "../eventFormat";
import {
  segmentEntryPosition, segmentExitPosition, type MusicAutomation, type MusicNode, type MusicSwitchNode, type MusicTrack,
  type PlaylistNode, type RegionCondition, type SegmentNode, type TempoMarker,
} from "../musicFormat";
import { RULE_WILDCARD, type StingerAt, type StingerDef, type TransitionExit, type TransitionFade, type TransitionRule } from "../musicRules";
import { comparePositions, isBarBeatTick, MUSIC_TICKS_PER_BEAT, parsePosition, type BarBeatTick } from "../musicPosition";
import type { GridSpec } from "../musicTypes";
import {
  PLAYLIST_FORMAT, type Automation, type ChangeHow, type ChangeRule, type ChangeWhen, type Clip, type EmbeddedEntry, type Entry,
  type EntryUse, type PlaybackRules, type PlaylistAsset, type PlaylistBody, type PlaylistType, type SampleEntry,
  type SequenceLoop, type SequenceMarker, type SequenceSettings, type Stinger, type Track, type VoiceCurve,
  type VoiceCurveTarget,
} from "../playlist/types";
import { combineCurves, gainToDb, mapCurve, ratioToSemitones, SILENT_DB, tidy } from "./units";

/** What the migration may know beyond the event: the length of a sample, in seconds, by project path. */
export interface MigrateOptions {
  sampleSeconds?: (path: string) => number | undefined;
}

/** An extra asset the migration writes beside the playlist (none today: attenuation is written inline). */
export interface MigratedExtra {
  path: string;
  asset: unknown;
}

export interface MigratedAudioEvent {
  playlist: PlaylistAsset;
  extra: MigratedExtra[];
  /** Lint lines, each starting with the event's path and the place in its tree. */
  notes: string[];
}

// --- limits of the new format (ADR 0329 §"Playback"; types.ts) ------------------------------------------------------

const MAX_INSTANCES = 32;
const MAX_COOLDOWN = 5;
const MAX_DELAY = 2;
const MAX_AVOID = 5;
const MAX_WEIGHT = 100;
const MAX_KEYS = 64;
/** Keys a sampled rolloff law writes between min and max distance. */
const ROLLOFF_SAMPLES = 12;
/** The old event's default reverb send against normalised distance (`DEFAULT_SEND_CURVE`, ADR 0162 §1.1). */
const DEFAULT_SEND_CURVE: Curve = [[0, 1], [1, 0.5]];

const DEFAULT_PLAYBACK = (): PlaybackRules => ({
  plays: "oneShot", maxInstances: 0, whenFull: "stealOldest", cooldown: 0, chance: 1, delay: 0, priority: 128,
});

const newBody = (type: PlaylistType): PlaylistBody => ({
  type, output: null, playback: DEFAULT_PLAYBACK(), volume: 0, pitch: 0, volumeRandom: [0, 0], pitchRandom: [0, 0],
  effects: [], automation: [], spatial: null, parameters: [], stingers: [], entries: [], queue: null, switch: null, blend: null, sequence: null,
});

const newUse = (): EntryUse => ({ volume: 0, pitch: 0, weight: 1, atZeroWeight: "stop", curves: {} });

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const addPair = (a: [number, number], b: [number, number]): [number, number] => [tidy(a[0] + b[0]), tidy(a[1] + b[1])];

/** Where a migrated curve came from: the old target and how its unit converts. */
const CURVE_TARGETS: Record<EventAutomation["target"], { target: VoiceCurveTarget; map: (y: number) => number; resample: boolean }> = {
  volume: { target: "gain", map: gainToDb, resample: true },
  pitch: { target: "pitch", map: ratioToSemitones, resample: true },
  lowpass: { target: "lowpass", map: (y) => y, resample: false },
};

/** How two curves on one target combine down the tree (ADR 0329 "Down the tree"). */
const COMBINE: Record<VoiceCurveTarget, (a: number, b: number) => number> = {
  gain: (a, b) => a + b, pitch: (a, b) => a + b, pan: (a, b) => (b !== 0 ? b : a), lowpass: Math.min, highpass: Math.max,
};

/** An old curve binding, unit-converted, before it lands on an entry, a track or a clip. */
interface Binding { parameter: string; target: VoiceCurveTarget; curve: CurveKey[] }

class Migrator {
  readonly notes = new Set<string>();
  /** Local parameters by name (for label sets). */
  readonly params: Map<string, ParameterDef>;
  /** True once anything in the tree loops until stopped. */
  loopsForever = false;

  constructor(readonly path: string, readonly event: AudioEventAsset, readonly options: MigrateOptions) {
    this.params = new Map(event.parameters.map((p) => [p.name, p]));
  }

  note(where: string, message: string): void {
    this.notes.add(`${this.path} ${where}: ${message}`);
  }

  seconds(sample: string): number | undefined {
    const s = this.options.sampleSeconds?.(sample);
    return s !== undefined && Number.isFinite(s) && s >= 0 ? s : undefined;
  }

  // --- curves -------------------------------------------------------------------------------------------------------

  bindings(automation: readonly (EventAutomation | MusicAutomation)[], where: string): Binding[] {
    return automation.map((a, i) => {
      const t = CURVE_TARGETS[a.target];
      if ("quantize" in a && a.quantize) this.note(`${where}.automation[${i}]`, `quantize "${a.quantize}" is not kept; the curve follows the parameter continuously.`);
      return { parameter: a.parameter, target: t.target, curve: mapCurve(a.curve, t.map, t.resample, MAX_KEYS) };
    });
  }

  /** Put a curve on an entry's voice curves, combining with one already there on the same parameter. */
  addCurve(curves: EntryUse["curves"], b: Binding, where: string): void {
    const have = curves[b.target];
    const vc: VoiceCurve = { input: { parameter: b.parameter }, curve: b.curve, bypass: false };
    if (!have) { curves[b.target] = vc; return; }
    const hp = typeof have.input === "object" ? have.input.parameter : null;
    if (hp !== b.parameter) {
      this.note(where, `two ${b.target} curves on different inputs ("${hp ?? String(have.input)}", "${b.parameter}"); kept the first.`);
      return;
    }
    curves[b.target] = { ...have, curve: combineCurves(have.curve, b.curve, COMBINE[b.target], MAX_KEYS) };
    this.note(where, `two ${b.target} curves on "${b.parameter}" were combined into one (sampled at their keys).`);
  }

  /** Bindings as sequence automation (tracks and clips); low-pass becomes a low-pass effect with its cutoff automated. */
  automation(bindings: readonly Binding[], effects: Effect[], idPrefix: string): Automation[] {
    return bindings.map((b, i): Automation => {
      const base = { id: `${idPrefix}a${i + 1}`, input: { parameter: b.parameter }, curve: b.curve, bypass: false };
      if (b.target === "gain") return { ...base, target: "volume" };
      if (b.target === "pitch") return { ...base, target: "pitch" };
      const fx: Effect = { id: `${idPrefix}fx${effects.length + 1}`, type: b.target === "lowpass" ? "lowpass" : "highpass", on: true, params: {} };
      effects.push(fx);
      return { ...base, target: `fx:${fx.id}:cutoff` };
    });
  }

  /** Bindings that apply to a whole playlist: on every entry, or on every track of a Sequence. */
  distribute(body: PlaylistBody, bindings: readonly Binding[], where: string): void {
    if (bindings.length === 0) return;
    if (body.sequence) {
      for (const t of body.sequence.tracks) t.automation.push(...this.automation(bindings, t.effects, `${t.id}r`));
      if (body.sequence.tracks.length === 0) this.note(where, "automation on an empty sequence was dropped.");
      return;
    }
    if (body.entries.length === 0) { this.note(where, "automation on a playlist with no entries was dropped."); return; }
    body.entries.forEach((e, i) => { for (const b of bindings) this.addCurve(e.curves, b, `${where}.entries[${i}]`); });
  }

  // --- nodes --------------------------------------------------------------------------------------------------------

  /** A node as an entry of its parent: the node becomes an embedded playlist; its automation and weight are per use. */
  entry(node: AnyEventNode, where: string): EmbeddedEntry {
    const embedded = this.body(node, where);
    const use = newUse();
    for (const b of this.bindings(node.automation, where)) this.addCurve(use.curves, b, where);
    return { kind: "embedded", embedded, ...use };
  }

  /** A node as a playlist body, with its own volume, pitch, randomness and delay applied. */
  body(node: AnyEventNode, where: string): PlaylistBody {
    const body = this.typed(node, where);
    body.volume = tidy(body.volume + gainToDb(node.volume));
    body.pitch = tidy(body.pitch + ratioToSemitones(node.pitch));
    body.volumeRandom = addPair(body.volumeRandom, node.volumeRandom);
    body.pitchRandom = addPair(body.pitchRandom, node.pitchRandom);
    if (node.delay > 0) {
      if (node.delay > MAX_DELAY) this.note(where, `delay ${node.delay} s is above the playlist limit of ${MAX_DELAY} s; using ${MAX_DELAY} s.`);
      body.playback.delay = clamp(node.delay, 0, MAX_DELAY);
    }
    return body;
  }

  typed(node: AnyEventNode, where: string): PlaylistBody {
    switch (node.type) {
      case "clip": return this.clip(node, where);
      case "random": return this.random(node, where);
      case "sequence": return this.stepSequence(node, where);
      case "switch": return this.switchNode(node, where);
      case "blend": return this.blend(node, where);
      case "layer": return this.layer(node, where);
      case "sustain": return this.sustain(node, where);
      case "segment": return this.segment(node, where);
      case "playlist": return this.musicPlaylist(node, where);
      case "musicSwitch": return this.musicSwitch(node, where);
    }
  }

  sampleEntry(sample: string): SampleEntry {
    return { kind: "sample", sample, trim: null, loop: "inherit", ...newUse() };
  }

  /**
   * A clip. A plain or whole-file looping clip is a Clip playlist (loop → sample loop `on`, else `off`); a clip with a
   * loop region, or a sustain clip, is a one-clip Sequence whose sequence loop is the region: `always` for `loop`,
   * `held` for `sustain` (release finishes the pass, then the rest of the clip plays).
   */
  clip(n: ClipNode, where: string): PlaylistBody {
    const length = this.seconds(n.clip);
    if (!n.sustain && !(n.loop && n.loopRegion)) {
      const body = newBody("clip");
      const e = this.sampleEntry(n.clip);
      e.loop = n.loop ? "on" : "off";
      if (n.loop) {
        this.loopsForever = true;
        this.note(where, `"${n.clip}" loops the whole clip ("on"); if the sample has its own loop points, set its loop to "inherit".`);
      }
      if (n.startOffset > 0) {
        if (length !== undefined && length > n.startOffset) e.trim = [tidy(n.startOffset), tidy(length)];
        else this.note(where, `startOffset ${n.startOffset} s needs the sample's length to become a trim; dropped.`);
      }
      body.entries.push(e);
      return body;
    }
    const offset = n.startOffset;
    // An unknown length is 0: the clip and the sequence play to the sample's end (D5).
    const clipLength = length !== undefined ? Math.max(0, length - offset) : 0;
    const region = n.loopRegion ?? (length !== undefined ? [0, length] as [number, number] : undefined);
    const seq = this.newSequence(clipLength);
    const track = this.newTrack(seq, "audio", "Audio 1");
    track.clips.push(this.newClip(track, { sample: n.clip }, 0, clipLength, offset));
    if (!region) this.note(where, `"${n.clip}": length unknown; a sustain with no loop region needs it to place the held loop, so the loop was dropped.`);
    else {
      const start = tidy(Math.max(0, region[0] - offset)), end = tidy(region[1] - offset);
      if (end <= start) this.note(where, `the loop region ends before the start offset; the loop was dropped.`);
      else {
        seq.loops.push(this.loop(seq, start, end, n.sustain ? "held" : "always", "finish", 0));
        if (!n.sustain) this.loopsForever = true;
      }
    }
    return this.sequenceBody(seq);
  }

  /** Weights in the playlist range 0..100: kept when they fit as integers, else scaled so the largest is 100. */
  weights(entries: Entry[], weights: number[], where: string): void {
    const fits = weights.every((w) => Number.isInteger(w) && w <= MAX_WEIGHT);
    const max = Math.max(0, ...weights);
    entries.forEach((e, i) => {
      const w = weights[i];
      e.weight = fits || max === 0 ? w : w === 0 ? 0 : Math.max(1, Math.round((w / max) * MAX_WEIGHT));
    });
    if (!fits && max > 0) this.note(where, `weights were scaled to 0..${MAX_WEIGHT} (largest = ${MAX_WEIGHT}).`);
  }

  avoid(n: number, where: string): number {
    if (n > MAX_AVOID) this.note(where, `avoidRepeat ${n} is above ${MAX_AVOID}; using ${MAX_AVOID}.`);
    return clamp(Math.round(n), 0, MAX_AVOID);
  }

  /** A continuous container's gap: seconds to `gapMs`. A negative gap (an overlap) is kept as a negative `gapMs`. */
  continuous(gap: number, where: string): { gapMs: number } {
    this.loopsForever = true;
    if (gap < 0) this.note(where, `gap ${gap} s overlaps picks with a crossfade; written as gapMs ${tidy(gap * 1000)} (check the playlist runtime overlaps them).`);
    return { gapMs: tidy(gap * 1000) };
  }

  random(n: RandomNode, where: string): PlaylistBody {
    const body = newBody("queue");
    body.entries = n.children.map((c, i) => this.entry(c, `${where}.children[${i}]`));
    this.weights(body.entries, n.children.map((c) => c.weight), where);
    body.queue = { pick: "random", avoidRepeat: this.avoid(n.avoidRepeat, where), continuous: n.mode === "continuous" ? this.continuous(n.gap, where) : null };
    return body;
  }

  stepSequence(n: SequenceNode, where: string): PlaylistBody {
    const body = newBody("queue");
    body.entries = n.children.map((c, i) => this.entry(c, `${where}.children[${i}]`));
    body.queue = { pick: "roundRobin", avoidRepeat: 0, continuous: n.mode === "continuous" ? this.continuous(n.gap, where) : null };
    if (n.mode === "step" && n.reset > 0) this.note(where, `reset after ${n.reset} s idle is not kept; round robin always continues where it was.`);
    if (n.mode === "continuous" && !n.loop) this.note(where, "a continuous sequence that stopped after its last child now plays until stopped (or use a Sequence timeline).");
    return body;
  }

  /** The labels a switch on `parameter` can see: the local parameter's labels, then any child value not among them. */
  labels(parameter: string, values: (string | undefined)[], where: string): string[] {
    const p = this.params.get(parameter);
    const out = p && isLabelled(p) ? [...p.labels] : [];
    if (!p) this.note(where, `"${parameter}" is not a local parameter; the map lists only the children's values (other labels play nothing, where the old switch played its default).`);
    for (const v of values) if (v !== undefined && !out.includes(v)) out.push(v);
    return out;
  }

  /** label → entry index: the child whose value matches, else the default child (the old fallback). */
  switchMap(labels: string[], values: (string | undefined)[], defaultLabel: string | undefined, where: string): Record<string, number | null> {
    let fallback = defaultLabel !== undefined ? values.indexOf(defaultLabel) : 0;
    if (fallback < 0) {
      this.note(where, `default "${defaultLabel}" matches no child; using the first.`);
      fallback = 0;
    }
    const map: Record<string, number | null> = {};
    for (const l of labels) {
      const i = values.indexOf(l);
      map[l] = values.length === 0 ? null : i >= 0 ? i : fallback;
    }
    return map;
  }

  switchNode(n: SwitchNode, where: string): PlaylistBody {
    const body = newBody("switch");
    body.entries = n.children.map((c, i) => this.entry(c, `${where}.children[${i}]`));
    const values = n.children.map((c) => c.value);
    const onChange: ChangeHow = n.onChange === "keep" ? { when: "nextTrigger", how: "cut", length: { ms: 0 } }
      : n.onChange === "restart" ? { when: "now", how: "cut", length: { ms: 0 } }
      : { when: "now", how: "crossfade", length: { ms: tidy(n.crossfade * 1000) } };
    body.switch = {
      parameter: n.parameter, map: this.switchMap(this.labels(n.parameter, values, where), values, n.default, where),
      labelGain: {}, onChange, rules: [],
    };
    return body;
  }

  /**
   * A blend: Blend 1D on the parameter, each child at its range's midpoint, neighbours crossfading linearly. The old
   * per-child plateau (`range`) and fade width can't be kept; a note says where they differ from the new crossfade.
   */
  blend(n: BlendNode, where: string): PlaylistBody {
    const body = newBody("blend");
    body.entries = n.children.map((c, i) => {
      const e = this.entry(c, `${where}.children[${i}]`);
      e.atZeroWeight = "continue";
      return e;
    });
    const xs = n.children.map((c, i) => (c.range ? tidy((c.range[0] + c.range[1]) / 2) : i));
    body.entries.forEach((e, i) => { e.x = xs[i]; });
    n.children.forEach((c, i) => {
      if (!c.range) this.note(`${where}.children[${i}]`, `no range; placed at x = ${i}.`);
    });
    // Old: full level across `range`, fading over `fade` beyond each end. New: full only at x, linear to the neighbours.
    const order = n.children.map((c, i) => ({ c, x: xs[i] })).filter((o) => o.c.range).sort((a, b) => a.x - b.x);
    const eps = 1e-9;
    const differs = order.some(({ c, x }, k) => {
      const prev = order[k - 1], next = order[k + 1];
      return c.range![1] > c.range![0] || (prev && Math.abs(x - prev.x - c.fade) > eps) || (next && Math.abs(next.x - x - c.fade) > eps);
    });
    const overlap = order.some(({ c }, k) => {
      const next = order[k + 1];
      // A fade that reaches into the neighbour's plateau (old: both play at full there; new: they crossfade).
      return next !== undefined && (c.range![1] + c.fade > next.c.range![0] + eps || next.c.range![0] - next.c.fade < c.range![1] - eps);
    });
    if (overlap) this.note(where, "children's fades overlapped; the blend now crossfades between neighbours at their range midpoints.");
    else if (differs) this.note(where, "children's plateaus and fade widths became points at their range midpoints with linear crossfades between neighbours.");
    body.blend = {
      axes: [{ parameter: n.parameter }], fade: "crossfade", curve: "linear", follow: { glideMs: 0 },
      envelope: { mode: "off", low: { attackMs: 0, decayMs: 0, sustain: 1, releaseMs: 0 }, high: { attackMs: 0, decayMs: 0, sustain: 1, releaseMs: 0 } },
    };
    return body;
  }

  layer(n: LayerNode, where: string): PlaylistBody {
    const body = newBody("layer");
    body.entries = n.children.map((c, i) => this.entry(c, `${where}.children[${i}]`));
    return body;
  }

  /** The length of one pass of a node, in seconds, when the samples' lengths are known. */
  estimate(node: AnyEventNode): number | undefined {
    const known = (xs: (number | undefined)[]): number | undefined => {
      const ks = xs.filter((x): x is number => x !== undefined);
      return ks.length === 0 ? undefined : Math.max(...ks);
    };
    switch (node.type) {
      case "clip": {
        const l = this.seconds(node.clip);
        return l === undefined ? undefined : Math.max(0, l - node.startOffset) / node.pitch + node.delay;
      }
      case "layer": case "random": case "sequence": case "switch": case "blend":
        return known(node.children.map((c) => this.estimate(c)));
      case "sustain": {
        const parts = [node.start, node.loop, node.end].filter((p) => p !== undefined).map((p) => this.estimate(p));
        return parts.some((p) => p === undefined) ? undefined : parts.reduce<number>((s, p) => s + p!, 0);
      }
      default: return undefined;
    }
  }

  /**
   * A sustain: a Sequence with one playlist track holding start, loop and end in a row, and a held sequence loop over
   * the loop section. Release `now` leaves the loop by crossfading over the release fade (jump when 0); `loopEnd`
   * finishes the pass. A clip as the loop section goes on an audio track so the held loop is exactly its loop region.
   */
  sustain(n: SustainNode, where: string): PlaylistBody {
    // The end section is last: an unknown length there is 0, "to the end" (D5), and so is the sequence's. Start and loop
    // place what follows them, so their lengths matter and an unknown one is noted.
    const endKnown = !n.end || this.estimate(n.end) !== undefined;
    const len = (node: AnyEventNode | undefined, slot: string): number => {
      if (!node) return 0;
      const l = this.estimate(node);
      if (l === undefined && slot !== "end") this.note(`${where}.${slot}`, "length unknown; its sequence clip is 0 s long (set it from the samples).");
      return l === undefined ? 0 : tidy(l);
    };
    const ls = len(n.start, "start"), ll = len(n.loop, "loop"), le = len(n.end, "end");
    const seq = this.newSequence(endKnown ? tidy(ls + ll + le) : 0);
    const track = this.newTrack(seq, "playlist", "Sustain");
    const addNode = (node: AnyEventNode | undefined, at: number, length: number, slot: string): void => {
      if (node) track.clips.push(this.nodeClip(track, node, at, length, `${where}.${slot}`));
    };
    addNode(n.start, 0, ls, "start");
    const fade = n.releaseFade ?? n.fade;
    const exit = n.release === "loopEnd" ? "finish" : fade > 0 ? "crossfade" : "jump";
    const loopClip = n.loop.type === "clip" && n.loop.delay === 0 && n.loop.automation.length === 0 ? n.loop : null;
    let start = ls, end = ls + ll;
    if (loopClip) {
      const audio = this.newTrack(seq, "audio", "Loop");
      const c = this.newClip(audio, { sample: loopClip.clip }, ls, ll, loopClip.startOffset);
      c.gain = gainToDb(loopClip.volume);
      c.pitch = ratioToSemitones(loopClip.pitch);
      audio.clips.push(c);
      if (loopClip.volumeRandom.some((v) => v !== 0) || loopClip.pitchRandom.some((v) => v !== 0)) this.note(`${where}.loop`, "the loop clip's volume and pitch randomness are not kept (sequence clips have none).");
      if (loopClip.loopRegion) { start = ls + loopClip.loopRegion[0] - loopClip.startOffset; end = ls + loopClip.loopRegion[1] - loopClip.startOffset; }
    } else {
      addNode(n.loop, ls, ll, "loop");
      this.note(`${where}.loop`, `the loop section is a ${n.loop.type}: the held loop re-enters its playlist clip on every pass.`);
    }
    addNode(n.end, ls + ll, le, "end");
    if (end > start) seq.loops.push(this.loop(seq, tidy(start), tidy(end), "held", exit, tidy(exit === "crossfade" ? fade * 1000 : 0)));
    else this.note(where, "the loop section's length is unknown; the held loop was dropped.");
    if (seq.tracks[0].clips.length === 0) seq.tracks.shift();
    return this.sequenceBody(seq);
  }

  // --- sequences ----------------------------------------------------------------------------------------------------

  newSequence(length: number): SequenceSettings {
    return { length, tempo: null, tracks: [], loops: [], markers: [] };
  }

  sequenceBody(seq: SequenceSettings): PlaylistBody {
    const body = newBody("sequence");
    body.sequence = seq;
    return body;
  }

  newTrack(seq: SequenceSettings, kind: Track["kind"], name: string): Track {
    const t: Track = {
      id: `t${seq.tracks.length + 1}`, name, kind, color: (seq.tracks.length % 8) + 1, volume: 0, pan: 0, output: null,
      mute: false, solo: false, enabled: true, effects: [], automation: [], clips: [],
    };
    seq.tracks.push(t);
    return t;
  }

  newClip(track: Track, source: { sample: string } | { playlist: string | PlaylistBody }, at: number, length: number, offset = 0): Clip {
    return {
      id: `${track.id}c${track.clips.length + 1}`, ...source, at: tidy(at), length: tidy(length), offset: tidy(offset), gain: 0, pitch: 0, pan: 0,
      reverse: false, sync: false, enabled: true, loops: {}, hiddenMarkers: [], effects: [], automation: [],
    };
  }

  /** A node as a playlist clip; its automation becomes the clip's automation. */
  nodeClip(track: Track, node: AnyEventNode, at: number, length: number, where: string): Clip {
    const c = this.newClip(track, { playlist: this.body(node, where) }, at, length);
    c.automation = this.automation(this.bindings(node.automation, where), c.effects, c.id);
    return c;
  }

  loop(seq: SequenceSettings, start: number, end: number, active: SequenceLoop["active"], exit: SequenceLoop["exit"], exitFadeMs: number, id?: string): SequenceLoop {
    return { id: id ?? `l${seq.loops.length + 1}`, start, end, active, exit, exitFadeMs, reentry: "ignore" };
  }

  // --- music --------------------------------------------------------------------------------------------------------

  /** Seconds of a `bar:beat:tick` in the files under the whole tempo map (`gridOffset` is where 1:1:0 sits). */
  positionSeconds(p: BarBeatTick, tempo: readonly TempoMarker[], gridOffset: number): number {
    const markers = tempo.map((t) => ({ t, at: parsePosition(t.at) })).filter((m): m is { t: TempoMarker; at: BarBeatTick } => m.at !== null && isBarBeatTick(m.at));
    if (markers.length === 0) markers.push({ t: { at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }, at: { bar: 1, beat: 1, tick: 0 } });
    let sec = gridOffset, bar = 1, beat = 1, mi = 0;
    for (let guard = 0; guard < 4_000_000; guard++) {
      while (mi + 1 < markers.length && comparePositions(markers[mi + 1].at, { bar, beat, tick: 0 }) <= 0) mi++;
      const m = markers[mi].t, spb = 60 / m.bpm;
      if (bar > p.bar || (bar === p.bar && beat >= p.beat)) return sec + (p.tick / MUSIC_TICKS_PER_BEAT) * spb;
      const next = markers[mi + 1]?.at;
      if (beat === 1 && p.bar > bar && (!next || next.bar > bar)) { sec += m.beatsPerBar * spb; bar++; continue; }
      sec += spb;
      if (++beat > m.beatsPerBar) { beat = 1; bar++; }
    }
    return sec;
  }

  /** A position text in seconds; `"end"` is the segment's length (undefined when unknown). */
  at(text: string, seg: SegmentNode, length: number | undefined): number | undefined {
    if (text === "start") return 0;
    if (text === "end") return length;
    const p = parsePosition(text);
    return p && isBarBeatTick(p) ? tidy(this.positionSeconds(p, seg.tempo, seg.gridOffset)) : undefined;
  }

  /** The `op`/`value` binding of a region condition (labelled values are label indices). */
  binding(c: RegionCondition, where: string): SequenceLoop["binding"] {
    if ("atLeast" in c) return { parameter: c.parameter, op: ">", value: c.atLeast };
    if ("below" in c) return { parameter: c.parameter, op: "<", value: c.below };
    const p = this.params.get(c.parameter);
    const labels = p && isLabelled(p) ? p.labels : [];
    const k = labels.indexOf(c.is);
    if (k < 0) {
      this.note(where, `"${c.parameter}" is "${c.is}" can't be resolved to a label index; bound as "> -0.5" (always), check it.`);
      return { parameter: c.parameter, op: ">", value: -0.5 };
    }
    if (k === 0) return { parameter: c.parameter, op: "<", value: 0.5 };
    if (k !== labels.length - 1) this.note(where, `"${c.parameter}" is "${c.is}" became "> ${k - 0.5}": it is also active for the labels after "${c.is}".`);
    return { parameter: c.parameter, op: ">", value: k - 0.5 };
  }

  /** A stem as a sync track: one audio clip, or a Queue of its alternatives on a playlist track. */
  stem(seq: SequenceSettings, t: MusicTrack, length: number, where: string): void {
    const alternatives = [t.clip, ...t.alternatives].filter((c) => c !== "");
    const track = this.newTrack(seq, alternatives.length > 1 ? "playlist" : "audio", t.name);
    track.volume = gainToDb(t.volume);
    track.output = t.bus === "" ? null : t.bus;
    track.automation = this.automation(this.bindings(t.automation, where), track.effects, track.id);
    if (alternatives.length === 0) { this.note(where, "a stem with no clip was dropped."); seq.tracks.pop(); return; }
    let clip: Clip;
    if (alternatives.length === 1) clip = this.newClip(track, { sample: alternatives[0] }, 0, length);
    else {
      const q = newBody("queue");
      q.entries = alternatives.map((s) => this.clipEntry(s));
      q.queue = { pick: t.pick === "random" ? "random" : "roundRobin", avoidRepeat: 0, continuous: null };
      clip = this.newClip(track, { playlist: q }, 0, length);
      this.note(where, "alternatives became a Queue on a playlist clip, picked when the playhead enters it (the old pick was per pass of a loop).");
    }
    clip.sync = true;
    track.clips.push(clip);
  }

  /** A sample wrapped in an embedded Clip playlist (the prototype's rule for samples outside a Clip). */
  clipEntry(sample: string): EmbeddedEntry {
    const body = newBody("clip");
    const e = this.sampleEntry(sample);
    body.entries.push(e);
    return { kind: "embedded", embedded: body, ...newUse() };
  }

  /**
   * A segment: a Sequence at its first tempo marker, stems as sync tracks spanning the segment, cues as markers (the
   * exit cue, or `"end"`, as a marker named `exit`), regions as sequence loops (bound to the parameter when `while`).
   *
   * Without the stems' length the sequence and its clips are 0 s long, "to the end" (D5), and two things that sit at
   * `"end"` survive another way: an exit at the end needs no marker (an Exit wait with no Exit marker falls back to the
   * loop end, which for a sequence that plays through is its end, ADR 0329), and a region over the whole segment that
   * isn't bound to a parameter becomes a continuous Queue replaying the sequence back to back.
   */
  segment(seg: SegmentNode, where: string): PlaylistBody {
    const lengths = seg.tracks.flatMap((t) => [t.clip, ...t.alternatives]).map((c) => (c ? this.seconds(c) : undefined));
    const knownLengths = lengths.filter((l): l is number => l !== undefined);
    const length = knownLengths.length > 0 ? tidy(Math.max(...knownLengths)) : undefined;
    if (length === undefined && seg.tracks.length > 0) this.note(where, `segment "${seg.id}": the stems' length is unknown; clips and the sequence play to their end (length 0), and loops and markers at "end" are placed without it where they can be.`);
    const seq = this.newSequence(length ?? 0);
    const first = seg.tempo[0];
    seq.tempo = first ? { bpm: first.bpm, meter: `${first.beatsPerBar}/${first.beatUnit}` } : null;
    if (seg.tempo.length > 1) this.note(where, `segment "${seg.id}" has ${seg.tempo.length} tempo markers; the sequence keeps ${first.bpm} bpm (positions use the whole map).`);
    seg.tracks.forEach((t, i) => this.stem(seq, t, length ?? 0, `${where}.tracks[${i}]`));
    // Markers: every cue by name; the exit point (named cue or the end) as `exit` when no cue has that name.
    const markers: SequenceMarker[] = [];
    // ADR 0329: the entry and exit points are Exit markers, other cues Cue markers.
    const exitNames = new Set([seg.entry ?? "entry", seg.exit ?? "exit"]);
    const addMarker = (name: string, text: string, w: string): void => {
      const s = this.at(text, seg, length);
      const type = exitNames.has(name) ? "exit" : "cue";
      if (s === undefined && text === "end" && type === "exit") return void this.note(w, `the exit at "end" needs no marker without the segment's length: an exit wait falls back to the sequence's end.`);
      if (s === undefined) { this.note(w, `marker "${name}" at "${text}" needs the segment's length; dropped.`); return; }
      markers.push({ id: `m${markers.length + 1}`, name, at: s, type });
    };
    seg.cues.forEach((c, i) => addMarker(c.name, c.at, `${where}.cues[${i}]`));
    if (!seg.cues.some((c) => c.name === (seg.exit ?? "exit"))) addMarker("exit", segmentExitPosition(seg), `${where}.exit`);
    seq.markers = markers;
    const entry = segmentEntryPosition(seg);
    if (entry !== "1:1:0" && entry !== "start") this.note(where, `segment "${seg.id}" enters at "${entry}"; the sequence plays from its start (the marker "${seg.entry ?? "entry"}" is kept).`);
    if (seg.gridOffset > 0) this.note(where, `segment "${seg.id}": gridOffset ${seg.gridOffset} s is folded into the marker and loop times; the sequence's beat grid starts at 0.`);
    let wholeLoop = false;
    seg.regions.forEach((r, i) => {
      const w = `${where}.regions[${i}]`;
      const start = this.at(r.from, seg, length), end = this.at(r.to, seg, length);
      if (length === undefined && start === 0 && r.to === "end" && !r.while) {
        wholeLoop = true;
        this.loopsForever = true;
        this.note(w, `region "${r.id}" loops the whole segment, whose length is unknown: the sequence plays back to back in a continuous Queue instead of a sequence loop.`);
        if (r.count > 0) this.note(w, `region "${r.id}" played ${r.count} passes; it now repeats until the instance is stopped.`);
        return;
      }
      if (start === undefined || end === undefined || end <= start) { this.note(w, `region "${r.id}" can't be placed (its end needs the segment's length or is not after its start); dropped.`); return; }
      const loop = this.loop(seq, start, end, r.while ? "parameter" : "always", "finish", 0, r.id);
      if (r.while) loop.binding = this.binding(r.while, w);
      else if (r.count === 0) this.loopsForever = true;
      if (r.count > 0) this.note(w, `region "${r.id}" played ${r.count} passes; the loop now repeats ${r.while ? "while its binding holds" : "until the instance is stopped"}.`);
      if (r.tailBeats) this.note(w, `region "${r.id}": tailBeats ${r.tailBeats} (the ringing past the loop end) is not kept.`);
      seq.loops.push(loop);
    });
    if (!wholeLoop) return this.sequenceBody(seq);
    const queue = newBody("queue");
    queue.entries = [{ kind: "embedded", embedded: this.sequenceBody(seq), ...newUse() }];
    queue.queue = { pick: "roundRobin", avoidRepeat: 0, continuous: this.continuous(0, where) };
    return queue;
  }

  /** Music children as queue or switch entries. */
  musicEntries(children: MusicNode[], where: string): EmbeddedEntry[] {
    return children.map((c, i) => this.entry(c, `${where}.children[${i}]`));
  }

  /** The stingers and library of a music container (library segments become embedded playlists in each stinger). */
  stingers(node: PlaylistNode | MusicSwitchNode, where: string): Stinger[] {
    const library = new Map(node.library.map((s) => [s.id, s]));
    return node.stingers.flatMap((s: StingerDef, i): Stinger[] => {
      const w = `${where}.stingers[${i}]`;
      const seg = library.get(s.segment);
      if (!seg) { this.note(w, `stinger "${s.trigger}" names no library segment "${s.segment}"; dropped.`); return []; }
      const playlist = this.entry(seg, `${where}.library.${seg.id}`);
      if (s.volume !== undefined) playlist.volume = gainToDb(s.volume);
      if (s.bus !== undefined) playlist.embedded.output = s.bus;
      return [{ trigger: s.trigger, playlist, at: this.stingerAt(s.at, w), ifLate: s.ifTooLate, dontRepeat: s.dontRepeat }];
    });
  }

  grid(g: GridSpec, where: string): "beat" | "bar" {
    if (typeof g === "string") return g;
    this.note(where, `"every ${g.n} ${g.every}s" became "${g.every}".`);
    return g.every;
  }

  stingerAt(at: StingerAt, where: string): Stinger["at"] {
    if (at === "immediate") return "now";
    if (typeof at === "object" && "cue" in at) {
      this.note(where, `"at the cue ${at.cue}" became "exit" (the next Exit marker).`);
      return "exit";
    }
    return this.grid(at, where);
  }

  /**
   * A music playlist: a continuous Queue (sequence → round robin, random, shuffle). Children with `plays` > 1 are
   * repeated in a round-robin queue; `rounds` and transitions between children are not kept.
   */
  musicPlaylist(n: PlaylistNode, where: string): PlaylistBody {
    const body = newBody("queue");
    const entries = this.musicEntries(n.children, where);
    body.entries = n.mode === "sequence" ? entries.flatMap((e, i) => Array.from({ length: n.children[i].plays }, (_, k) => (k === 0 ? e : structuredClone(e)))) : entries;
    if (n.mode !== "sequence" && n.children.some((c) => c.plays > 1)) this.note(where, "children's plays counts are not kept in a random or shuffled queue.");
    if (n.mode === "random") this.weights(body.entries, n.children.map((c) => c.weight), where);
    body.queue = {
      pick: n.mode === "sequence" ? "roundRobin" : n.mode, avoidRepeat: n.mode === "random" ? this.avoid(n.avoidRepeat, where) : 0,
      continuous: this.continuous(0, where),
    };
    if (n.rounds !== 0) this.note(where, `rounds ${n.rounds}: the queue now plays until stopped.`);
    if (n.transitions.length > 0) this.note(where, "transition rules between playlist children are not kept (a queue plays back to back).");
    body.stingers = this.stingers(n, where);
    return body;
  }

  /** A transition fade's length. */
  fadeLength(f: TransitionFade): ChangeHow["length"] {
    return f.unit === "beats" ? { beats: f.amount } : { ms: tidy(f.amount * 1000) };
  }

  /** One transition rule's when/how/length/transition. */
  changeHow(rule: TransitionRule, library: Map<string, SegmentNode>, where: string): ChangeHow {
    const when: ChangeWhen = this.exitWhen(rule.exit, where);
    const out = rule.fadeOut, inn = rule.fadeIn;
    const longer = out.unit === inn.unit ? (out.amount >= inn.amount ? out : inn) : out;
    if (out.unit !== inn.unit || out.amount !== inn.amount) this.note(where, `fade out and fade in differ; the crossfade length is the ${longer === out ? "fade out" : "fade in"}'s.`);
    if (out.offset !== 0 || inn.offset !== 0) this.note(where, "fade offsets are not kept.");
    if (out.curve !== "equalPower" || inn.curve !== "equalPower") this.note(where, `fade curves (${out.curve}/${inn.curve}) are not kept; the crossfade is the runtime's.`);
    if (rule.enter !== "entryCue") this.note(where, `enter ${typeof rule.enter === "string" ? `"${rule.enter}"` : `at cue "${rule.enter.cue}"`} is not kept; the new entry starts from its start.`);
    const how: ChangeHow = { when, how: longer.amount > 0 ? "crossfade" : "cut", length: this.fadeLength(longer) };
    if (rule.bridge) {
      const seg = library.get(rule.bridge.segment);
      if (!seg) this.note(where, `bridge "${rule.bridge.segment}" names no library segment; dropped.`);
      else {
        how.how = "transition";
        how.transition = this.entry(seg, `${where}.bridge`);
        if (rule.bridge.fadeIn || rule.bridge.fadeOut) this.note(where, "the bridge's own fades are not kept; the rule's length is the crossfade.");
      }
    }
    return how;
  }

  exitWhen(exit: TransitionExit, where: string): ChangeWhen {
    if (exit === "immediate") return "now";
    if (exit === "exitCue") return "exit";
    if (exit === "nextCue") { this.note(where, `exit "nextCue" became "exit" (the next Exit marker).`); return "exit"; }
    return this.grid(exit, where);
  }

  /**
   * A musicSwitch: a Switch on its parameter, child values as labels (the default child for labels without one), its
   * transition rules as change rules on labels (`*` → `*` becomes `onChange`; with none, the old default rule: next bar,
   * 1 beat crossfade).
   */
  musicSwitch(n: MusicSwitchNode, where: string): PlaylistBody {
    const body = newBody("switch");
    body.entries = this.musicEntries(n.children, where);
    const values = n.children.map((c) => c.value ?? c.id);
    n.children.forEach((c, i) => { if (c.value === undefined) this.note(`${where}.children[${i}]`, `no value; its id "${c.id}" is used as its label.`); });
    const labels = this.labels(n.parameter, values, where);
    const map = this.switchMap(labels, values, n.default, where);
    const library = new Map(n.library.map((s) => [s.id, s]));
    const labelsOf = (id: string): string[] => {
      if (id === RULE_WILDCARD) return [RULE_WILDCARD];
      const index = n.children.findIndex((c) => c.id === id);
      return index < 0 ? [] : labels.filter((l) => map[l] === index);
    };
    let onChange: ChangeHow = { when: "bar", how: "crossfade", length: { beats: 1 } };
    const rules: ChangeRule[] = [];
    n.transitions.forEach((r, i) => {
      const w = `${where}.transitions[${i}]`;
      const how = this.changeHow(r, library, w);
      if (r.from === RULE_WILDCARD && r.to === RULE_WILDCARD) { onChange = how; return; }
      const froms = labelsOf(r.from), tos = labelsOf(r.to);
      if (froms.length === 0 || tos.length === 0) { this.note(w, `rule ${r.from} → ${r.to} names no child; dropped.`); return; }
      if (froms.length * tos.length > 1) this.note(w, `rule ${r.from} → ${r.to} became one rule per label pair.`);
      for (const from of froms) for (const to of tos) rules.push({ from, to, ...structuredClone(how) });
    });
    body.switch = { parameter: n.parameter, map, labelGain: {}, onChange, rules };
    body.stingers = this.stingers(n, where);
    return body;
  }

  // --- the event ----------------------------------------------------------------------------------------------------

  attenuation(sp: EventSpatial, reverbDb: number): Attenuation {
    const min = sp.minDistance, max = sp.maxDistance;
    const volume: CurveKey[] = [[0, 0]];
    if (min > 0) volume.push([tidy(min), 0]);
    if (max > min) {
      const law = sp.rolloff === "linear"
        ? (d: number) => 1 - (d - min) / (max - min)
        : (d: number) => (min > 0 ? min / d : 0);
      for (let k = 1; k <= ROLLOFF_SAMPLES; k++) {
        const u = k / ROLLOFF_SAMPLES;
        // Linear laws sample evenly; inverse laws geometrically (they change fastest near min).
        const d = sp.rolloff === "linear" || min <= 0 ? min + (max - min) * u : min * Math.pow(max / min, u);
        volume.push([tidy(d), gainToDb(law(d))]);
      }
    }
    if (sp.rolloff !== "linear") this.note("spatial", `rolloff "${sp.rolloff}" sampled into volume keys up to maxDistance; beyond it the level now holds (the old law kept falling).`);
    if (min <= 0) this.note("spatial", "minDistance 0 made the old inverse laws silent; check the volume curve.");
    const span = max > min ? max - min : 0;
    const send = sp.reverbSendCurve ?? DEFAULT_SEND_CURVE;
    const reverbSend = mapCurve(send, (y) => tidy(Math.max(SILENT_DB, gainToDb(y) + reverbDb)), true, MAX_KEYS)
      .map((k): CurveKey => (k.length === 3 ? [tidy(min + k[0] * span), k[1], k[2]] : [tidy(min + k[0] * span), k[1]]));
    return { minDistance: min, maxDistance: max, curves: { volume, reverbSend } };
  }

  run(): PlaylistAsset {
    const ev = this.event;
    const root = eventRootNode(ev);
    const body = this.body(root, "root");
    // Event-level automation and the root node's own apply to the whole playlist.
    this.distribute(body, [...this.bindings(ev.automation, "automation"), ...this.bindings(root.automation, "root")], "root");
    body.output = ev.bus === "" ? null : ev.bus;
    body.volume = tidy(body.volume + gainToDb(ev.volume));
    body.pitch = tidy(body.pitch + ratioToSemitones(ev.pitch));
    if ((ev.volumeRandom.some((v) => v !== 0) && root.volumeRandom.some((v) => v !== 0)) || (ev.pitchRandom.some((v) => v !== 0) && root.pitchRandom.some((v) => v !== 0))) {
      this.note("root", "the event's and the root node's random ranges were added together.");
    }
    body.volumeRandom = addPair(body.volumeRandom, ev.volumeRandom);
    body.pitchRandom = addPair(body.pitchRandom, ev.pitchRandom);
    const pb = body.playback;
    if (ev.limit.maxInstances > MAX_INSTANCES) this.note("limit", `maxInstances ${ev.limit.maxInstances} is above ${MAX_INSTANCES}; using ${MAX_INSTANCES}.`);
    pb.maxInstances = clamp(ev.limit.maxInstances, 0, MAX_INSTANCES);
    pb.whenFull = ev.limit.steal === "quietest" ? "stealQuietest" : ev.limit.steal === "none" ? "refuse" : "stealOldest";
    if (ev.cooldown > MAX_COOLDOWN) this.note("cooldown", `${ev.cooldown} s is above ${MAX_COOLDOWN} s; using ${MAX_COOLDOWN} s.`);
    pb.cooldown = clamp(ev.cooldown, 0, MAX_COOLDOWN);
    pb.priority = ev.priority;
    if (this.loopsForever) pb.plays = "untilStopped";
    body.parameters = ev.parameters.map((p) => structuredClone(p));
    // Filters: per-voice before, once per instance now; a fixed filter on a sum equals the sum of filtered voices.
    if (ev.filter?.lowpass !== undefined && ev.filter.lowpass < 20000) body.effects.push({ id: `fx${body.effects.length + 1}`, type: "lowpass", on: true, params: { cutoff: ev.filter.lowpass } });
    if (ev.filter?.highpass !== undefined && ev.filter.highpass > 20) body.effects.push({ id: `fx${body.effects.length + 1}`, type: "highpass", on: true, params: { cutoff: ev.filter.highpass } });
    // Sends: the reverb level folds into the reverb-send curve; an aux send has no playlist equivalent.
    let reverbDb = 0;
    for (const [key, level] of Object.entries(ev.sends ?? {})) {
      if (key === REVERB_SEND_KEY) {
        if (ev.spatial) reverbDb = gainToDb(level);
        else if (level !== 1) this.note("sends.reverb", `a reverb send of ${level} on a flat event has no playlist equivalent (route the output bus to a reverb return); dropped.`);
      } else this.note(`sends.${key}`, `the aux send to "${key}" (${level}) has no playlist equivalent (send from the output bus instead, ADR 0330); dropped.`);
    }
    if (ev.spatial) {
      body.spatial = {
        attenuation: this.attenuation(ev.spatial, reverbDb), occlusion: ev.spatial.occlusion ?? true,
        doppler: ev.spatial.dopplerLevel ?? 0, spread: null,
      };
    }
    return { format: PLAYLIST_FORMAT, ...body };
  }
}

/** Migrate one parsed audio event to a playlist (ADR 0329). `path` names the event in the notes. Never throws. */
export function migrateAudioEvent(parsed: AudioEventAsset, path: string, options: MigrateOptions = {}): MigratedAudioEvent {
  const m = new Migrator(path, parsed, options);
  const playlist = m.run();
  return { playlist, extra: [], notes: [...m.notes] };
}
