// The core backend's music group operations (ADR 0166 api-and-models §4.6, C8, C10; architecture §2.2, §2.3, §4.2,
// §4.3): the `MusicBackend` of contract Q0, which `CoreBackend.music` returns.
//
// Owners (M4 waves plan): **Q2** wrote the skeleton and wired every hook from `coreBackend.ts` and `streams.ts`, which
// are frozen after W1; **P1** (W3) fills the group lifecycle: admit (the pool and group-table mirrors), the
// `primeGroup` message (one batch per group; `bytes` sent per Q0's miss rule, `needBytes`), primed state from STATUS
// `musicRings` with the epoch check (R7), the gated PLAYs of a stamp, cancel, the instance's encoded-cache release, the
// group events (STATUS `groupStarts`, starves, ends, errors, stream event 4), the member hooks below and Ê; **P9** (W5)
// fills `reopenGroups` (a hard rebuild or a new worker hands music groups here, never to `reopenStreams`, C16).
// **P10** reads `debugView` from `core/debug.ts` (the `DebugSource.musicOps` member) and doesn't edit this file.
//
// The hooks `coreBackend.ts` calls:
// - `beginFrame()` from `CoreBackend.beginFrame` (step 0) and `frameAttenuate`: this frame's STATUS music sections and
//   group events (delivered through `onGroupEvent` after the status mirror is read);
// - `ownsVoice(id)`, `adoptMember`, `decoratePlay`, `memberFreed` from the voice path: a group member is an ordinary voice
//   whose stream (if streamed) musicOps opened and primed, so the stream manager never opens or closes it, and whose PLAY
//   carries the gate;
// - `fadeShaped(id, f)` from `Voice.fadeShaped` (§4.2: a FADE on the `fade` ramp with a law, `u0`, a stamp);
// - `onStreamEvent(id, code)` from `streams.ts`: stream event 4 (`musicFull`) and every event of a music member's stream;
// - `ownsStream(id)` from `streams.ts`: which stream ids are music members';
// - `reopenGroups()` from `reopenStreams` after a hard rebuild (music voices skipped there).
//
// P1's model (architecture §2.2, §2.3, §4.2):
// - **Admission** records the group and reserves its streamed members' rings in the pool mirror (`audio.music.rings`), so
//   two admissions in one frame can't overcommit; the group-table mirror counts live groups against the core's 16.
//   A ring returns when main posts its `streamClose` (`memberFreed`) or the group is cancelled (§2.3: "free when it posts").
// - **Prime** posts one `primeGroup` per group (every member in one message, so the worker's breadth-first order covers the
//   group), after fetching the bytes of members whose path the worker doesn't hold for the instance (Q0's miss rule);
//   `needBytes` resends just those members with bytes and `retarget: false`. `protect` rides on every `primeGroup`.
// - **Primed** is the STATUS `musicRings` level: a member is primed when its ring shows bit 30 for the epoch main last
//   sent (R7). Decoded members count as primed.
// - **Ê** (architecture §4.2 item 4): one sample per prime, from the `primeGroup` call (the miss fetch included) to the
//   first `beginFrame` that finds a new STATUS showing every member primed; not sampled while hidden. Asymmetric EMA,
//   0.5 up and 0.1 down, floor 0, seeded at 40 ms (`resetPrimeEma` on a new context, P9).
// - **Stamp** plays every member through `CoreBackend.play` with `music` set, back to back, then the first fades: the
//   members' PLAYs are consecutive records with one frame and one gate (`decoratePlay` packs it), so the writer keeps
//   them in one BATCH.
import type { MusicAdmitResult, MusicBackend, MusicBackendCaps, MusicGroupEvent, MusicGroupRequest, MusicGroupStamp, MusicPrimedState, AudioVoice, ShapedFade, FadeLaw as FadeLawName } from "../backend";
import type { CommandWriter, PlayArgs } from "./commandWriter";
import type { ClockMap } from "./clock";
import type { StatusMirror } from "./mirror";
import type { StreamDecoderLike, StreamManager } from "./streams";
import { MAX_STAMPED, StampedKind, STAMPED_FLAG_STOP_AT_END, type VoiceTable } from "./voiceTable";
import type { WorkletChannel } from "./workletChannel";
import type { WarnOnce } from "./codecs";
import type { CorePlayRequest, CoreVoice } from "./coreBackend";
import { FadeLaw, packGate, packShape, StreamEvent } from "../wire.generated";
import { hintFromName, MUSIC_ENCODED_BUDGET_MIB, type MusicReply, type PrimeGroupMember } from "../decoder/protocol";
import type { StreamReply } from "../decoder/decoderClient";
import { MUSIC_RINGS_PRESETS } from "../../../../engine/audio/settings";

