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
import {
  ASAP,
  AUX_BUS_NONE,
  BUS_LP_OFF_HZ,
  HP_BOTTOM,
  LP_TOP,
  SET_PARAMS_MASK_LP_HZ,
  SET_VOICE_FX_FIXED_END,
  SET_VOICE_FX_MASK_AUX,
  SET_VOICE_FX_MASK_HP_HZ,
  SET_VOICE_FX_MASK_SENDS,
  SET_VOICE_FX_MASK_YAW,
  writeSetVoiceFx,
  type SetVoiceFx,
} from "../wire.generated";
import type { CommandWriter, VoiceFxArgs } from "./commandWriter";
import { encodeVoiceId } from "./ids";
import type { ReplayBuilder } from "./replay";
import { VoiceState } from "./voiceTable";

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
  /** The REPLAY record `replayVoice` writes (reused) and its writer (one closure, made once). */
  private readonly replayRec: SetVoiceFx = {
    voiceId: 0,
    frameOffset: ASAP,
    mask: 0,
    rampFrames: 0,
    hpHz: 0,
    send: [0, 0, 0, 0],
    yaw: 0,
    auxLevel: 0,
    auxBus: AUX_BUS_NONE,
    reserved: 0,
  };
  private readonly replayWrite = (view: DataView, off: number): number => writeSetVoiceFx(view, off, this.replayRec);

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
    if (by < LowpassBy.OCCLUSION || by > LOWPASS_SOURCES) return;
    const base = i * LOWPASS_SOURCES;
    this.lpBySource[base + by - 1] = Number.isFinite(hz) && hz < LP_TOP ? hz : LP_TOP;
    let best = LP_TOP;
    let winner: LowpassByCode = LowpassBy.NONE;
    for (let s = 0; s < LOWPASS_SOURCES; s++) {
      const v = this.lpBySource[base + s]!;
      if (v < best) {
        best = v;
        winner = (s + 1) as LowpassByCode;
      }
    }
    this.lpWinner[i] = winner;
    this.table.lpHz[i] = winner === LowpassBy.NONE ? BUS_LP_OFF_HZ : best;
    this.mark(i);
  }

  /** Slot `i`'s high-pass, Hz; `HP_BOTTOM` (20) or less is off (stored as 0, the default). */
  setHighpass(i: number, hz: number): void {
    this.hp[i] = Number.isFinite(hz) && hz > HP_BOTTOM ? hz : 0;
    this.mark(i);
  }

  /** Slot `i`'s send into zone slot `slot` (0..3), linear, pre-distance (C3: main folds volume, curve, weight and wet factor). */
  setSend(i: number, slot: number, level: number): void {
    if (slot < 0 || slot >= FX_SENDS) return;
    this.send4[i * FX_SENDS + slot] = Number.isFinite(level) && level > 0 ? level : 0;
    this.mark(i);
  }

  /** Slot `i`'s yaw, radians (ambisonic voices). */
  setYaw(i: number, rad: number): void {
    this.yawRad[i] = Number.isFinite(rad) ? rad : 0;
    this.mark(i);
  }

  /** Slot `i`'s aux send: bus index and linear level (`AUX_BUS_NONE` or level 0: none). */
  setAux(i: number, bus: number, level: number): void {
    const on = bus !== AUX_BUS_NONE && Number.isFinite(level) && level > 0;
    this.auxBusOf[i] = on ? bus : AUX_BUS_NONE;
    this.auxLevelOf[i] = on ? level : 0;
    this.mark(i);
  }

  // --- Reads (debug, replay, tests) ---

  /** Slot `i`'s merged low-pass target, Hz (`BUS_LP_OFF_HZ` with no contribution). */
  lowpass(i: number): number {
    const w = this.lpWinner[i]!;
    return w === LowpassBy.NONE ? BUS_LP_OFF_HZ : this.lpBySource[i * LOWPASS_SOURCES + w - 1]!;
  }

  /** Who set slot `i`'s low-pass (`LowpassBy.NONE` with none). */
  lowpassBy(i: number): LowpassByCode {
    return this.lpWinner[i]! as LowpassByCode;
  }

  /** Slot `i`'s targets as C3 carries them. */
  highpass(i: number): number {
    return this.hp[i]!;
  }
  send(i: number, slot: number): number {
    return this.send4[i * FX_SENDS + slot]!;
  }
  yaw(i: number): number {
    return this.yawRad[i]!;
  }
  auxBus(i: number): number {
    return this.auxBusOf[i]!;
  }
  auxLevel(i: number): number {
    return this.auxLevelOf[i]!;
  }

  /** True while slot `i`'s SET_VOICE_FX targets are C3's defaults (high-pass off, sends 0, yaw 0, no aux): nothing to send. */
  isDefault(i: number): boolean {
    return this.activeMask(i) === 0;
  }

  // --- Sending ---

  /**
   * The frame's fx staging (after selection and the panner pick): for each slot changed since the last flush, a mixed
   * (PLAYING) voice gets SET_PARAMS `lpHz` when it moved more than 1 Hz from what was sent, and one SET_VOICE_FX with the
   * mask of the fields past their thresholds (hpHz 1 Hz, any send 0.5 dB, yaw 0.001 rad, aux bus changed or level
   * 0.5 dB), over `rampFrames`, asap. A virtual voice is sent nothing (its targets wait for its promotion). Clears the list.
   */
  flush(rampFrames: number): void {
    const t = this.table;
    for (let k = 0; k < this.dirtyTop; k++) {
      const i = this.dirtyList[k]!;
      this.listed[i] = 0;
      if (t.state[i] !== VoiceState.PLAYING) continue;
      if (Math.abs(t.lpHz[i]! - this.sentLp[i]!) > FX_HZ_THRESHOLD) {
        this.writer.setParams(encodeVoiceId(i, t.gen[i]!), SET_PARAMS_MASK_LP_HZ, 0, 0, 0, 0, 0, t.lpHz[i]!, rampFrames);
        this.sentLp[i] = t.lpHz[i]!;
      }
      const mask = this.movedMask(i);
      if (mask !== 0) {
        this.writer.setVoiceFx(this.fillArgs(i, mask, rampFrames));
        this.commit(i, mask);
      }
    }
    this.dirtyTop = 0;
  }

  /**
   * Slot `i`'s PLAY went out (`atFrame`: its stamp, or asap when omitted). The PLAY carried `table.lpHz[i]`; if the voice
   * started mixed and its targets aren't default, SET_VOICE_FX follows at the same frame with every non-default field.
   */
  onPlay(i: number, atFrame?: number): void {
    this.resetSent(i);
    this.sentLp[i] = this.table.lpHz[i]!;
    if (this.table.state[i] === VoiceState.PLAYING) this.sendActive(i, atFrame);
  }

  /** Selection promoted slot `i` (its SET_MIXED carried `table.lpHz[i]`): every non-default target is re-sent (C20). */
  onPromote(i: number): void {
    this.resetSent(i);
    this.sentLp[i] = this.table.lpHz[i]!;
    this.sendActive(i, undefined);
  }

  /** Slot `i` went virtual (selection, or the core's demote): the core's pool entry is gone, so what was sent resets to the defaults. */
  onDemote(i: number): void {
    this.resetSent(i);
  }

  /** Slot `i` was freed: every target and sent value back to its default, unlisted. */
  forget(i: number): void {
    const base = i * LOWPASS_SOURCES;
    for (let s = 0; s < LOWPASS_SOURCES; s++) this.lpBySource[base + s] = LP_TOP;
    this.lpWinner[i] = LowpassBy.NONE;
    this.table.lpHz[i] = BUS_LP_OFF_HZ;
    this.hp[i] = 0;
    this.send4.fill(0, i * FX_SENDS, i * FX_SENDS + FX_SENDS);
    this.yawRad[i] = 0;
    this.auxBusOf[i] = AUX_BUS_NONE;
    this.auxLevelOf[i] = 0;
    this.resetSent(i);
    this.unlist(i);
  }

  /**
   * A hard rebuild replays voice `id` (slot `i`) mixed: right after its PLAY in the REPLAY, a SET_VOICE_FX (asap) with
   * every non-default field, and the sent values follow. Nothing for a default voice.
   */
  replayVoice(b: ReplayBuilder, id: number, i: number): void {
    // The rebuild's RESET emptied the core's pool, and the replayed PLAY carries `table.lpHz[i]`.
    this.resetSent(i);
    this.sentLp[i] = this.table.lpHz[i]!;
    const mask = this.activeMask(i);
    if (mask === 0) return;
    const r = this.replayRec;
    r.voiceId = id;
    r.mask = mask;
    r.rampFrames = 0;
    r.hpHz = this.hp[i]!;
    for (let k = 0; k < FX_SENDS; k++) r.send[k] = this.send4[i * FX_SENDS + k]!;
    r.yaw = this.yawRad[i]!;
    r.auxLevel = this.auxLevelOf[i]!;
    r.auxBus = this.auxBusOf[i]!;
    b.record(SET_VOICE_FX_FIXED_END, this.replayWrite);
    this.commit(i, mask);
  }

  // --- Helpers (allocate nothing) ---

  /** Lists slot `i` for the next flush (once). */
  private mark(i: number): void {
    if (this.listed[i] !== 0) return;
    this.listed[i] = 1;
    this.dirtyList[this.dirtyTop++] = i;
  }

  /** Removes slot `i` from the dirty list (swap with the last entry). */
  private unlist(i: number): void {
    if (this.listed[i] === 0) return;
    this.listed[i] = 0;
    for (let k = 0; k < this.dirtyTop; k++) {
      if (this.dirtyList[k] !== i) continue;
      this.dirtyList[k] = this.dirtyList[--this.dirtyTop]!;
      return;
    }
  }

  /** The SET_VOICE_FX mask of the groups that are non-default now (0: the voice is default). */
  private activeMask(i: number): number {
    let m = 0;
    if (this.hp[i]! > HP_BOTTOM) m |= SET_VOICE_FX_MASK_HP_HZ;
    for (let k = 0; k < FX_SENDS; k++) {
      if (this.send4[i * FX_SENDS + k] !== 0) {
        m |= SET_VOICE_FX_MASK_SENDS;
        break;
      }
    }
    if (this.yawRad[i] !== 0) m |= SET_VOICE_FX_MASK_YAW;
    if (this.auxBusOf[i] !== AUX_BUS_NONE && this.auxLevelOf[i]! > 0) m |= SET_VOICE_FX_MASK_AUX;
    return m;
  }

  /** The groups whose target moved past its threshold from what the core holds. */
  private movedMask(i: number): number {
    let m = 0;
    if (Math.abs(this.hp[i]! - this.sentHp[i]!) > FX_HZ_THRESHOLD) m |= SET_VOICE_FX_MASK_HP_HZ;
    for (let k = 0; k < FX_SENDS; k++) {
      if (levelMoved(this.send4[i * FX_SENDS + k]!, this.sentSend4[i * FX_SENDS + k]!)) {
        m |= SET_VOICE_FX_MASK_SENDS;
        break;
      }
    }
    if (Math.abs(this.yawRad[i]! - this.sentYaw[i]!) > FX_YAW_THRESHOLD) m |= SET_VOICE_FX_MASK_YAW;
    if (this.auxBusOf[i] !== this.sentAuxBus[i] || levelMoved(this.auxLevelOf[i]!, this.sentAuxLevel[i]!)) m |= SET_VOICE_FX_MASK_AUX;
    return m;
  }

  /** Sends the non-default groups of slot `i` as one SET_VOICE_FX (at `atFrame`, asap when undefined), if there are any. */
  private sendActive(i: number, atFrame: number | undefined): void {
    const mask = this.activeMask(i);
    if (mask === 0) return;
    this.writer.setVoiceFx(this.fillArgs(i, mask, 0), atFrame);
    this.commit(i, mask);
  }

  /** The reused record, filled with slot `i`'s targets (every field; `mask` says which the core applies). */
  private fillArgs(i: number, mask: number, rampFrames: number): VoiceFxArgs {
    const a = this.args;
    a.voiceId = encodeVoiceId(i, this.table.gen[i]!);
    a.mask = mask;
    a.rampFrames = rampFrames;
    a.hpHz = this.hp[i]!;
    const send = a.send as Float32Array; // the constructor's own array (typed read-only on the record)
    for (let k = 0; k < FX_SENDS; k++) send[k] = this.send4[i * FX_SENDS + k]!;
    a.yaw = this.yawRad[i]!;
    a.auxLevel = this.auxLevelOf[i]!;
    a.auxBus = this.auxBusOf[i]!;
    return a;
  }

  /** Records that the core now holds the targets of the groups in `mask`. */
  private commit(i: number, mask: number): void {
    if ((mask & SET_VOICE_FX_MASK_HP_HZ) !== 0) this.sentHp[i] = this.hp[i]!;
    if ((mask & SET_VOICE_FX_MASK_SENDS) !== 0) {
      for (let k = 0; k < FX_SENDS; k++) this.sentSend4[i * FX_SENDS + k] = this.send4[i * FX_SENDS + k]!;
    }
    if ((mask & SET_VOICE_FX_MASK_YAW) !== 0) this.sentYaw[i] = this.yawRad[i]!;
    if ((mask & SET_VOICE_FX_MASK_AUX) !== 0) {
      this.sentAuxBus[i] = this.auxBusOf[i]!;
      this.sentAuxLevel[i] = this.auxLevelOf[i]!;
    }
  }

  /** The core's pool entry is fresh (or gone): what it holds is C3's defaults, and lpHz is BUS_LP_OFF_HZ until a PLAY carries one. */
  private resetSent(i: number): void {
    this.sentLp[i] = BUS_LP_OFF_HZ;
    this.sentHp[i] = 0;
    this.sentSend4.fill(0, i * FX_SENDS, i * FX_SENDS + FX_SENDS);
    this.sentYaw[i] = 0;
    this.sentAuxBus[i] = AUX_BUS_NONE;
    this.sentAuxLevel[i] = 0;
  }
}

/** @internal C3's level threshold: whether `next` differs from `sent` by more than 0.5 dB (a change from or to 0 always does). */
export function levelMoved(next: number, sent: number): boolean {
  const nextOff = next <= 0;
  const sentOff = sent <= 0;
  if (nextOff || sentOff) return nextOff !== sentOff;
  return Math.abs(20 * Math.log10(next / sent)) > FX_LEVEL_DB_THRESHOLD;
}
