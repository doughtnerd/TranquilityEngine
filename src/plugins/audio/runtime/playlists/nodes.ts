/**
 * The playlist tree at runtime (ADR 0329 "Runtime semantics"): a trigger resolves the playlist into a tree of live
 * nodes, one resolver per playlist type (`RESOLVERS`), whose leaves are ordinary voices. Picks are made here, once per
 * trigger, on main (ADR 0157); what changes afterwards is event-driven (a parameter change re-picks a Switch, a timer
 * starts a continuous Queue's next entry) or a per-frame read of a dynamic gain (Blend weights, the Blend envelope,
 * voice-time curves), which the instance applies to its voices.
 *
 * Sequences are `sequence.ts`; the musical clock a Switch waits on is its playing entry's (`LiveNode.musicalSource`).
 */
import { accumulate } from "../../../../engine/audio/playlist/accumulate";
import { blendWeights1D, blendWeights2D } from "../../../../engine/audio/playlist/blendWeights";
import { adsrLevel, envelopeHoldMs, lerpAdsr } from "../../../../engine/audio/playlist/envelope";
import { defaultBlend, defaultQueue, defaultSwitch } from "../../../../engine/audio/playlist/format";
import { pickEntry } from "../../../../engine/audio/playlist/picks";
import { changeFor } from "../../../../engine/audio/playlist/switchRules";
import type {
  Adsr, BlendAxis, ChangeHow, ChangeRule, Entry, EntryUse, FadeShape, PlaylistBody, PlaylistType, SampleEntry, SwitchSettings, TimeLength,
} from "../../../../engine/audio/playlist/types";
import type { Region1D } from "../../../../engine/audio/playlist/blendWeights";
import { isLabelled, parameterRange } from "../../../../engine/audio/parameters";
import { warnOnce } from "../core/handle";
import { curveParts } from "./curves";
import { playlistEffectProps } from "./effects";
import { automationParts, type TimeAuto } from "./levelAutomation";
import { EmptyNode, LiveNode, type Ctx, type DynGain, type NodeHost, type PendingSwitchChange, type PVoice, type SpatialPlan } from "./liveNode";
import { linkedPlaylist } from "./loader";
import { FALLBACK_SECONDS_PER_BEAT, MUSICAL_FALLBACK_NOTE, type MusicalSource } from "./musical";
import { resolveSequence } from "./sequence";
import { taps } from "../mix/profileTaps";
import { NULL_PROFILE_SINK, type ProfilePick } from "../mix/profileSink";
import { sampleFacts, type SampleFacts } from "./sampleFacts";
import { VoiceClock, VoiceMusical } from "./voiceMusical";

export { EmptyNode, LiveNode } from "./liveNode";
export type { Ctx, DynGain, LoopRun, NodeHost, PendingSwitchChange, PVoice, SpatialPlan } from "./liveNode";

/** Below this a weight counts as zero (the prototype drops entries under 1e-4). */
export const ZERO_WEIGHT = 1e-4;
/** A continuous Queue asks for its next entry this far ahead of its start, so its PLAY reaches the core in time. */
const LOOKAHEAD = 0.25;
/** The least a continuous Queue moves on per entry, seconds. */
const MIN_STEP = 0.02;
/** A cut's fade, seconds (no click). */
const CUT_FADE = 0.005;
/** The fade of an entry a Blend stops at weight zero. */
const ZERO_WEIGHT_FADE = 0.04;

const lerp = ([lo, hi]: readonly [number, number], t: number): number => (lo === hi ? lo : lo + (hi - lo) * t);


// --- context down the tree -------------------------------------------------------------------------------------------

/** An entry's per-use settings below `ctx`: gain and pitch add, its curves add bindings or voice-time curves. */
export function useCtx(host: NodeHost, ctx: Ctx, use: EntryUse): Ctx {
  const hasCurves = Object.keys(use.curves).length > 0;
  if (use.volume === 0 && use.pitch === 0 && !hasCurves) return ctx;
  const parts = hasCurves ? curveParts(use.curves, ctx, (n) => host.paramRef(n), (c) => host.curveId(c), ctx.where) : ctx;
  return { ...ctx, props: accumulate(ctx.props, { gainDb: use.volume, pitchSt: use.pitch }), bindings: parts.bindings, timeCurves: parts.timeCurves };
}