/** Ê's seed on a new context, milliseconds (architecture §4.1). */
export const PRIME_EMA_SEED_MS = 40;
/** Ê's gains (architecture §4.2, est.): a slower sample moves it half way, a faster one a tenth. */
export const PRIME_EMA_UP = 0.5;
export const PRIME_EMA_DOWN = 0.1;
/** The core's group table (§3.1, R9). */
export const MUSIC_GROUP_TABLE = 16;
/** The primed bit and the epoch of a `musicRings` item's `epochFlags` (§4.4). */
const RING_PRIMED = 1 << 30;
const RING_EPOCH_MASK = (1 << 30) - 1;

/** What the core supports for music (§4.6): everything. The player branches on this record, never on the backend type. */
export const CORE_MUSIC_CAPS: MusicBackendCaps = Object.freeze({ primes: true, stampedFades: true, heardClock: true, rhythm: true });

/**
 * A group member as `CorePlayRequest.music` carries it into `CoreBackend.play` (P1 makes these in `stampGroup`): the
 * voice is a member of `group`; a streamed member's stream id was allocated and primed by musicOps, so the backend uses
 * it as the voice's clip and neither registers nor opens it with the stream manager.
 */
export interface MusicMemberTag {
  /** The music group, 1..1023. */
  readonly group: number;
  /** The member's index in its group request. */
  readonly member: number;
  /** A streamed member's stream id (from the stream id range); absent for a decoded member. */
  readonly stream?: number;
}

/**
 * What musicOps reaches of the backend. `CoreBackend`'s constructor builds it with closures over its private parts, so
 * P1 and P9 never need to edit `coreBackend.ts`.
 */
export interface MusicOpsHost {
  readonly table: VoiceTable;
  readonly writer: CommandWriter;
  readonly mirror: StatusMirror;
  readonly clockMap: ClockMap;
  readonly streams: StreamManager;
  /** The worker ↔ worklet channel (shared with streams and zone IRs). */
  readonly worklet: WorkletChannel<StreamDecoderLike>;
  /** The decoder client the streams use (`primeGroup`, `cancelGroup` go to it, D1a's methods). */
  decoder(): StreamDecoderLike;
  /** Fetches an asset's encoded bytes (for a member the worker doesn't hold, Q0's `needBytes`). */
  fetchBytes(path: string): Promise<ArrayBuffer>;
  /** Plays one voice through the backend's ordinary path (`CoreBackend.play`); a member carries `music`. */
  play(req: CorePlayRequest): CoreVoice | null;
  /** False while nothing reaches a core (disposed, a rebuild running, failed). */
  sending(): boolean;
  /** The music ring pool's size from the preset (`audio.music.rings`; 0 before ABI 3.0's preset carries it). */
  musicRings(): number;
  /** The context's rate, Hz (a rebuild may change it). */
  sampleRate(): number;
  readonly warnOnce: WarnOnce;
}

/** What `Audio.debug().music`/`musicTotals` read of the core's side (P10 builds the rows from it). P1 fills the values. */
export interface MusicOpsDebugView {
  /** Music rings in use, the pool size and the most ever in use at once. */
  readonly poolUsed: number;
  readonly poolSize: number;
  readonly poolHighWater: number;
  /** Stream event 4 (`musicFull`) count: a bug signal with main's admission (architecture §2.3). */
  readonly musicRingRefused: number;
  /** Live groups: id, state, primed members of `of`. */
  readonly groups: readonly { readonly id: number; readonly state: "admitted" | "priming" | "stamped" | "playing" | "held" | "ending"; readonly primed: number; readonly of: number }[];
}

type GroupState = "admitted" | "priming" | "stamped" | "playing" | "held" | "ending";

