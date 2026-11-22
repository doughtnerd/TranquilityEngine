/**
 * Sequence playlists at runtime (ADR 0329 "Sequence"): a timeline of audio and playlist tracks with clips, loops, hold
 * points and markers, played by a playhead (`sequencePlayhead.ts`) planned a little ahead of the heard clock so every
 * clip voice starts stamped at its exact heard time.
 *
 * - **Tracks:** volume (dB) and pan add down the tree; `output` sends the track to a bus (its audio leaves the
 *   sequence's playlist effects there); `mute`, `solo` and `enabled` silence tracks (a disabled track's clips don't
 *   drive the playhead either; muted and un-soloed tracks still do, so muting a stem never changes the arrangement).
 * - **Clips** play a sample (audio tracks) or resolve a playlist once when the playhead enters them (playlist tracks).
 *   Clip time maps to sample time as pickup, first pass, further passes of the first loop filling the clip, tail
 *   (`clipMap.ts`); `length` 0 is the rest of the sample (one pass). Gain and pitch add; pan accumulates (no voice pan
 *   control exists yet); `reverse` isn't supported by the audio core (one warning, it plays forward).
 * - **Sync clips** are locked to the playhead: each piece of the map is one voice, swapped at the piece's heard time
 *   (sample-exact splices), cut when the playhead leaves the clip or jumps. Their first loop moves the playhead (the
 *   region of its passes): active it wraps back one pass at the tail, inactive `jump`/`crossfade` skip to the tail and
 *   `finish` leaves at the next Exit marker in the pass (else the pass's end); `reenter` jumps back in; a hold point
 *   parks it. Where sync loops overlap, the higher track drives and the others follow with their loop ignored (one
 *   warning).
 * - **Async clips** start a voice when the playhead enters them and run their own clock with their loop's behaviour
 *   (the instance's loop adapter: `setLoopActive`, `endLoop` on release); they aren't cut when the playhead leaves, only
 *   when it jumps back before them.
 * - **Automation** on clips and tracks: parameter-keyed curves become automation bindings (`curves.ts`); time-keyed ones
 *   (clip time, sequence time, voice time) are the voice-time adapter's curves shifted to where the voice starts, so the
 *   one per-frame evaluation runs them (pan and high-pass ones become core bindings on the voice's time when it starts,
 *   ABI 4.4). Targets (`levelAutomation.ts`): volume, pitch, enabled (a step on the gain), pan, and the `cutoff` of a
 *   low-pass or high-pass or the `gain` of a gain effect; other effect parameters wait for their controls (one warning).
 * - **Effects** on tracks and clips go through the playlist effects adapter (`effects.ts`).
 * - **Markers:** sequence `cue` and `exit` markers and the Cue, Exit and Hit markers of sync clips' samples are reported
 *   from the planned playhead, delivered on the first frame whose heard clock has passed them (one frame of accuracy);
 *   async clips' sample markers come from their voices (`VoiceMarkers`).
 * - **Musical clock** (`MusicalSource`): the sequence's tempo on the playhead (beats, bars, `seek`); `exit` is the next
 *   sequence `exit` marker or Exit marker of a sync clip's sample, else the next loop wrap.
 * - **Hot reload:** an edited sequence swaps at the next bar (at once without a tempo): the old voices fade out over
 *   5 ms there and the new version continues at the same sequence time when the tempo is unchanged and that time is
 *   inside it, else from its start (the music runtime's reload rule, `music/reload.ts`).
 * - `untilStopped` keeps the instance after the playhead's end; `release` ends held loops (sequence loops and sync clip
 *   loops by their exit settings, async voices' through the adapter); `stop` fades everything.
 */
import { accumulate } from "../../../../engine/audio/playlist/accumulate";
import { compileTempoMap, nextGridSeconds, positionToTicks, ticksToSeconds, type SegmentGrid } from "../../../../engine/audio/musicGrid";
import { isBarBeatTick, parsePosition } from "../../../../engine/audio/musicPosition";
import type { GridSpec, MusicSeekResult } from "../../../../engine/audio/musicTypes";
import type {
  Clip, LoopBehaviour, PlaylistAsset, PlaylistBody, SampleEntry, SequenceSettings, Track,
} from "../../../../engine/audio/playlist/types";
import { warnOnce } from "../core/handle";
import { RELOAD_FADE_MS, sameTempoMap } from "../music/reload";
import { clipGeometry, clipTimesOf, pieceAt, type ClipGeometry } from "./clipMap";
import { shiftedCurve, type TimeCurve } from "./curves";
import { playlistEffectProps } from "./effects";
import { automationParts, type TimeAuto } from "./levelAutomation";
import { LiveNode, shapedFade, type Ctx, type LoopRun, type NodeHost, type PVoice } from "./liveNode";
import type { FadeShape } from "../../../../engine/audio/playlist/types";
import { linkedPlaylist, loadPlaylist } from "./loader";
import type { MusicalBoundary, MusicalPosition, MusicalSource } from "./musical";
import { notePick, resolveBody } from "./nodes";
import { meterOf, sampleFacts, tempoGrid, type FactMarker, type SampleFacts } from "./sampleFacts";
import { Playhead, type PlayheadLoop, type PlayheadMove } from "./sequencePlayhead";
import { positionOn } from "./voiceMusical";