/** A playlist's own level below `ctx`: volume and pitch with their random ranges (drawn per trigger), effects, output, spatial, delay. */
export function bodyCtx(host: NodeHost, ctx: Ctx, body: PlaylistBody, where: string): Ctx {
  // The draws are taken even for a fixed range, so a level's picks don't depend on its neighbours' settings.
  const gainDb = body.volume + lerp(body.volumeRandom, host.random());
  const pitchSt = body.pitch + lerp(body.pitchRandom, host.random());
  const override = body.output !== null;
  // ADR 0331: the instance's own chain runs on its submix when it has one (`NodeHost.submixedEffects`).
  const fx = body.effects === host.submixedEffects ? undefined : playlistEffectProps(body.effects, where);
  const props = accumulate(ctx.props, { gainDb, pitchSt, ...(fx ? { fx } : {}), outputOverride: override });
  const delay = ctx.depth > 0 ? body.playback.delay : 0; // the root's delay is the instance's (`PlaylistInstance.start`)
  const at = delay > 0 ? host.startOf(ctx.at) + delay : ctx.at;
  const out: Ctx = { ...ctx, props, bus: override ? body.output! : ctx.bus, at, spatial: host.spatialOf(body, ctx.spatial), where };
  return body.automation.length > 0 ? instanceAutomation(host, out, body, where) : out;
}

/**
 * A playlist's own automation (`PlaylistBody.automation`, D23) on its level: parameter-keyed lanes become bindings for
 * every voice below; voice-time lanes count from when this playlist starts (its `at`, else now) and each voice reads them
 * from its own start (`anchorTimeCurves`). Effect targets go through the playlist effects adapter where it maps them.
 */
function instanceAutomation(host: NodeHost, ctx: Ctx, body: PlaylistBody, where: string): Ctx {
  const time: TimeAuto[] = [];
  const next = automationParts(host, body.automation, body.effects, ctx, time, where);
  if (time.length === 0) return next;
  const origin = host.startOf(ctx.at);
  return { ...next, timeCurves: [...next.timeCurves, ...time.map((t) => ({ target: t.target, curve: t.curve, origin }))] };
}

/**
 * ADR 0334: one decision, for the capture's "Why it played" chain (a `pick` EVENT after the instance's `eventStart`):
 * nothing while no recorder runs, or for an instance without a group.
 */
export function notePick(host: NodeHost, ctx: Ctx, type: ProfilePick["type"], choice: number, label: string | null = null, weights: ProfilePick["weights"] = null): void {
  const sink = taps.sink;
  if (sink === NULL_PROFILE_SINK || !sink.pick || !host.group) return;
  sink.pick({ instance: host.group, depth: ctx.depth, playlist: ctx.where, type, choice, label, weights });
}

/** A resolver: the live node a playlist of one type becomes. */
export type Resolver = (host: NodeHost, body: PlaylistBody, ctx: Ctx, key: string) => LiveNode;

/** Resolve a playlist body below `ctx` (`key`: where its pick state lives; `where`: its path for messages). */
export function resolveBody(host: NodeHost, body: PlaylistBody, parent: Ctx, key: string, where: string): LiveNode {
  if (parent.depth > 32) return new EmptyNode(host, parent, key); // the parse limits nesting; links are cycle-checked
  const ctx = bodyCtx(host, parent, body, where);
  return RESOLVERS[body.type](host, body, ctx, key);
}

/** Resolve the entry at `index` of the playlist at `key`. Null when it can't play (a missing or cyclic link). */
export function resolveEntry(host: NodeHost, entry: Entry, parent: Ctx, key: string, index: number): LiveNode | null {
  if (host.stopped) return null;
  const ctx = useCtx(host, { ...parent, depth: parent.depth + 1 }, entry);
  switch (entry.kind) {
    case "linked": {
      const body = linkedPlaylist(entry.playlist, ctx.chain);
      if (!body) return null;
      return resolveBody(host, body, { ...ctx, chain: [...ctx.chain, entry.playlist] }, entry.playlist, entry.playlist);
    }
    case "embedded":
      return resolveBody(host, entry.embedded, ctx, `${key}/${index}`, ctx.where);
    case "sample": {
      // The parse wraps samples outside a Clip; a sample reached here plays as a one-entry Clip.
      const node = new ClipNode(host, ctx, `${key}/${index}`, entry);
      return node;
    }
  }
}

// --- Clip ------------------------------------------------------------------------------------------------------------

class ClipNode extends LiveNode {
  private musical: VoiceMusical | null = null;
  private clockArgs: { v: PVoice; facts: SampleFacts; from: number } | null = null;