/** One member of a live group. */
interface Member {
  readonly index: number;
  readonly path: string;
  readonly streamed: boolean;
  /** The member's stream id (streamed members; allocated at admission), 0 for a decoded one. */
  readonly stream: number;
  /** The epoch main last sent for the stream (R7: only its primed bit counts). */
  epoch: number;
  startFrame: number;
  primed: boolean;
  /** The stream is open on the worker (or about to be) and holds a ring in the pool mirror. */
  ring: boolean;
  /** The member's voice id once stamped, 0 before and after it frees. */
  voice: number;
  handle: CoreVoice | null;
  fadeZero: boolean;
}

/** One live group. */
interface Group {
  readonly id: number;
  readonly instance: number;
  state: GroupState;
  req: MusicGroupRequest;
  readonly members: Member[];
  /** `performance.now()` of the latest `primeGroup` call (Ê's start); NaN before. */
  postedMs: number;
  /** Ê took this prime's sample (or it was skipped while hidden). */
  sampled: boolean;
}

/** The fade law's weight at phase `p` (0..1): the share of `to - from` the ramp has covered (main's estimate). */
function lawWeight(law: number, p: number): number {
  const q = p <= 0 ? 0 : p >= 1 ? 1 : p;
  switch (law) {
    case FadeLaw.SCurve:
      return q * q * (3 - 2 * q);
    case FadeLaw.EqualPowerIn:
      return Math.sin((q * Math.PI) / 2);
    case FadeLaw.EqualPowerOut:
      return 1 - Math.cos((q * Math.PI) / 2);
    default:
      return q;
  }
}

const LAW_CODE: Record<FadeLawName, number> = { linear: FadeLaw.Linear, sCurve: FadeLaw.SCurve, equalPowerIn: FadeLaw.EqualPowerIn, equalPowerOut: FadeLaw.EqualPowerOut };

/** The encoded-cache budget for a pool size (D1a: by the preset whose ring count it is; between presets, the larger). */
export function encodedBudgetBytes(rings: number): number {
  const mib = rings <= MUSIC_RINGS_PRESETS.low ? MUSIC_ENCODED_BUDGET_MIB.low : rings <= MUSIC_RINGS_PRESETS.default ? MUSIC_ENCODED_BUDGET_MIB.default : MUSIC_ENCODED_BUDGET_MIB.high;
  return mib * 1024 * 1024;
}

/** The core's `MusicBackend` (see the header). One per `CoreBackend`. */
export class CoreMusicOps implements MusicBackend {
  readonly caps: MusicBackendCaps = CORE_MUSIC_CAPS;
  onGroupEvent: ((e: MusicGroupEvent) => void) | null = null;

  private readonly groups = new Map<number, Group>();
  private readonly byStream = new Map<number, Member & { group: number }>();
  private readonly byVoice = new Map<number, Member & { group: number }>();
  /** Paths the worker holds for each instance (bytes sent and not refused): Q0's miss rule. */
  private readonly held = new Map<number, Set<string>>();
  /** Group and member events waiting for the next `beginFrame`. */
  private readonly events: MusicGroupEvent[] = [];
  private ema = PRIME_EMA_SEED_MS;
  private ringsUsed = 0;
  private highWater = 0;
  private refusedRings = 0;
  private lastBlocks = -1;
  private subscribed: StreamDecoderLike | null = null;
  private unsubscribe: (() => void)[] = [];
  private readonly sink = { groupStart: (id: number, flags: number, slip: number, frame: number) => this.groupStart(id, flags, slip, frame) };

  constructor(private readonly host: MusicOpsHost) {}

  /** Ê, milliseconds (architecture §4.2): the page-wide prime estimator, seeded at 40 on a new context. */
  get primeEmaMs(): number {
    return this.ema;
  }

  /** A new context (P9 calls it on a rebuild): Ê goes back to its seed. */
  resetPrimeEma(): void {
    this.ema = PRIME_EMA_SEED_MS;
  }

  /** @internal One Ê sample, milliseconds (exposed for tests of the estimator's gains). */
  samplePrime(ms: number): void {
    if (!Number.isFinite(ms)) return;
    const gain = ms > this.ema ? PRIME_EMA_UP : PRIME_EMA_DOWN;
    this.ema = Math.max(0, this.ema + gain * (ms - this.ema));
  }

  // --- MusicBackend (P1) ---

