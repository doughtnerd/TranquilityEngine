// Per-voice effects staging on main (ADR 0162; contracts S3, C3, C20; api-and-models §3.2 `lpHz`, `lpBy`, `hpHz`,
// `sendLevel`, `sentSend`, `auxBus`, `auxLevel`, `yaw`). The features set targets (occlusion, zones, events, beds,
// ambisonic voices); this file merges them, decides what moved enough to send, and writes it once per frame, so no
// feature writes SET_VOICE_FX or a voice's lpHz itself.
//
// - **Low-pass (S3):** main owns `lpHz`, the lowest of the occlusion cutoff, the event's static low-pass and the
//   sharing-chain snapshot low-pass main folds; `lowpassBy` names the winner (`lpBy`, for the debug panel). A
//   contribution at or above `LP_TOP` (20,000 Hz) is no low-pass; with none left the voice's lpHz is `BUS_LP_OFF_HZ`
//   (what PLAY carried in M2). The value goes into the table's `lpHz` at once (PLAY and SET_MIXED carry it) and to a
//   mixed voice as SET_PARAMS with only the `lpHz` bit. The core folds gains only (S3): automation's low-pass stays the
//   core's.
// - **SET_VOICE_FX (C3):** high-pass, the four zone sends, yaw, and the aux send live in the core's mixed-voice pool;
//   virtual voices hold none. Sent after PLAY (stamped at its frame) and with SET_MIXED on promotion, when
//   non-default; afterwards on a change past 0.5 dB (levels), 1 Hz (cutoffs) or 0.001 rad (yaw), one record per voice
//   per frame carrying the mask of what moved.
// - **Promotion (C20):** send, high-pass, yaw and aux targets are re-sent with SET_MIXED; a demotion forgets what the
//   core held (its pool entry is gone), so the next promotion sends again.
//
// Everything is preallocated in the constructor; staging and flushing allocate nothing.
import { BUS_LP_OFF_HZ, AUX_BUS_NONE, LP_TOP } from "../wire.generated";
import type { CommandWriter, VoiceFxArgs } from "./commandWriter";
import type { ReplayBuilder } from "./replay";

/** @internal Who set a voice's low-pass (`lpBy`, S3): the lowest contribution wins. */
export const LowpassBy = {
  NONE: 0,
  /** Main's occlusion cutoff (D2a). */
  OCCLUSION: 1,
  /** The event's static `filter.lowpass` or a one-shot's `lowpass` (D4). */
  EVENT: 2,
  /** The sharing-chain snapshot low-pass main folds for a voice mixed into another bus's bed (A5, S3). */
  SNAPSHOT: 3,
} as const;
export type LowpassByCode = (typeof LowpassBy)[keyof typeof LowpassBy];
/** @internal How many low-pass sources a voice merges (`LowpassBy` minus NONE). */
export const LOWPASS_SOURCES = 3;

/** @internal C3: a send or aux level is re-sent when it moves more than this, dB. */
export const FX_LEVEL_DB_THRESHOLD = 0.5;
/** @internal C3: a cutoff (lpHz, hpHz) is re-sent when it moves more than this, Hz. */
export const FX_HZ_THRESHOLD = 1;
/** @internal C3: yaw is re-sent when it moves more than this, radians. */
export const FX_YAW_THRESHOLD = 0.001;
/** @internal C3: zone send slots per voice (`MAX_ZONE_SLOTS`). */
export const FX_SENDS = 4;

/** @internal What `VoiceFx` reads of the voice table: ids, states (only PLAYING voices are sent anything) and the `lpHz` it writes. */
export interface VoiceFxTable {
  readonly capacity: number;
  readonly gen: Uint16Array;
  readonly state: Uint8Array;
  readonly lpHz: Float32Array;
}

/** @internal What `VoiceFx` writes through (K1's command writer). */
export type VoiceFxWriter = Pick<CommandWriter, "setVoiceFx" | "setParams">;

/** @internal The per-voice fx staging over one voice table (constructed by the core backend). */
export class VoiceFx {
  /** Per slot and source (`LowpassBy` − 1): the low-pass asked for, Hz (`LP_TOP` and above: none). */
  private readonly lpBySource: Float32Array;
  /** Per slot: the winning source (`LowpassBy`). */
  private readonly lpWinner: Uint8Array;
  /** Per slot: the lpHz last sent to the core (PLAY, SET_MIXED or SET_PARAMS). */
  private readonly sentLp: Float32Array;
  /** Per slot: targets. */
  private readonly hp: Float32Array;
  private readonly send4: Float32Array;
  private readonly yawRad: Float32Array;
  private readonly auxBusOf: Uint16Array;
  private readonly auxLevelOf: Float32Array;
  /** Per slot: what the core's pool holds (C3's defaults while virtual or never sent). */
  private readonly sentHp: Float32Array;
  private readonly sentSend4: Float32Array;
  private readonly sentYaw: Float32Array;
  private readonly sentAuxBus: Uint16Array;
  private readonly sentAuxLevel: Float32Array;
  /** Slots with a target changed since the last `flush` (`dirtyTop` valid; `listed[i]` 1 while listed). */
  private readonly dirtyList: Uint16Array;
  private readonly listed: Uint8Array;
  private dirtyTop = 0;
  /** The record `setVoiceFx` copies from (reused). */
  private readonly args: VoiceFxArgs;