/** How far past the earliest stampable time the playhead is planned (decisions inside it are final). */
const PLAN_AHEAD = 0.1;
/** A splice's tail (a wrap or a piece change): the old voice fades out over this from the swap. */
const SPLICE_FADE = 0.002;
/** A cut's fade (a sync clip left, an async clip jumped before), seconds. */
const CUT_FADE = 0.005;
const EPS = 1e-9;
/** Heard seconds of past playhead moves kept for position questions. */
const HISTORY_SECONDS = 2;
/** How far a boundary question looks ahead of the plan, heard seconds. */
const PREDICT_SECONDS = 256;

interface ClipRt {
  readonly clip: Clip;
  readonly track: Track;
  /** Its place among the sequence's clips, in file order over all tracks. */
  readonly index: number;
  /** Sequence seconds the clip starts and ends at (end Infinity: a playlist clip of its natural length). */
  readonly start: number;
  readonly end: number;
  readonly sync: boolean;
  readonly audible: boolean;
  readonly facts: SampleFacts | null;
  readonly geo: ClipGeometry | null;
  /** The clip's first loop with its override: region (sample seconds) and behaviour. */
  readonly loop: { start: number; end: number; behaviour: LoopBehaviour } | null;
  /** Visible sample markers. */
  readonly markers: readonly FactMarker[];
  readonly ctx: Ctx;
  readonly time: readonly TimeAuto[];
  /** The playhead is inside the clip (its voices are managed). */
  inside: boolean;
  voice: PVoice | null;
  /** Sequence seconds the current piece ends at (sync sample clips). */
  pieceTo: number;
  node: LiveNode | null;
  /** The playhead loop it drives, -1: none. */
  driving: number;
}

interface PhLoop {
  readonly pl: PlayheadLoop;
  readonly behaviour: LoopBehaviour;
}

type HistoryItem = PlayheadMove;

export class SequenceNode extends LiveNode implements MusicalSource {
  private body: PlaylistBody;
  private settings!: SequenceSettings;
  private clips: ClipRt[] = [];
  private loops: PhLoop[] = [];
  private playhead!: Playhead;
  private grid: SegmentGrid | null = null;
  private length = 0;
  private readonly moves: PlayheadMove[] = [];
  private history: HistoryItem[] = [];
  private releasedHere = false;
  /** A sequence marker position already reported by a park (the run leaving it doesn't report it again). */
  private firedAt = Number.NaN;
  private pendingSeek: number | null = null;
  private reload: { body: PlaylistBody; at: number } | null = null;
  private source: PlaylistAsset | null;
  /** Heard time the playhead ended at (NaN: not yet). */
  private endAt = Number.NaN;
  private readonly scratch: number[] = [];

  constructor(host: NodeHost, ctx: Ctx, key: string, body: PlaylistBody) {
    super(host, ctx, key);
    this.body = body;
    this.source = this.fileAsset();
    // `EventOptions.offset` while the instance starts: the playhead starts there, and nothing below is offset again.
    const offset = host.startOffset ?? 0;
    if (offset > 0) host.startOffset = 0;
    try { this.build(body, offset, host.startOf(ctx.at), 0); } finally { if (offset > 0) host.startOffset = offset; }
    this.plan();
  }

  // --- building ----------------------------------------------------------------------------------------------------

  /** The playlist file this sequence lives in, when it is one (hot reload compares it). */
  private fileAsset(): PlaylistAsset | null {
    const where = this.ctx.where;
    if (!where.endsWith(".playlist.json")) return null;
    return loadPlaylist(where);
  }

  private build(body: PlaylistBody, position: number, at: number, fadeIn: number): void {
    const s = body.sequence ?? { length: 0, tempo: null, tracks: [], loops: [], markers: [] };
    this.settings = s;
    this.body = body;
    if (s.tempo) {
      const [bpb, unit] = meterOf(s.tempo.meter);
      this.grid = tempoGrid({ bpm: s.tempo.bpm, meter: `${bpb}/${unit}` }, undefined, this.ctx.where);
    } else this.grid = null;
    const anySolo = s.tracks.some((t) => t.solo && t.enabled);
    this.clips = [];
    let index = 0; // every clip in file order, track by track (the capture's pick choice)
    s.tracks.forEach((track) => {
      if (!track.enabled) { index += track.clips.length; return; }
      const trackCtx = this.trackCtx(track);
      for (const clip of track.clips) {
        const i = index++;
        if (!clip.enabled) continue;
        const rt = this.clipRt(clip, i, track, trackCtx, !track.mute && (!anySolo || track.solo));
        if (rt) this.clips.push(rt);
      }
    });
    let len = s.length;
    if (!(len > 0)) {
      len = 0;
      for (const c of this.clips) if (Number.isFinite(c.end)) len = Math.max(len, c.end);
    }
    this.length = len;
    this.loops = s.loops.map((l) => ({ pl: { start: l.start, end: l.end, wrapTo: l.start, behaviour: l }, behaviour: l }));
    this.driveLoops();
    if (position >= this.length - EPS) position = 0;
    this.playhead = new Playhead(this.loops.map((l) => l.pl), this.length, position, at);
    this.land(position, at, fadeIn);
  }