  admitGroup(req: MusicGroupRequest): MusicAdmitResult {
    const existing = this.groups.get(req.group);
    if (existing) return existing.req === req || existing.state === "admitted" ? { ok: true } : { ok: false, reason: "groupTableFull", permanent: false };
    if (!Number.isInteger(req.group) || req.group < 1 || req.group > 1023 || req.members.length === 0) return { ok: false, reason: "neverFits", permanent: true };
    const need = req.members.reduce((n, m) => n + (m.play.stream === true ? 1 : 0), 0);
    const pool = this.host.musicRings();
    if (need > 0 && pool === 0) return { ok: false, reason: "noMusicRings", permanent: true };
    if (need > pool) return { ok: false, reason: "neverFits", permanent: true };
    if (this.groups.size >= MUSIC_GROUP_TABLE) return { ok: false, reason: "groupTableFull", permanent: false };
    if (need > pool - this.ringsUsed) return { ok: false, reason: "poolFull", permanent: false };
    const members: Member[] = req.members.map((m, index) => {
      const streamed = m.play.stream === true;
      return { index, path: m.play.path, streamed, stream: streamed ? this.host.streams.allocate() : 0, epoch: 0, startFrame: m.startFrame, primed: !streamed, ring: streamed, voice: 0, handle: null, fadeZero: m.fadeZero === true };
    });
    const g: Group = { id: req.group, instance: req.instance, state: "admitted", req, members, postedMs: Number.NaN, sampled: true };
    this.groups.set(g.id, g);
    for (const m of members) if (m.streamed) this.byStream.set(m.stream, Object.assign(m, { group: g.id }));
    this.takeRings(need);
    return { ok: true };
  }

  primeGroup(req: MusicGroupRequest, options: { retarget?: boolean; protect?: readonly string[] } = {}): void {
    let g = this.groups.get(req.group);
    if (!g) {
      if (!this.admitGroup(req).ok) return;
      g = this.groups.get(req.group)!;
    }
    const retarget = options.retarget === true && g.state === "priming";
    g.req = req;
    const send: Member[] = [];
    for (const m of g.members) {
      if (!m.streamed) continue;
      const startFrame = req.members[m.index]?.startFrame ?? m.startFrame;
      if (retarget && m.epoch > 0 && startFrame === m.startFrame && m.primed) continue; // unmoved: keeps its epoch
      m.startFrame = startFrame;
      m.epoch = (m.epoch % RING_EPOCH_MASK) + 1;
      m.primed = false;
      send.push(m);
    }
    g.state = "priming";
    g.postedMs = performance.now();
    g.sampled = false;
    if (send.length === 0) return;
    this.post(g, send, retarget, options.protect);
  }

  primedState(group: number): MusicPrimedState | null {
    const g = this.groups.get(group);
    if (!g) return null;
    let primed = 0;
    for (const m of g.members) if (m.primed) primed++;
    const of = g.members.length;
    return { group, primed, of, ready: primed === of };
  }

  stampGroup(stamp: MusicGroupStamp): (AudioVoice | null)[] {
    const g = this.groups.get(stamp.group);
    if (!g || (g.state !== "admitted" && g.state !== "priming")) return [];
    g.state = "stamped";
    const voices: (CoreVoice | null)[] = [];
    // Every PLAY first, back to back (one frame, one gate: one BATCH), then the first fades.
    for (const m of g.members) {
      const def = g.req.members[m.index]!;
      const req: CorePlayRequest = { ...def.play, at: stamp.at, music: m.streamed ? { group: g.id, member: m.index, stream: m.stream } : { group: g.id, member: m.index } };
      const v = this.host.play(req);
      m.handle = v;
      voices.push(v);
    }
    if (stamp.fades) {
      for (const { member, fade } of stamp.fades) {
        const v = voices[member];
        if (v) this.fadeShaped(v.id, { ...fade, at: fade.at ?? stamp.at });
      }
    }
    return voices;
  }

  cancelGroup(group: number): void {
    const g = this.groups.get(group);
    if (!g) return;
    const decoder = this.subscribed ?? this.tryDecoder();
    let open = false;
    for (const m of g.members) {
      if (m.voice !== 0) {
        this.byVoice.delete(m.voice);
        m.handle?.stop(0.005);
      }
      if (m.streamed) {
        this.byStream.delete(m.stream);
        if (m.ring) {
          open = true;
          this.releaseRing(m);
          if (m.voice !== 0) decoder?.closeStream(m.stream);
        }
      }
      m.voice = 0;
      m.handle = null;
    }
    if (open) decoder?.cancelGroup?.(group);
    this.groups.delete(group);
  }

