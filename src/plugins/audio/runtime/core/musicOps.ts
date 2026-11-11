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
// The hooks `coreBackend.ts` calls, each a no-op until its owner fills it:
// - `beginFrame()` from `CoreBackend.beginFrame` (step 0) and `frameAttenuate`: this frame's STATUS music sections and
//   group events (delivered through `onGroupEvent` after the status mirror is read);
// - `ownsVoice(id)`, `adoptMember`, `decoratePlay`, `memberFreed` from the voice path: a group member is an ordinary voice
//   whose stream (if streamed) musicOps opened and primed, so the stream manager never opens or closes it, and whose PLAY
//   carries the gate;
// - `fadeShaped(id, f)` from `Voice.fadeShaped` (§4.2: a FADE on the `fade` ramp with a law, `u0`, a stamp);
// - `onStreamEvent(id, code)` from `streams.ts`: stream event 4 (`musicFull`) and every event of a music member's stream;
// - `ownsStream(id)` from `streams.ts`: which stream ids are music members';
// - `reopenGroups()` from `reopenStreams` after a hard rebuild (music voices skipped there).
import type { MusicAdmitResult, MusicBackend, MusicBackendCaps, MusicGroupEvent, MusicGroupRequest, MusicGroupStamp, MusicPrimedState, AudioVoice, ShapedFade } from "../backend";
import type { CommandWriter, PlayArgs } from "./commandWriter";
import type { ClockMap } from "./clock";
import type { StatusMirror } from "./mirror";
import type { StreamDecoderLike, StreamManager } from "./streams";
import type { VoiceTable } from "./voiceTable";
import type { WorkletChannel } from "./workletChannel";
import type { WarnOnce } from "./codecs";
import type { CorePlayRequest, CoreVoice } from "./coreBackend";

/** Ê's seed on a new context, milliseconds (architecture §4.1). */
export const PRIME_EMA_SEED_MS = 40;

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

const EMPTY_DEBUG: MusicOpsDebugView = Object.freeze({ poolUsed: 0, poolSize: 0, poolHighWater: 0, musicRingRefused: 0, groups: Object.freeze([]) });

/** The core's `MusicBackend` (see the header). One per `CoreBackend`. */
export class CoreMusicOps implements MusicBackend {
  readonly caps: MusicBackendCaps = CORE_MUSIC_CAPS;
  onGroupEvent: ((e: MusicGroupEvent) => void) | null = null;

  constructor(private readonly host: MusicOpsHost) {}

  /** Ê, milliseconds (architecture §4.2): the page-wide prime estimator, seeded at 40 on a new context. */
  get primeEmaMs(): number {
    return PRIME_EMA_SEED_MS; // STUB(P1)
  }

  // --- MusicBackend (P1) ---

  admitGroup(req: MusicGroupRequest): MusicAdmitResult {
    void req;
    void this.host;
    return { ok: false, reason: "noMusicRings", permanent: true }; // STUB(P1)
  }

  primeGroup(req: MusicGroupRequest, options?: { retarget?: boolean; protect?: readonly string[] }): void {
    void req;
    void options;
    // STUB(P1)
  }

  primedState(group: number): MusicPrimedState | null {
    void group;
    return null; // STUB(P1)
  }

  stampGroup(stamp: MusicGroupStamp): (AudioVoice | null)[] {
    void stamp;
    return []; // STUB(P1): one entry per member
  }

  cancelGroup(group: number): void {
    void group;
    // STUB(P1)
  }

  releaseInstance(instance: number): void {
    void instance;
    // STUB(P1)
  }

  protect(instance: number, paths: readonly string[]): void {
    void instance;
    void paths;
    // STUB(P1)
  }

  // --- Hooks from coreBackend.ts and streams.ts ---

  /**
   * P1: read this frame's STATUS music sections and deliver group events through `onGroupEvent`. Called by
   * `CoreBackend.beginFrame` (step 0, only while music plays) and again by every `frameAttenuate`: the second call in a
   * frame must find nothing new (e.g. track `mirror.blocks`).
   */
  beginFrame(): void {
    // STUB(P1)
  }

  /** P1: true when voice `id` is a music group member. Called per freed voice and per PLAY: keep it O(1). */
  ownsVoice(id: number): boolean {
    void id;
    return false; // STUB(P1)
  }

  /** P1: true when stream id `id` belongs to a music member (its STATUS events come to `onStreamEvent`). */
  ownsStream(id: number): boolean {
    void id;
    return false; // STUB(P1)
  }

  /** P1: `CoreBackend.play` made voice `id` (slot `i`) for a member carrying `tag`. */
  adoptMember(id: number, i: number, tag: MusicMemberTag): void {
    void id;
    void i;
    void tag;
    // STUB(P1)
  }

  /**
   * P1: every PLAY (`sendPlay`) is about to be written: set a member's gate (and `fadeZero`) on `args`, and clear them for
   * any other voice (`args` is the backend's one reused object). Called per PLAY: keep it O(1).
   */
  decoratePlay(id: number, i: number, args: PlayArgs): void {
    void id;
    void i;
    void args;
    // STUB(P1)
  }

  /** P1: member voice `id` (slot `i`) was freed: close a streamed member's ring through the worker, forget it. */
  memberFreed(id: number, i: number): void {
    void id;
    void i;
    // STUB(P1)
  }

  /** P1: `AudioVoice.fadeShaped` on voice `id` (§4.2): a stamped FADE (or STOP) with a law and start phase on the `fade` ramp. */
  fadeShaped(id: number, f: ShapedFade): void {
    void id;
    void f;
    // STUB(P1)
  }

  /** P1: a STATUS stream event of a music member's stream, or stream event 4 (`musicFull`) for any stream. */
  onStreamEvent(id: number, code: number): void {
    void id;
    void code;
    // STUB(P1)
  }

  /** P9: a hard rebuild (or a new decoder worker): reopen every live music group as a group (`music/background.ts`). */
  reopenGroups(): void {
    // STUB(P9)
  }

  /** P1: what `Audio.debug()` reads of the core's side (P10 builds the rows). */
  debugView(): MusicOpsDebugView {
    return EMPTY_DEBUG; // STUB(P1)
  }

  /** The backend was disposed. P1: close every group. */
  dispose(): void {
    this.onGroupEvent = null;
  }
}