  constructor(host: NodeHost, ctx: Ctx, key: string, entry: SampleEntry | null) {
    super(host, ctx, key);
    if (!entry) return;
    const v = host.playSample(entry, useCtx(host, ctx, entry));
    if (!v) return;
    this.voices.push(v);
    const facts = sampleFacts(entry.sample);
    const from = entry.trim ? entry.trim[0] : facts.from;
    if (facts.markers.length > 0) host.trackMarkers(v, facts, from);
    this.clockArgs = { v, facts, from };
    // A looping voice's clock is anchored now, so it knows when the loop stops; a straight one's can wait to be asked.
    if (v.loop) this.musical = new VoiceMusical(new VoiceClock(v, facts, from), () => this.host.clock());
  }

  /** Its musical clock: the sample's tempo, Exit markers and loop (ADR 0329 "the playing entry's sync sample"), made when first asked. */
  override musicalSource(): MusicalSource | null {
    if (!this.clockArgs || !this.sounding) return null;
    if (!this.musical) {
      const { v, facts, from } = this.clockArgs;
      this.musical = new VoiceMusical(new VoiceClock(v, facts, from), () => this.host.clock());
    }
    return this.musical;
  }

  override hasExitMarker(): boolean {
    return this.clockArgs !== null && this.clockArgs.facts.markers.some((m) => m.type === "exit");
  }

  override onParameter(name: string): void {
    for (const v of this.voices) {
      const b = v.loop?.behaviour.binding;
      if (v.leaving || v.loop?.behaviour.active !== "parameter" || !b || b.parameter !== name) continue;
      const p = this.host.param(name);
      if (p) this.host.setLoopActive(v, b.op === ">" ? p.value > b.value : p.value < b.value);
    }
  }
}

const resolveClip: Resolver = (host, body, ctx, key) => {
  const sample = body.entries.find((e): e is SampleEntry => e.kind === "sample") ?? null;
  return new ClipNode(host, ctx, key, sample);
};

// --- Layer -----------------------------------------------------------------------------------------------------------

class LayerNode extends LiveNode {
  constructor(host: NodeHost, ctx: Ctx, key: string, body: PlaylistBody) {
    super(host, ctx, key);
    body.entries.forEach((e, i) => {
      const c = resolveEntry(host, e, ctx, key, i);
      if (c) this.children.push(c);
    });
  }
}

const resolveLayer: Resolver = (host, body, ctx, key) => new LayerNode(host, ctx, key, body);

// --- Queue -----------------------------------------------------------------------------------------------------------

/** One pick per trigger. */
class QueueNode extends LiveNode {
  constructor(host: NodeHost, ctx: Ctx, key: string, body: PlaylistBody) {
    super(host, ctx, key);
    const q = body.queue ?? defaultQueue();
    const i = pickEntry(q, body.entries.map((e) => e.weight), host.pickState(key), () => host.random());
    notePick(host, ctx, "queue", i);
    if (i < 0) return;
    const c = resolveEntry(host, body.entries[i]!, ctx, key, i);
    if (c) this.children.push(c);
  }
}

/**
 * A continuous Queue: entries back to back until stopped or released, `gapMs` apart; a negative gap overlaps them with
 * an equal-power crossfade of that length. The next entry is picked a little ahead of its start when the current one's
 * end is known, else when it has ended (one frame late, counted as a late start).
 */
class RunnerNode extends LiveNode {
  private running = true;
  private waiting = false;
  private current: LiveNode | null = null;
  private readonly gap: number;

  constructor(host: NodeHost, ctx: Ctx, key: string, private readonly body: PlaylistBody) {
    super(host, ctx, key);
    this.gap = (body.queue?.continuous?.gapMs ?? 0) / 1000;
    this.step(ctx.at);
  }

  private step(at: number | null): void {
    if (!this.running || this.stopped || this.host.stopped) { this.running = false; return; }
    const q = this.body.queue ?? defaultQueue();
    const i = pickEntry(q, this.body.entries.map((e) => e.weight), this.host.pickState(this.key), () => this.host.random());
    notePick(this.host, this.ctx, "queue", i);
    if (i < 0) { this.running = false; return; }
    const prev = this.current;
    const overlap = this.gap < 0 && prev ? -this.gap : 0;
    // ADR 0336: the overlap's crossfade in its shape (absent: equal power).
    const shape = this.body.queue?.continuous?.shape ?? "equalPower";
    const child = resolveEntry(this.host, this.body.entries[i]!, { ...this.ctx, at, fadeIn: overlap, fadeInShape: shape }, this.key, i);
    if (prev && overlap > 0) prev.leave(overlap, at, shape);
    // Finished entries go (the list stays short over a long run).
    for (let k = this.children.length - 1; k >= 0; k--) if (this.children[k] !== prev && !this.children[k]!.sounding) this.children.splice(k, 1);
    // Nothing to play (a missing link, a refused voice): the run ends rather than spin.
    if (!child || !child.sounding) { this.running = false; return; }
    this.children.push(child);
    this.current = child;
    const end = child.end();
    if (end !== null) {
      // At least MIN_STEP on, so a zero-length entry (or an overlap longer than an entry) can't stall the frame.
      const from = this.host.startOf(at);
      const next = Math.max(end + this.gap, from + MIN_STEP);
      this.host.schedule(next - LOOKAHEAD, () => this.step(next));
    } else this.waiting = true;
  }