  releaseInstance(instance: number): void {
    this.held.delete(instance);
    this.tryDecoder()?.releaseMusic?.(instance);
  }

  protect(instance: number, paths: readonly string[]): void {
    this.tryDecoder()?.protectMusic?.(instance, paths);
  }

  // --- Hooks from coreBackend.ts and streams.ts ---

  /**
   * Reads this frame's STATUS music sections (once per new STATUS) and delivers the group events through
   * `onGroupEvent`. The second call in a frame finds nothing new.
   */
  beginFrame(): void {
    const mirror = this.host.mirror;
    if (mirror.blocks !== this.lastBlocks) {
      this.lastBlocks = mirror.blocks;
      if (this.groups.size > 0) this.readRings();
      mirror.drainGroupStarts(this.sink);
    }
    if (this.events.length === 0) return;
    const out = this.events.splice(0);
    const fn = this.onGroupEvent;
    if (!fn) return;
    for (const e of out) fn(e);
  }

  ownsVoice(id: number): boolean {
    return this.byVoice.has(id);
  }

  ownsStream(id: number): boolean {
    return this.byStream.has(id);
  }

  adoptMember(id: number, i: number, tag: MusicMemberTag): void {
    const m = this.groups.get(tag.group)?.members[tag.member];
    if (!m) return;
    m.voice = id;
    this.byVoice.set(id, m as Member & { group: number });
    (m as Member & { group: number }).group = tag.group;
    this.host.table.musicGroup[i] = tag.group;
    // PLAY's `fadeZero` (§4.1): the voice starts with its `fade` ramp at 0; the mirror says so (selection, REPLAY).
    if (m.fadeZero) this.host.table.fadeGain[i] = 0;
  }

  decoratePlay(id: number, i: number, args: PlayArgs): void {
    void i;
    const m = this.byVoice.get(id);
    if (!m) {
      args.gate = 0;
      args.fadeZero = false;
      return;
    }
    const g = this.groups.get(m.group);
    args.gate = g ? packGate(g.id, g.members.length) : 0;
    args.fadeZero = m.fadeZero;
    args.startOffsetFrames = m.startFrame;
  }

  memberFreed(id: number, i: number): void {
    const m = this.byVoice.get(id);
    if (!m) return;
    this.byVoice.delete(id);
    this.host.table.musicGroup[i] = 0;
    m.voice = 0;
    m.handle = null;
    if (m.streamed) {
      this.byStream.delete(m.stream);
      if (m.ring) {
        this.releaseRing(m);
        this.tryDecoder()?.closeStream(m.stream);
      }
    }
    const g = this.groups.get(m.group);
    if (!g) return;
    this.events.push({ kind: "end", group: g.id, member: m.index });
    if (g.members.every((x) => x.voice === 0)) this.groups.delete(g.id);
  }

  fadeShaped(id: number, f: ShapedFade): void {
    const t = this.host.table;
    if (!t.isLive(id) || !this.host.sending()) return;
    const i = id & 0xffff;
    const clock = this.host.clockMap;
    const law = LAW_CODE[f.law] ?? FadeLaw.Linear;
    const to = Math.min(4, Math.max(0, Number.isFinite(f.to) ? f.to : 0));
    const seconds = Number.isFinite(f.seconds) ? Math.max(0, f.seconds) : 0;
    const u0 = Math.min(1, Math.max(0, f.startPhase ?? 0));
    const stopAtEnd = f.stopAtEnd === true;
    const stamp = f.at !== undefined && Number.isFinite(f.at) ? clock.stampFor(clock.frameOfTime(f.at)) : undefined;
    const now = clock.framesNow();
    const applyAt = stamp ?? now + clock.lookaheadFrames();
    // The level the ramp starts from (Z4: REPLAY restores it): the fade ramp's value at `applyAt` from the log.
    const from = this.fadeLevelAt(i, applyAt);
    this.host.writer.fadeShaped(id, to, seconds, law, u0, stamp, stopAtEnd);
    t.logStamped(id, StampedKind.FADE, applyAt, clock.sampleRate, now, from, to, seconds, packShape(law, Math.min(65535, Math.round(u0 * 65536))), stopAtEnd ? STAMPED_FLAG_STOP_AT_END : 0);
    t.fadeGain[i] = to;
  }