  /** A track's level below the sequence: volume, pan, effects, output, automation. */
  private trackCtx(track: Track): { ctx: Ctx; time: TimeAuto[] } {
    const override = track.output !== null;
    let ctx: Ctx = {
      ...this.ctx,
      props: accumulate(this.ctx.props, { gainDb: track.volume, pan: track.pan, fx: playlistEffectProps(track.effects, this.ctx.where), outputOverride: override }),
      bus: override ? track.output! : this.ctx.bus,
    };
    const time: TimeAuto[] = [];
    ctx = automationParts(this.host, track.automation, track.effects, ctx, time, `track "${track.name}"`);
    return { ctx, time };
  }

  private clipRt(clip: Clip, index: number, track: Track, level: { ctx: Ctx; time: TimeAuto[] }, audible: boolean): ClipRt | null {
    const where = `${this.ctx.where} clip "${clip.id}"`;
    if (clip.reverse) warnOnce(`playlist:reverse:${this.ctx.where}:${clip.id}`, `[myco] ${where}: reverse playback isn't supported by the audio core yet; it plays forward.`);
    let ctx: Ctx = { ...level.ctx, props: accumulate(level.ctx.props, { gainDb: clip.gain, pitchSt: clip.pitch, pan: clip.pan, fx: playlistEffectProps(clip.effects, where) }) };
    const time = level.time.slice();
    ctx = automationParts(this.host, clip.automation, clip.effects, ctx, time, where);
    const base = { clip, index, track, start: clip.at, sync: clip.sync, audible, ctx, time, inside: false, voice: null, pieceTo: Number.POSITIVE_INFINITY, node: null, driving: -1 };
    if (clip.sample === undefined) {
      return { ...base, end: clip.length > 0 ? clip.at + clip.length : Number.POSITIVE_INFINITY, facts: null, geo: null, loop: null, markers: [] };
    }
    const facts = sampleFacts(clip.sample);
    const first = facts.loops[0];
    let loop: ClipRt["loop"] = null;
    if (first) {
      const o = clip.loops[first.id] ?? {};
      const behaviour: LoopBehaviour = { ...first.behaviour };
      if (o.active !== undefined) behaviour.active = o.active;
      if (o.binding !== undefined) behaviour.binding = o.binding;
      if (o.exit !== undefined) behaviour.exit = o.exit;
      if (o.exitFadeMs !== undefined) behaviour.exitFadeMs = o.exitFadeMs;
      if (o.reentry !== undefined) behaviour.reentry = o.reentry;
      loop = { start: o.start ?? first.start, end: o.end ?? first.end, behaviour };
    }
    const offset = facts.from + clip.offset;
    const geo = clipGeometry(clip.length, offset, facts.end, loop);
    const hidden = new Set(clip.hiddenMarkers);
    return { ...base, end: clip.at + geo.length, facts, geo, loop: geo.loop ? loop : null, markers: facts.markers.filter((m) => !hidden.has(m.id)) };
  }

  /** Sync clips' first loops as playhead loops: the higher track drives where they overlap. */
  private driveLoops(): void {
    const taken: [number, number][] = [];
    for (const c of this.clips) {
      const g = c.geo;
      if (!c.sync || !g || !g.loop || !c.loop) continue;
      const passLen = g.loop.end - g.loop.start;
      const hold = passLen <= 1e-6;
      if (!hold && g.offset > g.loop.start + EPS) {
        warnOnce(`playlist:sync-partial:${this.ctx.where}:${c.clip.id}`, `[myco] ${this.ctx.where} clip "${c.clip.id}": it starts inside its loop, so the loop can't drive the playhead; it follows.`);
        continue;
      }
      const start = c.start + (hold ? g.firstPassEnd : g.firstPassEnd - passLen);
      const end = c.start + (hold ? g.firstPassEnd : g.tailStart);
      const region: [number, number] = [start, hold ? c.start + g.tailStart : end];
      if (taken.some(([a, b]) => region[0] < b - EPS && a < region[1] - EPS || (hold && Math.abs(a - region[0]) < EPS))) {
        warnOnce(`playlist:sync-clash:${this.ctx.where}:${c.clip.id}`, `[myco] ${this.ctx.where} clip "${c.clip.id}": its sync loop overlaps a higher track's; that one drives and this one follows.`);
        continue;
      }
      taken.push(region);
      const pl: PlayheadLoop = hold
        ? { start, end: start, wrapTo: start, behaviour: c.loop.behaviour, leaveTo: c.start + g.tailStart }
        : { start, end, wrapTo: end - passLen, behaviour: c.loop.behaviour, exitAfter: (from) => this.syncExitAfter(c, from) };
      c.driving = this.loops.length;
      this.loops.push({ pl, behaviour: c.loop.behaviour });
    }
  }

  /** The next point at or after `from` where a sync clip's inactive `finish` loop leaves: an Exit marker in the pass, else the pass's end. */
  private syncExitAfter(c: ClipRt, from: number): number {
    const g = c.geo!;
    const passLen = g.loop!.end - g.loop!.start;
    let best = c.start + g.tailStart;
    for (let k = 0; k <= g.extraPasses; k++) {
      const b = c.start + g.firstPassEnd + k * passLen;
      if (b >= from - EPS && b < best) best = b;
    }
    const u = from - c.start;
    for (const m of c.markers) {
      if (m.type !== "exit" || m.at < g.loop!.start - EPS || m.at >= g.loop!.end - EPS) continue;
      this.scratch.length = 0;
      for (const t of clipTimesOf(g, m.at, u, g.tailStart, this.scratch)) if (c.start + t < best) best = c.start + t;
    }
    return best;
  }