  override update(now: number, dt: number): void {
    super.update(now, dt);
    if (!this.waiting || !this.running || (this.current && this.current.sounding)) return;
    this.waiting = false;
    this.step(null);
    if (this.current) this.host.noteLateStart();
  }

  override release(): void {
    this.running = false;
    super.release();
  }

  override stop(fade: number): void {
    this.running = false;
    super.stop(fade);
  }

  override get sounding(): boolean {
    return (this.running && !this.stopped) || super.sounding;
  }

  override end(): number | null {
    return this.running ? null : super.end();
  }
}

const resolveQueue: Resolver = (host, body, ctx, key) => ((body.queue ?? defaultQueue()).continuous ? new RunnerNode(host, ctx, key, body) : new QueueNode(host, ctx, key, body));

// --- Switch ----------------------------------------------------------------------------------------------------------

class SwitchNode extends LiveNode {
  private readonly s;
  private label: string | null;
  private current: LiveNode | null = null;

  constructor(host: NodeHost, ctx: Ctx, key: string, private readonly body: PlaylistBody) {
    super(host, ctx, key);
    this.s = body.switch ?? defaultSwitch();
    this.label = this.currentLabel();
    this.startFor(this.label, 0, ctx.at);
  }

  /** The parameter's label now (a numeric parameter's value as text); null without the parameter. */
  private currentLabel(): string | null {
    const p = this.host.param(this.s.parameter);
    if (!p) {
      if (this.s.parameter) warnOnce(`playlist:switch-param:${this.ctx.where}:${this.s.parameter}`, `[myco] ${this.ctx.where}: the Switch's parameter "${this.s.parameter}" is neither the playlist's nor a global one; it plays its first label.`);
      return Object.keys(this.s.map)[0] ?? null;
    }
    return isLabelled(p.def) ? (p.def.labels[p.value] ?? null) : String(p.value);
  }

  private startFor(label: string | null, fadeIn: number, at: number | null, fadeInShape: FadeShape = "equalPower"): void {
    this.current = null;
    if (label === null || this.stopped) return;
    const index = this.s.map[label];
    notePick(this.host, this.ctx, "switch", index ?? -1, label);
    if (index === null || index === undefined || !this.body.entries[index]) return;
    const gainDb = this.s.labelGain[label] ?? 0;
    const ctx: Ctx = { ...this.ctx, at, fadeIn, fadeInShape, props: gainDb !== 0 ? accumulate(this.ctx.props, { gainDb }) : this.ctx.props };
    const c = resolveEntry(this.host, this.body.entries[index]!, ctx, this.key, index);
    if (!c) return;
    for (let k = this.children.length - 1; k >= 0; k--) if (!this.children[k]!.sounding) this.children.splice(k, 1);
    this.children.push(c);
    this.current = c;
  }

  override onParameter(name: string): void {
    super.onParameter(name);
    if (name !== this.s.parameter || this.stopped) return;
    const next = this.currentLabel();
    if (next === this.label) return;
    const from = this.label;
    this.label = next;
    this.change(changeFor(this.s, from ?? "", next ?? ""), from);
  }

  /** Bumped per change: a change still waiting for its boundary when a newer one arrives is dropped. */
  private serial = 0;
  /** The change waiting for its boundary (or bridging to it), for the debug rows and `handle.music.transition`. */
  private waiting: PendingSwitchChange | null = null;

  override pendingChange(): PendingSwitchChange | null {
    if (this.stopped) return null;
    return this.waiting ?? super.pendingChange();
  }

  /** The musical clock of the entry playing now (ADR 0329: Switch timing waits on the playing entry). */
  private clock(): MusicalSource | null {
    return this.current && !this.current.stopped ? this.current.musicalSource() : null;
  }

  override musicalSource(): MusicalSource | null {
    return this.clock() ?? super.musicalSource();
  }