  onStreamEvent(id: number, code: number): void {
    if (code === StreamEvent.MusicFull) this.refusedRings++;
    const m = this.byStream.get(id);
    if (!m) return;
    if (code === StreamEvent.MusicFull) {
      this.events.push({ kind: "refused", group: m.group, member: m.index, reason: "musicFull" });
      if (m.ring) this.releaseRing(m);
    } else if (code === StreamEvent.Starved) this.events.push({ kind: "starve", group: m.group, member: m.index });
    else if (code === StreamEvent.Error) this.events.push({ kind: "error", group: m.group, member: m.index, message: "stream error" });
  }

  /** P9: a hard rebuild (or a new decoder worker): reopen every live music group as a group (`music/background.ts`). */
  reopenGroups(): void {
    // STUB(P9)
  }

  debugView(): MusicOpsDebugView {
    const groups: MusicOpsDebugView["groups"][number][] = [];
    for (const g of this.groups.values()) {
      const s = this.primedState(g.id)!;
      groups.push({ id: g.id, state: g.state, primed: s.primed, of: s.of });
    }
    return { poolUsed: this.ringsUsed, poolSize: this.host.musicRings(), poolHighWater: this.highWater, musicRingRefused: this.refusedRings, groups };
  }

  /** The backend was disposed: every group closes. */
  dispose(): void {
    for (const id of [...this.groups.keys()]) this.cancelGroup(id);
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
    this.subscribed = null;
    this.events.length = 0;
    this.onGroupEvent = null;
  }

  // --- Internals ---

  private takeRings(n: number): void {
    this.ringsUsed += n;
    if (this.ringsUsed > this.highWater) this.highWater = this.ringsUsed;
  }

  private releaseRing(m: Member): void {
    m.ring = false;
    this.ringsUsed = Math.max(0, this.ringsUsed - 1);
  }

  private tryDecoder(): StreamDecoderLike | null {
    try {
      return this.host.decoder();
    } catch {
      return null;
    }
  }

  /** The decoder connected to the current worklet, with musicOps's replies subscribed. */
  private connect(): StreamDecoderLike {
    const decoder = this.host.worklet.ensure();
    if (this.subscribed !== decoder) {
      for (const u of this.unsubscribe) u();
      this.subscribed = decoder;
      this.unsubscribe = [decoder.onStream((r) => this.onStreamReply(r))];
      if (decoder.onMusic) this.unsubscribe.push(decoder.onMusic((r) => this.onMusicReply(r)));
    }
    return decoder;
  }

  /**
   * Posts one `primeGroup` for `send` (a group's members, in member order): bytes go with a member whose path the worker
   * doesn't hold for the instance (fetched first, all before the one post, so the group stays one message).
   */
  private post(g: Group, send: Member[], retarget: boolean, protect: readonly string[] | undefined, forceBytes = false): void {
    if (!this.host.sending()) return;
    let decoder: StreamDecoderLike;
    try {
      decoder = this.connect();
    } catch (err) {
      this.host.warnOnce(`music:decoder`, `audio: music can't reach the decoder: ${String(err)}`);
      return;
    }
    if (!decoder.primeGroup) return;
    const held = this.held.get(g.instance) ?? new Set<string>();
    this.held.set(g.instance, held);
    const fetch = send.filter((m) => forceBytes || !held.has(m.path));
    const paths = [...new Set(fetch.map((m) => m.path))];
    const epochs = send.map((m) => m.epoch);
    const finish = (bytes: Map<string, ArrayBuffer>): void => {
      if (this.groups.get(g.id) !== g || g.state !== "priming") return; // cancelled or stamped meanwhile
      // A newer prime of these members supersedes this one.
      if (send.some((m, k) => m.epoch !== epochs[k])) return;
      const members: PrimeGroupMember[] = [];
      for (const m of send) {
        if (!m.ring) continue;
        const def = g.req.members[m.index]!;
        const b = bytes.get(m.path);
        members.push({
          streamId: m.stream,
          epoch: m.epoch,
          asset: m.path,
          ...(b ? { bytes: b.slice(0) } : {}),
          hint: hintFromName(m.path),
          startFrame: m.startFrame,
          loop: def.loop,
          ...(def.loop ? { loopStartFrame: def.loopStartFrame ?? 0, loopEndFrame: def.loopEndFrame ?? 0 } : {}),
          music: true,
        });
        if (b) held.add(m.path);
      }
      if (members.length === 0) return;
      decoder.primeGroup!({ instance: g.instance, group: g.id, retarget, members, ...(protect ? { protect } : {}), budgetBytes: encodedBudgetBytes(this.host.musicRings()) });
    };
    if (paths.length === 0) return finish(new Map());
    Promise.all(paths.map((p) => this.host.fetchBytes(p).then((b) => [p, b] as const))).then(
      (pairs) => finish(new Map(pairs)),
      (err) => {
        if (this.groups.get(g.id) !== g) return;
        for (const m of send) this.events.push({ kind: "error", group: g.id, member: m.index, message: `audio: music stem fetch failed: ${String(err)}` });
      },
    );
  }