  // --- loops' activation -------------------------------------------------------------------------------------------

  private active(b: LoopBehaviour): boolean {
    switch (b.active) {
      case "always": return true;
      case "held": return !this.releasedHere && !this.host.released;
      case "parameter": {
        const bind = b.binding;
        const p = bind ? this.host.param(bind.parameter) : null;
        if (!bind || !p) return false;
        return bind.op === ">" ? p.value > bind.value : p.value < bind.value;
      }
    }
  }

  /** ADR 0336: a sequence ringing out its post-exit tail (`ringOut`) has every loop inactive, so each is left by its exit. */
  private readonly isActive = (i: number): boolean => !this.ringing && this.active(this.loops[i]!.behaviour);

  // --- planning ----------------------------------------------------------------------------------------------------

  /** Plans the playhead up to the earliest stampable time plus `PLAN_AHEAD`, acting on every move. */
  private plan(): void {
    if (this.stopped) return;
    const earliest = this.host.startOf(null);
    const until = earliest + PLAN_AHEAD;
    // Parked, time just passes (nothing was planned while parked): the playhead leaves the hold as soon as a start can
    // still be stamped, not at the end of the last plan.
    if (this.playhead.parked) this.playhead.time = Math.max(this.playhead.parkedSince, earliest);
    if (this.pendingSeek !== null) {
      const to = this.pendingSeek;
      this.pendingSeek = null;
      this.moves.length = 0;
      this.playhead.seek(to, this.moves);
      for (const m of this.moves) this.apply(m);
    }
    if (this.reload && this.reload.at <= until) {
      const { body, at } = this.reload;
      this.reload = null;
      this.step(Math.max(at, this.playhead.time));
      this.swap(body, Math.max(at, this.playhead.time));
    }
    this.step(until);
    // Old moves go (a position question looks back a little).
    const keep = this.host.clock() - HISTORY_SECONDS;
    let k = 0;
    while (k < this.history.length - 1 && moveEnd(this.history[k]!) < keep) k++;
    if (k > 0) this.history.splice(0, k);
  }

  private step(until: number): void {
    this.moves.length = 0;
    this.playhead.advance(until, this.isActive, this.moves);
    for (const m of this.moves) this.apply(m);
  }

  private apply(m: PlayheadMove): void {
    this.history.push(m);
    switch (m.kind) {
      case "run": this.onRun(m.from, m.to, m.at); break;
      case "jump": this.onJump(m.from, m.to, m.at, m.fadeMs / 1000, m.loop, m.why); break;
      case "park":
        this.markersAt(m.position, m.at);
        this.firedAt = m.position;
        break;
      case "end": this.onEnd(m.at, m.position); break;
    }
  }

  private onRun(from: number, to: number, at: number): void {
    const h = (s: number): number => at + (s - from);
    // Sequence markers in [from, to) (one a park reported isn't reported again as the playhead leaves it).
    for (const mk of this.settings.markers) {
      if (mk.type !== "cue" && mk.type !== "exit") continue;
      if (mk.at < from - EPS || mk.at >= to - EPS) continue;
      if (Math.abs(mk.at - this.firedAt) <= EPS && Math.abs(mk.at - from) <= EPS) continue;
      this.host.emitMarker({ type: mk.type, name: mk.name, sample: this.ctx.where, time: h(mk.at) });
    }
    this.firedAt = Number.NaN;
    for (const c of this.clips) {
      let enterAt = Number.NaN;
      if (!c.inside && c.start >= from - EPS && c.start < to - EPS) {
        c.inside = true;
        enterAt = c.start;
        this.startClip(c, 0, h(c.start), 0);
      }
      if (!c.inside) continue;
      const winFrom = Number.isNaN(enterAt) ? from : enterAt;
      // A sync clip's pieces: each boundary inside the run swaps its voice there.
      if (c.sync && c.geo) {
        for (let guard = 0; guard < 4096 && c.pieceTo < to - EPS && c.pieceTo < c.end - EPS; guard++) {
          if (c.pieceTo < winFrom - EPS) break;
          const q = c.pieceTo;
          this.endVoice(c, h(q), SPLICE_FADE, false);
          this.startClip(c, q - c.start, h(q), 0);
        }
      }
      const leaves = c.end > winFrom + EPS && c.end <= to + EPS;
      // Sample markers of a sync clip heard in this run.
      if (c.sync && c.geo && c.audible && c.markers.length > 0) {
        const u0 = winFrom - c.start, u1 = Math.min(to, c.end) - c.start;
        for (const mk of c.markers) {
          this.scratch.length = 0;
          for (const u of clipTimesOf(c.geo, mk.at, u0, u1, this.scratch)) {
            this.host.emitMarker({ type: mk.type, name: mk.name, sample: c.facts!.path, time: h(c.start + u) });
          }
        }
      }
      if (leaves) {
        c.inside = false;
        if (c.sync) this.endClip(c, h(c.end), CUT_FADE);
      }
    }
  }