  private change(how: ChangeHow, from: string | null): void {
    if (how.when === "nextTrigger") return; // the playing entry carries on; the next trigger reads the new label
    const serial = ++this.serial;
    this.waiting = null;
    if (how.when !== "now") {
      const at = this.clock()?.nextBoundary(how.when, this.host.startOf(null)) ?? null;
      if (at === null) warnOnce(`playlist:switch-when:${this.ctx.where}:${how.when}`, `[myco] ${this.ctx.where}: a Switch change at the next ${how.when} ${MUSICAL_FALLBACK_NOTE}.`);
      else {
        // ADR 0336 (pre-entry): an incoming sequence with an Entry marker starts that much early, so its timer is too.
        const lead = how.how === "transition" ? 0 : this.preEntry(this.label);
        this.waiting = pendingOf(this.s, how, from, this.label, at, this.ctx.where);
        this.host.schedule(at - lead - LOOKAHEAD, () => {
          if (serial !== this.serial) return;
          this.waiting = null;
          this.apply(how, at);
        });
        return;
      }
    }
    this.apply(how, null);
  }

  /** ADR 0336: seconds of pre-entry of the entry `label` plays (a sequence's first `entry` marker), 0 without one. */
  private preEntry(label: string | null): number {
    const index = label === null ? undefined : this.s.map[label];
    const e = index === null || index === undefined ? undefined : this.body.entries[index];
    return e ? preEntryOf(e, this.ctx.chain) : 0;
  }

  /** Seconds of a `TimeLength` on the playing entry's clock (a beat is the fallback 500 ms without one). */
  private seconds(length: TimeLength, spb: number): number {
    const s = "ms" in length ? length.ms / 1000 : length.beats * spb;
    return s > 0 ? s : 0;
  }

  /**
   * The outgoing entry leaves at heard `at` (ADR 0336): a crossfade fades it out over `fade` in `shape`; a cut (or no
   * fade) at its Exit marker lets its post-exit tail ring (`ringOut`) unless the rule's `tail` is false, else stops it
   * with a click-free cut there.
   */
  private leaveOld(old: LiveNode | null, how: ChangeHow, fade: number, at: number | null): void {
    if (!old) return;
    if (how.how !== "cut" && fade > 0) { old.leave(fade, at, how.shapeOut ?? "equalPower"); return; }
    if (how.tail !== false && at !== null && old.hasExitMarker() && this.atExit(old, how, at)) old.ringOut(at);
    else cutAt(old, at);
  }

  /** Whether the hand-over at `at` is the outgoing entry's Exit point (a change timed `exit`, or a beat or bar on it). */
  private atExit(old: LiveNode, how: ChangeHow, at: number): boolean {
    if (how.when === "exit") return true;
    const exit = old.musicalSource()?.nextBoundary("exit", at - 1e-6) ?? null;
    return exit !== null && Math.abs(exit - at) <= 1e-6;
  }

  /**
   * The change at heard `at` (null: now). `crossfade` and `cut` swap the entries there; `transition` plays as the
   * engine's bridge (ADR 0329): the old entry leaves at the boundary, the transition plays from it, and the new entry
   * enters at the transition's Exit marker (its musical clock's next `exit`: a marker, else its loop's end, else its
   * end). ADR 0336: each side fades in its rule's shape (`shapeOut`, `shapeIn`), the transition by its own `transitionIn`
   * and `transitionOut` when set (else the rule's length and shapes), and an incoming sequence with an Entry marker
   * starts its pre-entry early so the marker lands on the boundary. A transition that can't play crossfades straight
   * to the new entry.
   */
  private apply(how: ChangeHow, at: number | null): void {
    if (this.stopped || this.host.stopped) return;
    const spb = this.clock()?.secondsPerBeat() ?? FALLBACK_SECONDS_PER_BEAT;
    const fade = this.seconds(how.length, spb);
    this.leaveOld(this.current, how, fade, at);
    const shapeIn = how.shapeIn ?? "equalPower";
    if (how.how === "transition") {
      if (!how.transition) warnOnce(`playlist:switch-transition:${this.ctx.where}`, `[myco] ${this.ctx.where}: a Switch rule plays a transition but names none; it crossfades.`);
      else if (this.bridge(how, how.transition, fade, spb, at)) return;
    }
    const lead = at !== null ? this.preEntry(this.label) : 0;
    this.startFor(this.label, how.how === "cut" ? 0 : fade, at !== null ? at - lead : at, shapeIn);
  }