  private onMusicReply(r: MusicReply): void {
    if (r.type !== "needBytes") return; // groupOpened: diagnostics only
    const g = this.groups.get(r.group);
    if (!g || g.state !== "priming") return;
    const held = this.held.get(g.instance);
    const send: Member[] = [];
    for (const want of r.members) {
      const m = this.byStream.get(want.streamId);
      if (!m || m.group !== g.id) continue;
      held?.delete(m.path);
      send.push(m);
    }
    if (send.length > 0) this.post(g, send, false, undefined, true);
  }

  private onStreamReply(r: StreamReply): void {
    if (r.type !== "error") return;
    const m = this.byStream.get(r.streamId);
    if (!m) return;
    this.events.push({ kind: "error", group: m.group, member: m.index, message: r.message });
  }

  /** The `musicRings` level into members' primed bits (current epoch only, R7), then Ê for groups now ready. */
  private readRings(): void {
    const mirror = this.host.mirror;
    for (let k = 0; k < mirror.musicRingCount; k++) {
      const m = this.byStream.get(mirror.musicRingStream[k]!);
      if (!m || m.primed) continue;
      const ef = mirror.musicRingEpochFlags[k]!;
      if ((ef & RING_PRIMED) !== 0 && (ef & RING_EPOCH_MASK) === m.epoch) m.primed = true;
    }
    const hidden = mirror.freeEndedInMessage;
    for (const g of this.groups.values()) {
      if (g.state !== "priming" || g.sampled || !g.members.every((m) => m.primed)) continue;
      g.sampled = true;
      if (!hidden) this.samplePrime(performance.now() - g.postedMs);
    }
  }

  private groupStart(id: number, flags: number, slipFrames: number, startFrame: number): void {
    const g = this.groups.get(id);
    const late = (flags & 1) !== 0;
    const kind = (flags & 4) !== 0 ? "abandon" : (flags & 2) !== 0 ? "resume" : "start";
    if (g) g.state = kind === "abandon" ? "ending" : "playing";
    this.events.push({ kind, group: id, late, slipFrames, startFrame });
  }

  /** The `fade` ramp's level at frame `at` from the voice's stamped log; with no entry the mirror's `fadeGain`. */
  private fadeLevelAt(i: number, at: number): number {
    const t = this.host.table;
    const n = t.stampedCount[i]!;
    let level = t.fadeGain[i]!;
    for (let k = n - 1; k >= 0; k--) {
      const e = i * MAX_STAMPED + k;
      if (t.stampedKind[e] !== StampedKind.FADE || t.stampedFrame[e]! > at) continue;
      const start = t.stampedFrame[e]!;
      const end = t.stampedEnd[e]!;
      const from = t.stampedFrom[e]!;
      const to = t.stampedTo[e]!;
      if (end <= at || end <= start) level = to;
      else {
        const shape = t.stampedShape[e]!;
        const u0 = (shape >>> 16) / 65536;
        const p = u0 + (1 - u0) * ((at - start) / (end - start));
        // The ramp starts at law(u0): rescale so the covered share runs from law(u0) to 1.
        const w0 = lawWeight(shape & 7, u0);
        const w = lawWeight(shape & 7, p);
        level = from + (to - from) * (w0 >= 1 ? 1 : (w - w0) / (1 - w0));
      }
      break;
    }
    return level;
  }
}