  private onJump(from: number, to: number, at: number, fade: number, loop = -1, why = "seek"): void {
    const f = fade > 0 ? fade : SPLICE_FADE;
    // ADR 0336: a sequence loop's crossfade exit in its shape, and a wrap's tail: the audio from the loop's end to the
    // next Exit marker after it rings on over the next pass.
    const own = loop >= 0 && loop < this.settings.loops.length ? this.settings.loops[loop]! : null;
    const shape = own?.exitShape ?? "equalPower";
    const tail = why === "wrap" && own?.tail ? this.tailAfter(from) : 0;
    for (const c of this.clips) {
      const lands = to >= c.start - EPS && to < c.end - EPS;
      if (c.inside) {
        const cut = c.sync || to < c.start - EPS;
        if (cut && tail > 0 && c.end > from + EPS) this.ringClip(c, from, at, tail);
        else if (c.sync) this.endClip(c, at, f, fade > 0, shape);
        else if (to < c.start - EPS) this.endClip(c, at, Math.max(f, CUT_FADE), fade > 0, shape);
        c.inside = false;
      } else if (!c.sync && to < c.start - EPS && this.clipSounding(c)) this.endClip(c, at, Math.max(f, CUT_FADE), fade > 0, shape);
      if (!lands) continue;
      c.inside = true;
      if (!c.sync && this.clipSounding(c)) continue; // an async clip still sounding isn't restarted
      this.startClip(c, to - c.start, at, fade, shape);
    }
  }

  /** ADR 0336: seconds from sequence time `s` to the first `exit` marker after it, 0 with none (no tail). */
  private tailAfter(s: number): number {
    let best = Number.POSITIVE_INFINITY;
    for (const m of this.settings.markers) if (m.type === "exit" && m.at > s + EPS && m.at < best) best = m.at;
    return Number.isFinite(best) ? best - s : 0;
  }

  /**
   * ADR 0336: clip `c`, playing at sequence time `s` (a loop's end) at heard `at`, rings on `seconds` past it instead of
   * being cut: its voice plays on when its piece runs past `s`, else a tail voice plays the audio after `s`; a playlist
   * clip's node keeps playing. Each ends with a short fade at `at + seconds` (or at its own end, if sooner).
   */
  private ringClip(c: ClipRt, s: number, at: number, seconds: number): void {
    const n = c.node;
    c.node = null;
    if (n && !n.stopped) n.leave(CUT_FADE, at + seconds, "linear");
    const v = c.voice;
    if (v && !v.leaving && c.pieceTo > s + EPS) {
      c.voice = null;
      v.leaving = true;
      v.voice.fadeShaped({ to: 0, seconds: CUT_FADE, law: "linear", at: at + Math.min(seconds, c.pieceTo - s), stopAtEnd: true });
      return;
    }
    this.endVoice(c, at, SPLICE_FADE, false);
    if (c.clip.sample === undefined || !c.geo || !c.audible) return;
    const u = s - c.start;
    const piece = pieceAt(c.geo, u);
    if (!piece || piece.sample === null) return;
    const from = piece.sample + (u - piece.from);
    const to = Math.min(piece.sample + (piece.to - piece.from), from + seconds);
    if (to <= from + EPS) return;
    const entry: SampleEntry = { kind: "sample", sample: c.facts!.path, trim: [from, to], loop: "off", volume: 0, pitch: 0, weight: 1, atZeroWeight: "stop", curves: {} };
    const tv = this.host.playSample(entry, { ...c.ctx, at, fadeIn: 0, timeCurves: this.timeCurves(c, u) }, null);
    if (tv) this.voices.push(tv);
  }

  private onEnd(at: number, position: number): void {
    this.endAt = at;
    for (const c of this.clips) {
      // ADR 0336: a sequence ringing out its post-exit tail lets clips that run past its end play to their own end.
      if (c.inside && c.sync && this.ringing && c.end > position + EPS) this.ringClip(c, position, at, c.end - position);
      else if (c.inside && c.sync) this.endClip(c, at, CUT_FADE);
      c.inside = false;
    }
  }

  override hasExitMarker(): boolean {
    return !this.stopped && this.hasExits();
  }

  /** Clips holding `position` start there (a first start, a reload). */
  private land(position: number, at: number, fadeIn: number): void {
    for (const c of this.clips) {
      if (position < c.start - EPS || position >= c.end - EPS) continue;
      c.inside = true;
      this.startClip(c, position - c.start, at, fadeIn);
    }
  }

  /** Sequence markers at exactly `position` (a park on a hold point). */
  private markersAt(position: number, at: number): void {
    if (Math.abs(this.firedAt - position) <= EPS) return;
    for (const mk of this.settings.markers) {
      if ((mk.type === "cue" || mk.type === "exit") && Math.abs(mk.at - position) <= EPS) this.host.emitMarker({ type: mk.type, name: mk.name, sample: this.ctx.where, time: at });
    }
  }

  // --- clip voices -------------------------------------------------------------------------------------------------

  private clipSounding(c: ClipRt): boolean {
    if (c.voice && !c.voice.leaving && c.voice.voice.playing) return true;
    return c.node !== null && !c.node.stopped && c.node.sounding;
  }

  /** The time automation shifted to a voice starting at clip time `u`. */
  private timeCurves(c: ClipRt, u: number): readonly TimeCurve[] {
    if (c.time.length === 0) return c.ctx.timeCurves;
    const out = c.ctx.timeCurves.slice();
    for (const t of c.time) {
      const offset = t.input === "clipTime" ? u : t.input === "sequenceTime" ? c.start + u : 0;
      out.push({ target: t.target, curve: shiftedCurve(t.curve, offset) });
    }
    return out;
  }