  constructor(
    readonly table: VoiceFxTable,
    private readonly writer: VoiceFxWriter,
  ) {
    const n = table.capacity;
    this.lpBySource = new Float32Array(n * LOWPASS_SOURCES).fill(LP_TOP);
    this.lpWinner = new Uint8Array(n);
    this.sentLp = new Float32Array(n).fill(BUS_LP_OFF_HZ);
    this.hp = new Float32Array(n);
    this.send4 = new Float32Array(n * FX_SENDS);
    this.yawRad = new Float32Array(n);
    this.auxBusOf = new Uint16Array(n).fill(AUX_BUS_NONE);
    this.auxLevelOf = new Float32Array(n);
    this.sentHp = new Float32Array(n);
    this.sentSend4 = new Float32Array(n * FX_SENDS);
    this.sentYaw = new Float32Array(n);
    this.sentAuxBus = new Uint16Array(n).fill(AUX_BUS_NONE);
    this.sentAuxLevel = new Float32Array(n);
    this.dirtyList = new Uint16Array(n);
    this.listed = new Uint8Array(n);
    this.args = { voiceId: 0, mask: 0, rampFrames: 0, hpHz: 0, send: new Float32Array(FX_SENDS), yaw: 0, auxLevel: 0, auxBus: AUX_BUS_NONE };
  }

  // --- Targets (the features call these; each marks the slot for the next `flush`) ---

  /**
   * Slot `i`'s low-pass from `by` (not NONE), Hz; `LP_TOP` or above (or non-finite) removes it. Recomputes the lowest
   * contribution and its source, and writes it into `table.lpHz[i]` at once (`BUS_LP_OFF_HZ` with none).
   */
  setLowpass(i: number, by: LowpassByCode, hz: number): void {
    void i; void by; void hz; // L-K4a
  }

  /** Slot `i`'s high-pass, Hz; `HP_BOTTOM` (20) or less is off. */
  setHighpass(i: number, hz: number): void {
    void i; void hz; // L-K4a
  }

  /** Slot `i`'s send into zone slot `slot` (0..3), linear, pre-distance (C3: main folds volume, curve, weight and wet factor). */
  setSend(i: number, slot: number, level: number): void {
    void i; void slot; void level; // L-K4a
  }

  /** Slot `i`'s yaw, radians (ambisonic voices). */
  setYaw(i: number, rad: number): void {
    void i; void rad; // L-K4a
  }

  /** Slot `i`'s aux send: bus index and linear level (`AUX_BUS_NONE` or level 0: none). */
  setAux(i: number, bus: number, level: number): void {
    void i; void bus; void level; // L-K4a
  }

  // --- Reads (debug, replay, tests) ---

  /** Slot `i`'s merged low-pass target, Hz (`BUS_LP_OFF_HZ` with no contribution). */
  lowpass(i: number): number {
    void i; // L-K4a
    return BUS_LP_OFF_HZ;
  }

  /** Who set slot `i`'s low-pass (`LowpassBy.NONE` with none). */
  lowpassBy(i: number): LowpassByCode {
    void i; // L-K4a
    return LowpassBy.NONE;
  }

  /** Slot `i`'s targets as C3 carries them. */
  highpass(i: number): number {
    void i; // L-K4a
    return 0;
  }
  send(i: number, slot: number): number {
    void i; void slot; // L-K4a
    return 0;
  }
  yaw(i: number): number {
    void i; // L-K4a
    return 0;
  }
  auxBus(i: number): number {
    void i; // L-K4a
    return AUX_BUS_NONE;
  }
  auxLevel(i: number): number {
    void i; // L-K4a
    return 0;
  }

  /** True while slot `i`'s SET_VOICE_FX targets are C3's defaults (high-pass off, sends 0, yaw 0, no aux): nothing to send. */
  isDefault(i: number): boolean {
    void i; // L-K4a
    return true;
  }

  // --- Sending ---

  /**
   * The frame's fx staging (after selection and the panner pick): for each slot changed since the last flush, a mixed
   * (PLAYING) voice gets SET_PARAMS `lpHz` when it moved more than 1 Hz from what was sent, and one SET_VOICE_FX with the
   * mask of the fields past their thresholds (hpHz 1 Hz, any send 0.5 dB, yaw 0.001 rad, aux bus changed or level
   * 0.5 dB), over `rampFrames`, asap. A virtual voice is sent nothing (its targets wait for its promotion). Clears the list.
   */
  flush(rampFrames: number): void {
    void rampFrames; // L-K4a
  }

  /**
   * Slot `i`'s PLAY went out (`atFrame`: its stamp, or asap when omitted). The PLAY carried `table.lpHz[i]`; if the voice
   * started mixed and its targets aren't default, SET_VOICE_FX follows at the same frame with every non-default field.
   */
  onPlay(i: number, atFrame?: number): void {
    void i; void atFrame; // L-K4a
  }

  /** Selection promoted slot `i` (its SET_MIXED carried `table.lpHz[i]`): every non-default target is re-sent (C20). */
  onPromote(i: number): void {
    void i; // L-K4a
  }

  /** Slot `i` went virtual (selection, or the core's demote): the core's pool entry is gone, so what was sent resets to the defaults. */
  onDemote(i: number): void {
    void i; // L-K4a
  }

  /** Slot `i` was freed: every target and sent value back to its default, unlisted. */
  forget(i: number): void {
    void i; // L-K4a
  }

  /**
   * A hard rebuild replays voice `id` (slot `i`) mixed: right after its PLAY in the REPLAY, a SET_VOICE_FX (asap) with
   * every non-default field, and the sent values follow. Nothing for a default voice.
   */
  replayVoice(b: ReplayBuilder, id: number, i: number): void {
    void b; void id; void i; // L-K4a
  }
}

/** @internal C3's level threshold: whether `next` differs from `sent` by more than 0.5 dB (a change from or to 0 always does). */
export function levelMoved(next: number, sent: number): boolean {
  void next; void sent; // L-K4a
  return false;
}