  /** Plays `entry` as a bridge from `at`; true when it plays (the new entry is then scheduled at its Exit marker). */
  private bridge(how: ChangeHow, entry: Entry, fade: number, spb: number, at: number | null): boolean {
    const from = this.host.startOf(at);
    const tIn = how.transitionIn ? { seconds: this.seconds(how.transitionIn.length, spb), shape: how.transitionIn.shape } : { seconds: fade, shape: how.shapeIn ?? "equalPower" };
    const tOut = how.transitionOut ? { seconds: this.seconds(how.transitionOut.length, spb), shape: how.transitionOut.shape } : { seconds: fade, shape: how.shapeOut ?? "equalPower" };
    const t = resolveEntry(this.host, entry, { ...this.ctx, at, fadeIn: tIn.seconds, fadeInShape: tIn.shape }, `${this.key}/transition`, 0);
    if (!t || !t.sounding) return false;
    this.children.push(t);
    this.current = t;
    const exit = t.musicalSource()?.nextBoundary("exit", from + 1e-6) ?? t.end();
    const enter = exit !== null && exit > from ? exit : from;
    const lead = this.preEntry(this.label);
    const serial = this.serial;
    if (enter > from) this.waiting = { ...pendingOf(this.s, how, null, this.label, enter, this.ctx.where), bridging: true };
    this.host.schedule(enter - lead - LOOKAHEAD, () => {
      if (serial !== this.serial || this.stopped) return;
      this.waiting = null;
      if (tOut.seconds > 0) t.leave(tOut.seconds, enter, tOut.shape); else cutAt(t, enter);
      this.startFor(this.label, fade, enter - lead, how.shapeIn ?? "equalPower");
    });
    return true;
  }
}

/** The debug view of a change from `from` to `to` landing at `at` (the rule's index and specificity, ADR 0166's tiers). */
function pendingOf(s: SwitchSettings, how: ChangeHow, from: string | null, to: string | null, at: number, where: string): PendingSwitchChange {
  const rule = s.rules.indexOf(how as ChangeRule);
  const r = rule >= 0 ? s.rules[rule]! : null;
  const tier = !r ? 4 : r.from !== "*" && r.to !== "*" ? 1 : r.from !== "*" ? 2 : r.to !== "*" ? 3 : 4;
  return { from, to, at, how, rule, tier, where, bridging: false };
}

/**
 * A click-free cut of `node` at heard `at` (null: now). A timed change runs a lookahead ahead of its boundary, so the
 * cut is a stamped 5 ms fade that stops the voices there, not a stop now (ADR 0336 fixed a cut landing early).
 */
function cutAt(node: LiveNode, at: number | null): void {
  if (at === null) node.stop(CUT_FADE);
  else node.leave(CUT_FADE, at, "linear");
}

/** ADR 0336: seconds before a sequence entry's first `entry` marker (its pre-entry), 0 for anything else. */
export function preEntryOf(entry: Entry, chain: readonly string[]): number {
  const body = entry.kind === "embedded" ? entry.embedded : entry.kind === "linked" ? linkedPlaylist(entry.playlist, chain) : null;
  if (!body || body.type !== "sequence" || !body.sequence) return 0;
  const m = body.sequence.markers.find((k) => k.type === "entry");
  return m && m.at > 0 ? m.at : 0;
}

const resolveSwitch: Resolver =(host, body, ctx, key) => new SwitchNode(host, ctx, key, body);

// --- Blend -----------------------------------------------------------------------------------------------------------

interface BlendSlot {
  entry: Entry;
  index: number;
  /** Normalised position(s). */
  x: number;
  y: number;
  weight: DynGain;
  /** Zone envelope of this entry (`zone` mode). */
  env: DynGain | null;
  envAdsr: Adsr | null;
  node: LiveNode | null;
}

class BlendNode extends LiveNode {
  private readonly b;
  private readonly slots: BlendSlot[] = [];
  private readonly startedAt: number;
  private readonly morph: DynGain | null;
  /** The input as the blend reads it (normalised; smoothed by `follow`, frozen by `hold`). */
  private input: [number, number];
  private releasedAtMs: number | null = null;
  private envelopeDone = false;