  /** Starts clip `c` at clip time `u`, heard `at`, fading in over `fadeIn` seconds (0: none). */
  private startClip(c: ClipRt, u: number, at: number, fadeIn: number, fadeInShape: FadeShape = "equalPower"): void {
    c.voice = null;
    if (c.clip.sample === undefined) {
      if (!c.audible) return;
      c.node = this.resolveClipPlaylist(c, u, at, fadeIn, fadeInShape);
      if (c.node) this.children.push(c.node);
      return;
    }
    const g = c.geo!;
    const piece = pieceAt(g, u);
    c.pieceTo = piece ? c.start + piece.to : Number.POSITIVE_INFINITY;
    if (!piece || piece.sample === null || !c.audible) return;
    const s = piece.sample + (u - piece.from);
    const pieceEnd = piece.sample + (piece.to - piece.from);
    const facts = c.facts!;
    let loop: LoopRun | null = null;
    if (!c.sync && c.loop && c.loop.end > c.loop.start && s < c.loop.end - EPS) {
      loop = { start: c.loop.start, end: c.loop.end, behaviour: c.loop.behaviour, looping: this.active(c.loop.behaviour) };
    }
    const end = c.sync ? pieceEnd : (Number.isFinite(g.sampleEnd) ? g.sampleEnd : Number.POSITIVE_INFINITY);
    const entry: SampleEntry = {
      kind: "sample", sample: facts.path, trim: [s, end], loop: "off",
      volume: 0, pitch: 0, weight: 1, atZeroWeight: "stop", curves: {},
    };
    const ctx: Ctx = { ...c.ctx, at, fadeIn, fadeInShape, timeCurves: this.timeCurves(c, u) };
    const v = this.host.playSample(entry, ctx, loop);
    if (!v) return;
    c.voice = v;
    this.voices.push(v);
    if (!c.sync && c.markers.length > 0) this.host.trackMarkers(v, { ...facts, markers: c.markers }, s);
  }

  private resolveClipPlaylist(c: ClipRt, u: number, at: number, fadeIn: number, fadeInShape: FadeShape): LiveNode | null {
    const src = c.clip.playlist!;
    const ctx: Ctx = { ...c.ctx, at, fadeIn, fadeInShape, timeCurves: this.timeCurves(c, u), depth: this.ctx.depth + 1 };
    // ADR 0334 (D22): the clip is this sequence's pick, recorded before the picks of the playlist it resolves.
    if (typeof src === "string") {
      const body = linkedPlaylist(src, ctx.chain);
      if (!body) return null;
      notePick(this.host, this.ctx, "sequence", c.index, c.clip.id);
      return resolveBody(this.host, body, { ...ctx, chain: [...ctx.chain, src] }, src, src);
    }
    notePick(this.host, this.ctx, "sequence", c.index, c.clip.id);
    return resolveBody(this.host, src, ctx, `${this.key}/clip:${c.clip.id}`, this.ctx.where);
  }

  /** Ends clip `c`'s current voice at heard `at` over `fade` seconds (`crossfade`: in `shape`, ADR 0336; else linear). */
  private endVoice(c: ClipRt, at: number, fade: number, crossfade: boolean, shape: FadeShape = "equalPower"): void {
    const v = c.voice;
    c.voice = null;
    if (!v || v.leaving) return;
    v.leaving = true;
    shapedFade(v.voice, crossfade ? shape : "linear", fade, 1, 0, at, () => at, true);
  }

  private endClip(c: ClipRt, at: number, fade: number, crossfade = false, shape: FadeShape = "equalPower"): void {
    this.endVoice(c, at, fade, crossfade, shape);
    const n = c.node;
    c.node = null;
    if (n && !n.stopped) n.leave(fade, at, crossfade ? shape : "equalPower");
  }

  // --- the node ----------------------------------------------------------------------------------------------------

  override update(now: number, dt: number): void {
    super.update(now, dt);
    if (this.stopped) return;
    this.checkReload();
    this.plan();
    // Voices that have gone for good leave the list.
    if (this.voices.length > 32) {
      let w = 0;
      for (const v of this.voices) if (v.voice.alive ?? v.voice.playing) this.voices[w++] = v;
      this.voices.length = w;
    }
    for (let k = this.children.length - 1; k >= 0; k--) if (this.children[k]!.stopped && !this.children[k]!.sounding) this.children.splice(k, 1);
  }

  override onParameter(name: string): void {
    super.onParameter(name);
    // Async voices whose loop follows the parameter (the playhead's loops read it as it plans).
    for (const c of this.clips) {
      const v = c.voice;
      const b = v?.loop?.behaviour.binding;
      if (!v || v.leaving || v.loop?.behaviour.active !== "parameter" || !b || b.parameter !== name) continue;
      this.host.setLoopActive(v, this.active(v.loop.behaviour));
    }
  }

  override release(): void {
    this.releasedHere = true;
    super.release();
  }

  override get sounding(): boolean {
    if (this.stopped) return false;
    if (!this.playhead.ended) return true;
    if (this.host.clock() < this.endAt - EPS) return true;
    return super.sounding;
  }

  override get looping(): boolean {
    return !this.playhead.ended || super.looping;
  }

  override end(): number | null {
    if (!this.playhead.ended) return null;
    const e = super.end();
    return e === null ? null : Math.max(e, this.endAt);
  }