  constructor(host: NodeHost, ctx: Ctx, key: string, body: PlaylistBody) {
    super(host, ctx, key);
    this.b = body.blend ?? defaultBlend();
    this.startedAt = host.startOf(ctx.at);
    const env = this.b.envelope;
    this.morph = env.mode === "morph" ? { gain: 0 } : null;
    const n = body.entries.length;
    const axes = this.b.axes;
    body.entries.forEach((entry, index) => {
      const spread = n > 1 ? index / (n - 1) : 0.5;
      const x = entry.x !== undefined ? this.normalise(axes[0], entry.x) : spread;
      const y = axes[1] && entry.y !== undefined ? this.normalise(axes[1], entry.y) : spread;
      this.slots.push({ entry, index, x, y, weight: { gain: 0 }, env: null, envAdsr: null, node: null });
    });
    if (env.mode === "zone") {
      // Each entry's envelope is the low/high lerp by its rank along the first axis.
      const ranked = this.slots.slice().sort((a, b) => a.x - b.x || a.index - b.index);
      ranked.forEach((s, r) => {
        s.envAdsr = lerpAdsr(env.low, env.high, ranked.length > 1 ? r / (ranked.length - 1) : 0);
        s.env = { gain: adsrLevel(s.envAdsr, 0, null) };
      });
    }
    if (axes.length === 1) this.normaliseRegions();
    this.input = this.readInput();
    if (this.morph) this.morph.gain = adsrLevel(this.morphAdsr(), 0, null);
    const w = this.weights();
    if (taps.sink !== NULL_PROFILE_SINK) {
      const top = w.map((weight, entry) => [entry, weight] as const).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 2);
      notePick(host, ctx, "blend", top[0]?.[0] ?? -1, null, top);
    }
    for (const s of this.slots) {
      s.weight.gain = w[s.index]!;
      if (s.weight.gain >= ZERO_WEIGHT || s.entry.atZeroWeight === "continue") this.startSlot(s, ctx.at);
    }
  }

  /** `v` in `axis`'s units, normalised to 0..1. */
  private normalise(axis: BlendAxis, v: number): number {
    if ("voiceTime" in axis) return axis.voiceTime > 0 ? clamp01(v / axis.voiceTime) : 0;
    const p = this.host.param(axis.parameter);
    if (!p) return clamp01(v);
    const [lo, hi] = parameterRange(p.def);
    return hi > lo ? clamp01((v - lo) / (hi - lo)) : 0;
  }

  /** The axes' values now, normalised (voice time from the blend's start). */
  private readAxes(): [number, number] {
    const at = (axis: BlendAxis | undefined): number => {
      if (!axis) return 0;
      if ("voiceTime" in axis) return axis.voiceTime > 0 ? clamp01((this.host.clock() - this.startedAt) / axis.voiceTime) : 0;
      const p = this.host.param(axis.parameter);
      return p ? this.normalise(axis, p.value) : 0;
    };
    return [at(this.b.axes[0]), at(this.b.axes[1])];
  }

  private readInput(): [number, number] {
    return this.readAxes();
  }

  private weights(): number[] {
    const [x, y] = this.input;
    const curves = this.slots.some((s) => s.entry.weightCurve) ? this.slots.map((s) => s.entry.weightCurve) : undefined;
    if (this.b.axes.length === 2) return blendWeights2D(this.slots.map((s) => ({ x: s.x, y: s.y })), { x, y }, this.b.fade === "layer" ? "linear" : this.b.curve, curves);
    return blendWeights1D(this.slots.map((s) => s.x), x, this.b.fade, this.b.curve, this.regions, curves);
  }

  /** ADR 0336: the entries' explicit 1D regions, normalised like their x (undefined when none has one). */
  private regions: (Region1D | undefined)[] | undefined;

  private normaliseRegions(): void {
    if (!this.slots.some((s) => s.entry.region)) return;
    const axis = this.b.axes[0];
    let lo = 0, span = 1;
    if ("voiceTime" in axis) span = axis.voiceTime > 0 ? axis.voiceTime : 1;
    else {
      const p = this.host.param(axis.parameter);
      if (p) { const [a, b] = parameterRange(p.def); lo = a; span = b > a ? b - a : 1; }
    }
    this.regions = this.slots.map(({ entry: { region: r } }) => r && {
      start: (r.start - lo) / span, end: (r.end - lo) / span, fadeIn: r.fadeIn / span, fadeOut: r.fadeOut / span,
      ...(r.shapeIn ? { shapeIn: r.shapeIn } : {}), ...(r.shapeOut ? { shapeOut: r.shapeOut } : {}),
    });
  }

  private startSlot(s: BlendSlot, at: number | null): void {
    const dyn: DynGain[] = [...this.ctx.dyn];
    if (this.morph) dyn.push(this.morph);
    dyn.push(s.weight);
    if (s.env) dyn.push(s.env);
    s.node = resolveEntry(this.host, s.entry, { ...this.ctx, at, dyn }, this.key, s.index);
    if (s.node) this.children.push(s.node);
  }

  /** The morph envelope: low → high by where the input sits between the first and last entry. */
  private morphAdsr(): Adsr {
    const env = this.b.envelope;
    let lo = Infinity, hi = -Infinity;
    for (const s of this.slots) { lo = Math.min(lo, s.x); hi = Math.max(hi, s.x); }
    return lerpAdsr(env.low, env.high, hi > lo ? (this.input[0] - lo) / (hi - lo) : 0);
  }

  override update(now: number, dt: number): void {
    super.update(now, dt);
    if (this.stopped) return;
    // The input: follow (smoothed over glideMs), or hold (sampled at the trigger; voice time still runs).
    const target = this.readAxes();
    const follow = this.b.follow;
    const prev = this.input;
    let next: [number, number];
    if (follow === "hold") next = [this.heldAxis(0, prev[0], target[0]), this.heldAxis(1, prev[1], target[1])];
    else if (!(follow.glideMs > 0)) next = target;
    else {
      // One pole with a time constant of a third of the glide: within 5 % of a step after glideMs.
      const k = 1 - Math.exp(-dt / (follow.glideMs / 3000));
      next = [prev[0] + (target[0] - prev[0]) * k, prev[1] + (target[1] - prev[1]) * k];
      if (Math.abs(target[0] - next[0]) < 1e-4) next[0] = target[0];
      if (Math.abs(target[1] - next[1]) < 1e-4) next[1] = target[1];
    }
    if (next[0] !== prev[0] || next[1] !== prev[1]) {
      this.input = next;
      const w = this.weights();
      for (const s of this.slots) {
        s.weight.gain = w[s.index]!;
        if (s.entry.atZeroWeight !== "stop") continue;
        // At weight zero, `stop` stops the entry and restarts it from the top when its weight returns.
        if (s.weight.gain < ZERO_WEIGHT && s.node && !s.node.stopped) { s.node.stop(ZERO_WEIGHT_FADE); s.node = null; }
        else if (s.weight.gain >= ZERO_WEIGHT && (!s.node || s.node.stopped)) this.startSlot(s, null);
      }
      for (let k = this.children.length - 1; k >= 0; k--) if (this.children[k]!.stopped && !this.children[k]!.sounding) this.children.splice(k, 1);
    }
    this.updateEnvelope(now);
  }

  /** A held axis keeps its trigger value, except voice time, which always runs. */
  private heldAxis(i: 0 | 1, held: number, live: number): number {
    const axis = this.b.axes[i];
    return axis && "voiceTime" in axis ? live : held;
  }

  private updateEnvelope(now: number): void {
    const env = this.b.envelope;
    if (env.mode === "off" || this.envelopeDone) return;
    const ms = (now - this.startedAt) * 1000;
    if (ms < 0) return;
    if (this.releasedAtMs === null && !this.looping) {
      // Not looping: release on its own after the hold (the longest one-shot, else a default).
      const hold = envelopeHoldMs(env.mode === "morph" ? this.morphAdsr() : env.low, this.longestMs());
      if (ms >= hold) this.releasedAtMs = hold;
    }
    let done = true;
    if (this.morph) {
      const e = this.morphAdsr();
      this.morph.gain = adsrLevel(e, ms, this.releasedAtMs);
      done = this.releasedAtMs !== null && ms >= this.releasedAtMs + e.releaseMs;
    } else {
      for (const s of this.slots) {
        if (!s.env || !s.envAdsr) continue;
        s.env.gain = adsrLevel(s.envAdsr, ms, this.releasedAtMs);
        if (!(this.releasedAtMs !== null && ms >= this.releasedAtMs + s.envAdsr.releaseMs)) done = false;
      }
    }
    if (done) {
      this.envelopeDone = true;
      this.stop(CUT_FADE);
    }
  }

  override release(): void {
    if (this.b.envelope.mode !== "off" && this.releasedAtMs === null) this.releasedAtMs = Math.max(0, (this.host.clock() - this.startedAt) * 1000);
    super.release();
  }
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const resolveBlend: Resolver = (host, body, ctx, key) => new BlendNode(host, ctx, key, body);

/** One resolver per playlist type (the Sequence's is `sequence.ts`, called when it runs: the modules import each other). */
export const RESOLVERS: Readonly<Record<PlaylistType, Resolver>> = Object.freeze({
  clip: resolveClip,
  queue: resolveQueue,
  switch: resolveSwitch,
  blend: resolveBlend,
  layer: resolveLayer,
  sequence: (host, body, ctx, key) => resolveSequence(host, body, ctx, key),
});