  override musicalSource(): MusicalSource | null {
    return this.stopped ? null : this;
  }

  // --- hot reload --------------------------------------------------------------------------------------------------

  private checkReload(): void {
    if (!this.source || this.reload) return;
    const now = loadPlaylist(this.ctx.where);
    if (!now || now === this.source) return;
    this.source = now;
    const body = this.bodyIn(now);
    if (!body) {
      warnOnce(`playlist:reload:${this.key}`, `[myco] ${this.ctx.where}: the reloaded playlist no longer holds this sequence where it was; the old version keeps playing.`);
      return;
    }
    if (JSON.stringify(body.sequence) === JSON.stringify(this.body.sequence)) return;
    const from = this.host.startOf(null);
    const at = this.grid ? (this.nextBoundary("bar", from + PLAN_AHEAD) ?? from) : from;
    this.reload = { body, at };
  }

  /** This sequence's body inside the reloaded file (by its key below the file's path), or null. */
  private bodyIn(asset: PlaylistBody): PlaylistBody | null {
    const where = this.ctx.where;
    if (!this.key.startsWith(where)) return null;
    let b: PlaylistBody | null = asset;
    for (const seg of this.key.slice(where.length).split("/").filter(Boolean)) {
      if (!b) return null;
      if (seg.startsWith("clip:")) {
        const id = seg.slice(5);
        let next: PlaylistBody | null = null;
        for (const t of b.sequence?.tracks ?? []) for (const cl of t.clips) if (cl.id === id && typeof cl.playlist === "object") next = cl.playlist;
        b = next;
      } else {
        const e: PlaylistBody["entries"][number] | undefined = b.entries[Number(seg)];
        b = e && e.kind === "embedded" ? e.embedded : null;
      }
    }
    return b && b.type === "sequence" ? b : null;
  }

  /** Swaps to `body` at heard `at` (the reload rule). */
  private swap(body: PlaylistBody, at: number): void {
    const fade = RELOAD_FADE_MS / 1000;
    for (const c of this.clips) this.endClip(c, at, fade);
    const oldGrid = this.grid;
    const position = this.playhead.position;
    const s = body.sequence;
    let sameTempo = !oldGrid && !s?.tempo;
    if (oldGrid && s?.tempo) {
      const [bpb, unit] = meterOf(s.tempo.meter);
      sameTempo = sameTempoMap(oldGrid, compileTempoMap([{ at: "1:1:0", bpm: s.tempo.bpm, beatsPerBar: bpb, beatUnit: unit }], 0));
    }
    this.endAt = Number.NaN;
    // The same sequence time when the tempo is unchanged (and the time is inside the new version), else its start.
    this.build(body, sameTempo ? position : 0, at, 0);
  }

  // --- the musical clock -------------------------------------------------------------------------------------------

  get label(): string { return this.ctx.where; }
  /** A tempo: the sequence's own, else a sync clip's sample tempo (ADR 0329: "its sequence's tempo, else its sync sample's"). */
  get hasGrid(): boolean { return this.grid !== null || this.clips.some((c) => c.sync && c.facts?.grid); }

  /** The sync clip with a sample tempo holding sequence time `s` (the higher track first), else the next one after `s`. */
  private tempoClip(s: number, after: boolean): ClipRt | null {
    let next: ClipRt | null = null;
    for (const c of this.clips) {
      if (!c.sync || !c.geo || !c.facts?.grid) continue;
      if (s >= c.start - EPS && s < c.end - EPS) return c;
      if (after && c.start > s && (!next || c.start < next.start)) next = c;
    }
    return next;
  }

  /** Sequence seconds of the first grid point of `spec` at or after `s` (NaN: none). */
  private nextPoint(s: number, spec: GridSpec): number {
    if (this.grid) return nextGridSeconds(this.grid, s, spec);
    const c = this.tempoClip(s, true);
    if (!c) return Number.NaN;
    const g = c.facts!.grid!;
    let u = Math.max(0, s - c.start);
    for (let guard = 0; guard < 4096; guard++) {
      const p = pieceAt(c.geo!, u);
      if (!p) return Number.NaN;
      if (p.sample !== null) {
        const x = nextGridSeconds(g, p.sample + (u - p.from), spec);
        if (x < p.sample + (p.to - p.from) - EPS) return c.start + p.from + (x - p.sample);
      }
      u = p.to;
    }
    return Number.NaN;
  }

  /** The musical position at sequence seconds `s`. */
  private positionAtSeq(s: number): MusicalPosition | null {
    if (this.grid) return positionOn(this.grid, s);
    const c = this.tempoClip(s, false);
    if (!c) return null;
    const p = pieceAt(c.geo!, s - c.start);
    return p && p.sample !== null ? positionOn(c.facts!.grid!, p.sample + (s - c.start - p.from)) : null;
  }

  /** Walks the playhead's moves at or after heard `from` (the kept past, the plan, then a prediction) until `visit` says stop. */
  private walk(from: number, visit: (m: PlayheadMove) => boolean): void {
    for (const m of this.history) if (moveEnd(m) >= from - EPS && visit(m)) return;
    const p = this.playhead.clone();
    const moves: PlayheadMove[] = [];
    for (let k = 0; k < PREDICT_SECONDS / 4 && !p.ended; k++) {
      moves.length = 0;
      p.advance(p.time + 4, this.isActive, moves);
      for (const m of moves) if (moveEnd(m) >= from - EPS && visit(m)) return;
    }
  }

  /** The first heard time at or after `from` whose sequence time is a point of `next` (sequence seconds at or after s; NaN none). */
  private firstHeard(from: number, next: (s: number) => number): number | null {
    let out: number | null = null;
    this.walk(from, (m) => {
      if (m.kind !== "run") return false;
      const a = Math.max(from, m.at);
      const s = m.from + (a - m.at);
      if (s >= m.to - EPS) return false;
      const p = next(s);
      // A point at the run's very end counts (an Exit marker at the sequence's end, or at a loop's end where it wraps).
      if (Number.isFinite(p) && p <= m.to + EPS) { out = m.at + (p - m.from); return true; }
      return false;
    });
    return out;
  }

  /** Sequence seconds of the first Exit point at or after `s`: sequence `exit` markers and sync clips' sample Exit markers. */
  private nextExit(s: number): number {
    let best = Number.POSITIVE_INFINITY;
    for (const mk of this.settings.markers) if (mk.type === "exit" && mk.at >= s - EPS && mk.at < best) best = mk.at;
    for (const c of this.clips) {
      if (!c.sync || !c.geo || c.end < s) continue;
      for (const mk of c.markers) {
        if (mk.type !== "exit") continue;
        this.scratch.length = 0;
        for (const u of clipTimesOf(c.geo, mk.at, Math.max(0, s - c.start), c.geo.length, this.scratch)) if (c.start + u < best) best = c.start + u;
      }
    }
    return best;
  }

  private hasExits(): boolean {
    if (this.settings.markers.some((m) => m.type === "exit")) return true;
    return this.clips.some((c) => c.sync && c.markers.some((m) => m.type === "exit"));
  }

  nextBoundary(kind: MusicalBoundary, from: number): number | null {
    if (this.stopped) return null;
    if (kind === "exit") {
      if (this.hasExits()) return this.firstHeard(from, (s) => this.nextExit(s));
      // No Exit marker: the next loop wrap.
      let out: number | null = null;
      this.walk(from, (m) => (m.kind === "jump" && m.why === "wrap" && m.at >= from - EPS ? ((out = m.at), true) : false));
      return out;
    }
    if (!this.hasGrid) return null;
    return this.firstHeard(from, (s) => this.nextPoint(s, kind));
  }

  secondsPerBeat(): number | null {
    if (this.grid) return 60 / this.grid.bpm[0]!;
    const p = this.hasGrid ? this.positionAt(this.host.clock()) : null;
    return p && p.tempo > 0 ? 60 / p.tempo : null;
  }

  /** Sequence seconds heard at `time`, NaN when unknown (before the kept past, or past the end). */
  private sequenceAt(time: number): number {
    const first = this.history[0];
    if (!first || time < first.at - EPS) return Number.NaN;
    if (time <= this.playhead.time + EPS) {
      // The kept past and the plan: the last move at or before `time` says where the playhead is.
      let s = Number.NaN;
      for (const m of this.history) {
        if (m.at > time + EPS) break;
        if (m.kind === "run") s = time <= moveEnd(m) ? m.from + (time - m.at) : m.to;
        else s = m.kind === "jump" ? m.to : m.position;
      }
      return s;
    }
    let s = Number.NaN;
    this.walk(time, (m) => {
      if (m.kind === "run" && time >= m.at - EPS && time <= moveEnd(m) + EPS) { s = m.from + (time - m.at); return true; }
      if (m.kind === "park" && time >= m.at - EPS) { s = m.position; return true; }
      return m.at > time + EPS;
    });
    return s;
  }

  positionAt(time: number): MusicalPosition | null {
    if (!this.hasGrid || this.stopped) return null;
    const s = this.sequenceAt(time);
    return Number.isFinite(s) ? this.positionAtSeq(s) : null;
  }

  nextGrid(spec: GridSpec, from: number): { time: number; bar: number; beat: number } | null {
    if (!this.hasGrid) return null;
    let point = Number.NaN;
    const t = this.firstHeard(from, (s) => (point = this.nextPoint(s, spec)));
    if (t === null) return null;
    const p = this.positionAtSeq(point + 1e-9);
    return p ? { time: t, bar: p.bar, beat: p.beat } : null;
  }

  seek(to: string): MusicSeekResult {
    const g = this.grid;
    if (!g || this.stopped) return { ok: false, reason: this.stopped ? "notPlaying" : "invalid", permanent: true };
    const p = parsePosition(to);
    if (!p || !isBarBeatTick(p)) return { ok: false, reason: "invalid", permanent: true };
    const s = ticksToSeconds(g, positionToTicks(g, p.bar, p.beat, p.tick));
    if (!(s >= 0) || s >= this.length) return { ok: false, reason: "invalid", permanent: true };
    this.pendingSeek = s;
    return { ok: true, time: Math.max(this.playhead.time, this.host.startOf(null)) };
  }
}

function moveEnd(m: PlayheadMove): number {
  return m.kind === "run" ? m.at + (m.to - m.from) : m.at;
}

/** The Sequence resolver. */
export function resolveSequence(host: NodeHost, body: PlaylistBody, ctx: Ctx, key: string): LiveNode {
  return new SequenceNode(host, ctx, key, body);
}
