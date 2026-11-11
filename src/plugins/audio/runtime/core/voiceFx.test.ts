// ADR 0162 (K4, leaf L-K4a): per-voice fx staging (`voiceFx.ts`): S3's low-pass merge, C3's thresholds and staging,
// C20's promotion re-send, and the replay hook. Driven with a real `VoiceTable` and a recording writer.
import { describe, expect, it } from "vitest";
import type { VoiceFxArgs } from "./commandWriter";
import { voiceIndex } from "./ids";
import { ReplayBuilder } from "./replay";
import { VoiceTable, VoiceState, type VoiceStateCode } from "./voiceTable";
import { LowpassBy, VoiceFx, levelMoved } from "./voiceFx";
import {
  ASAP,
  AUX_BUS_NONE,
  BUS_LP_OFF_HZ,
  LP_TOP,
  SET_PARAMS_MASK_LP_HZ,
  SET_VOICE_FX_MASK_AUX,
  SET_VOICE_FX_MASK_HP_HZ,
  SET_VOICE_FX_MASK_SENDS,
  SET_VOICE_FX_MASK_YAW,
  readSetVoiceFx,
} from "../wire.generated";

const BUS = 0;
const WORLD = 1;
const ALL_FX = SET_VOICE_FX_MASK_HP_HZ | SET_VOICE_FX_MASK_SENDS | SET_VOICE_FX_MASK_YAW | SET_VOICE_FX_MASK_AUX;

interface FxCall {
  id: number;
  mask: number;
  rampFrames: number;
  hpHz: number;
  send: number[];
  yaw: number;
  auxLevel: number;
  auxBus: number;
  atFrame: number | undefined;
}
interface ParamsCall {
  id: number;
  mask: number;
  lpHz: number;
  rampFrames: number;
}

/** Records what `VoiceFx` writes (the `VoiceFxWriter` shape). */
class RecordingWriter {
  readonly fx: FxCall[] = [];
  readonly params: ParamsCall[] = [];
  setVoiceFx(args: VoiceFxArgs, atFrame?: number): void {
    this.fx.push({
      id: args.voiceId,
      mask: args.mask,
      rampFrames: args.rampFrames,
      hpHz: args.hpHz,
      send: Array.from(args.send),
      yaw: args.yaw,
      auxLevel: args.auxLevel,
      auxBus: args.auxBus,
      atFrame,
    });
  }
  setParams(id: number, mask: number, _gain: number, _pitch: number, _dx: number, _dy: number, _dz: number, lpHz: number, rampFrames: number): void {
    this.params.push({ id, mask, lpHz, rampFrames });
  }
  get calls(): number {
    return this.fx.length + this.params.length;
  }
}

function rig(capacity = 8) {
  const table = new VoiceTable(capacity);
  const writer = new RecordingWriter();
  const fx = new VoiceFx(table, writer);
  /** A voice in `state`, with its id. */
  const voice = (state: VoiceStateCode = VoiceState.PLAYING): number => table.allocate(BUS, 10, WORLD, state);
  return { table, writer, fx, voice };
}

/** The voice's slot index (its targets are addressed by slot). */
const slot = (id: number): number => voiceIndex(id);

describe("VoiceFx low-pass merge (S3)", () => {
  it("lpHz is the lowest contribution and lowpassBy names its source", () => {
    const { table, fx, voice } = rig();
    const i = slot(voice());
    fx.setLowpass(i, LowpassBy.OCCLUSION, 3000);
    fx.setLowpass(i, LowpassBy.EVENT, 1500);
    expect(table.lpHz[i]).toBe(1500);
    expect(fx.lowpassBy(i)).toBe(LowpassBy.EVENT);
    fx.setLowpass(i, LowpassBy.SNAPSHOT, 2000);
    expect(fx.lowpass(i)).toBe(1500);
    expect(fx.lowpassBy(i)).toBe(LowpassBy.EVENT);
    // The event's low-pass goes away: the lowest of the rest is the occlusion cutoff.
    fx.setLowpass(i, LowpassBy.EVENT, LP_TOP);
    expect(table.lpHz[i]).toBe(2000);
    expect(fx.lowpassBy(i)).toBe(LowpassBy.SNAPSHOT);
  });

  it("a contribution at or above LP_TOP (or non-finite) is no low-pass; with none left lpHz is BUS_LP_OFF_HZ and lowpassBy NONE", () => {
    const { table, fx, voice } = rig();
    const i = slot(voice());
    fx.setLowpass(i, LowpassBy.OCCLUSION, LP_TOP);
    expect(table.lpHz[i]).toBe(BUS_LP_OFF_HZ);
    expect(fx.lowpassBy(i)).toBe(LowpassBy.NONE);
    fx.setLowpass(i, LowpassBy.EVENT, Number.NaN);
    fx.setLowpass(i, LowpassBy.SNAPSHOT, Number.POSITIVE_INFINITY);
    expect(table.lpHz[i]).toBe(BUS_LP_OFF_HZ);
    expect(fx.lowpassBy(i)).toBe(LowpassBy.NONE);
    fx.setLowpass(i, LowpassBy.OCCLUSION, 4000);
    fx.setLowpass(i, LowpassBy.EVENT, LP_TOP + 500);
    expect(table.lpHz[i]).toBe(4000);
    expect(fx.lowpassBy(i)).toBe(LowpassBy.OCCLUSION);
    fx.setLowpass(i, LowpassBy.OCCLUSION, LP_TOP + 1);
    expect(table.lpHz[i]).toBe(BUS_LP_OFF_HZ);
    expect(fx.lowpassBy(i)).toBe(LowpassBy.NONE);
  });

  it("setLowpass writes table.lpHz at once, so PLAY and SET_MIXED carry it", () => {
    const { table, writer, fx, voice } = rig();
    const i = slot(voice());
    fx.setLowpass(i, LowpassBy.OCCLUSION, 2000);
    expect(table.lpHz[i]).toBe(2000);
    expect(writer.calls).toBe(0);
    // A PLAY carries table.lpHz, so it is recorded as sent: nothing more goes out for it at the next flush.
    fx.onPlay(i);
    fx.flush(0);
    expect(writer.params).toEqual([]);
  });
});

describe("VoiceFx thresholds and staging (C3)", () => {
  it("a default voice never sends anything (M2 bytes unchanged)", () => {
    const { writer, fx, voice } = rig();
    const i = slot(voice());
    fx.setHighpass(i, 10); // off (HP_BOTTOM or less)
    fx.setSend(i, 0, 0);
    fx.setYaw(i, 0);
    fx.setAux(i, AUX_BUS_NONE, 0.5); // no bus: no aux
    expect(fx.isDefault(i)).toBe(true);
    fx.onPlay(i); // the PLAY, then the frame's flush
    fx.flush(0);
    fx.onPromote(i);
    fx.flush(0);
    expect(writer.calls).toBe(0);
  });

  it("flush sends SET_PARAMS with only the lpHz bit to a mixed voice when lpHz moved more than 1 Hz", () => {
    const { writer, fx, voice } = rig();
    const id = voice();
    const i = slot(id);
    fx.onPlay(i);
    fx.setLowpass(i, LowpassBy.OCCLUSION, 5000);
    fx.flush(16);
    expect(writer.params).toEqual([{ id, mask: SET_PARAMS_MASK_LP_HZ, lpHz: 5000, rampFrames: 16 }]);
    expect(writer.fx).toEqual([]);
  });

  it("flush sends one SET_VOICE_FX per voice with the mask of what moved: hpHz past 1 Hz, a send past 0.5 dB, yaw past 0.001 rad, aux bus changed or level past 0.5 dB", () => {
    const { writer, fx, voice } = rig();
    const id = voice();
    const i = slot(id);
    fx.onPlay(i);
    fx.setHighpass(i, 500);
    fx.setSend(i, 0, 0.5);
    fx.setYaw(i, 0.3);
    fx.setAux(i, 3, 0.4);
    fx.flush(4);
    expect(writer.fx).toHaveLength(1);
    expect(writer.fx[0]!.mask).toBe(ALL_FX);
    expect(writer.fx[0]!.id).toBe(id);
    expect(writer.fx[0]!.hpHz).toBe(500);
    expect(writer.fx[0]!.send[0]).toBeCloseTo(0.5, 6);
    expect(writer.fx[0]!.yaw).toBeCloseTo(0.3, 6);
    expect(writer.fx[0]!.auxBus).toBe(3);
    expect(writer.fx[0]!.auxLevel).toBeCloseTo(0.4, 6);
    expect(writer.fx[0]!.rampFrames).toBe(4);
    expect(writer.fx[0]!.atFrame).toBeUndefined();

    // Each field alone, past its threshold, gives only its bit.
    fx.setHighpass(i, 502);
    fx.flush(0);
    expect(writer.fx.at(-1)!.mask).toBe(SET_VOICE_FX_MASK_HP_HZ);
    fx.setSend(i, 0, 0.5 * Math.pow(10, 0.6 / 20));
    fx.flush(0);
    expect(writer.fx.at(-1)!.mask).toBe(SET_VOICE_FX_MASK_SENDS);
    fx.setYaw(i, 0.3 + 0.002);
    fx.flush(0);
    expect(writer.fx.at(-1)!.mask).toBe(SET_VOICE_FX_MASK_YAW);
    fx.setAux(i, 4, 0.4); // bus changed
    fx.flush(0);
    expect(writer.fx.at(-1)!.mask).toBe(SET_VOICE_FX_MASK_AUX);
    fx.setAux(i, 4, 0.4 * Math.pow(10, 0.6 / 20)); // level past 0.5 dB
    fx.flush(0);
    expect(writer.fx.at(-1)!.mask).toBe(SET_VOICE_FX_MASK_AUX);
    expect(writer.fx).toHaveLength(6);
  });

  it("changes within the thresholds are not sent, and are measured from the value last sent, not the last staged", () => {
    const { writer, fx, voice } = rig();
    const i = slot(voice());
    fx.onPlay(i);
    fx.setSend(i, 0, 1);
    fx.flush(0);
    expect(writer.fx).toHaveLength(1); // 1.0 is past 0 (default) by its level
    writer.fx.length = 0;
    // 0.34 dB from 1.0: within the threshold, not sent.
    fx.setSend(i, 0, Math.pow(10, 0.34 / 20));
    fx.flush(0);
    expect(writer.fx).toHaveLength(0);
    // 0.17 dB more (0.51 dB from the value last sent): sent, although the last staged change was only 0.17 dB.
    fx.setSend(i, 0, Math.pow(10, 0.51 / 20));
    fx.flush(0);
    expect(writer.fx).toHaveLength(1);
    writer.fx.length = 0;
    // Yaw within 0.001 rad: not sent. High-pass: 300 Hz sent, then 300.5 Hz (within 1 Hz) not.
    fx.setYaw(i, 0.0005);
    fx.setHighpass(i, 300);
    fx.flush(0);
    expect(writer.fx).toHaveLength(1);
    expect(writer.fx[0]!.mask).toBe(SET_VOICE_FX_MASK_HP_HZ);
    writer.fx.length = 0;
    fx.setYaw(i, 0.0005);
    fx.setHighpass(i, 300.5);
    fx.flush(0);
    expect(writer.fx).toHaveLength(0);
  });

  it("a send or aux level from or to 0 is always past the threshold (levelMoved)", () => {
    expect(levelMoved(0.0001, 0)).toBe(true);
    expect(levelMoved(0, 0.0001)).toBe(true);
    expect(levelMoved(0, 0)).toBe(false);
    expect(levelMoved(-1, 0)).toBe(false);
    expect(levelMoved(0.5, 0.5)).toBe(false);
    expect(levelMoved(1, 1.05)).toBe(false); // 0.42 dB
    expect(levelMoved(1, 1.07)).toBe(true); // 0.59 dB
    const { writer, fx, voice } = rig();
    const i = slot(voice());
    fx.onPlay(i);
    fx.setSend(i, 1, 1e-6);
    fx.flush(0);
    expect(writer.fx.at(-1)!.mask).toBe(SET_VOICE_FX_MASK_SENDS);
    fx.setAux(i, 2, 0.3);
    fx.flush(0);
    expect(writer.fx.at(-1)!.mask).toBe(SET_VOICE_FX_MASK_AUX);
    fx.setAux(i, AUX_BUS_NONE, 0);
    fx.flush(0);
    expect(writer.fx.at(-1)!.mask).toBe(SET_VOICE_FX_MASK_AUX);
    expect(writer.fx.at(-1)!.auxBus).toBe(AUX_BUS_NONE);
  });

  it("a virtual voice is sent nothing; flush clears the dirty list", () => {
    const { table, writer, fx, voice } = rig();
    const i = slot(voice(VoiceState.VIRTUAL));
    fx.setHighpass(i, 800);
    fx.setLowpass(i, LowpassBy.EVENT, 1000);
    fx.flush(0);
    expect(writer.calls).toBe(0);
    // The list is clear: once the voice is mixed, nothing is sent until a target changes again (onPromote does that).
    table.state[i] = VoiceState.PLAYING;
    fx.flush(0);
    expect(writer.calls).toBe(0);
  });

  it("onPlay sends SET_VOICE_FX at the PLAY's frame only for a mixed, non-default voice", () => {
    const { writer, fx, voice } = rig();
    const mixed = slot(voice());
    fx.setHighpass(mixed, 800);
    fx.onPlay(mixed, 1234);
    expect(writer.fx).toHaveLength(1);
    expect(writer.fx[0]!.atFrame).toBe(1234);
    expect(writer.fx[0]!.mask).toBe(SET_VOICE_FX_MASK_HP_HZ);
    expect(writer.fx[0]!.hpHz).toBe(800);

    const unstamped = slot(voice());
    fx.setYaw(unstamped, 0.5);
    fx.onPlay(unstamped);
    expect(writer.fx).toHaveLength(2);
    expect(writer.fx[1]!.atFrame).toBeUndefined();

    const virtual = slot(voice(VoiceState.VIRTUAL));
    fx.setHighpass(virtual, 800);
    fx.onPlay(virtual, 99);
    expect(writer.fx).toHaveLength(2);

    const quiet = slot(voice());
    fx.onPlay(quiet, 99);
    expect(writer.fx).toHaveLength(2);
  });
});

describe("VoiceFx promotion and lifetime (C20)", () => {
  it("onPromote re-sends every non-default target (high-pass, sends, yaw, aux), whatever was sent before", () => {
    const { table, writer, fx, voice } = rig();
    const id = voice(VoiceState.VIRTUAL);
    const i = slot(id);
    fx.setHighpass(i, 800);
    fx.setSend(i, 0, 0.5);
    fx.setSend(i, 3, 0.25);
    fx.setYaw(i, 0.3);
    fx.setAux(i, 2, 0.7);
    fx.flush(0); // virtual: nothing
    expect(writer.calls).toBe(0);
    // Selection sets the state before the SET_MIXED, so the promotion finds the voice PLAYING.
    table.state[i] = VoiceState.PLAYING;
    fx.onPromote(i);
    expect(writer.fx).toHaveLength(1);
    const first = writer.fx[0]!;
    expect(first.id).toBe(id);
    expect(first.mask).toBe(ALL_FX);
    expect(first.hpHz).toBe(800);
    expect(first.send[0]).toBeCloseTo(0.5, 6);
    expect(first.send[3]).toBeCloseTo(0.25, 6);
    expect(first.yaw).toBeCloseTo(0.3, 6);
    expect(first.auxBus).toBe(2);
    expect(first.auxLevel).toBeCloseTo(0.7, 6);
    // Again, with nothing changed: the same full record goes out.
    fx.onPromote(i);
    expect(writer.fx).toHaveLength(2);
    expect(writer.fx[1]!.mask).toBe(ALL_FX);
  });

  it("onDemote resets what was sent, so targets staged while virtual go out at the next promotion", () => {
    const { table, writer, fx, voice } = rig();
    const i = slot(voice());
    fx.setHighpass(i, 800);
    fx.onPlay(i);
    expect(writer.fx).toHaveLength(1);
    table.state[i] = VoiceState.VIRTUAL;
    fx.onDemote(i);
    fx.setHighpass(i, 900); // staged while virtual
    fx.flush(0);
    expect(writer.fx).toHaveLength(1); // nothing while virtual
    table.state[i] = VoiceState.PLAYING;
    fx.onPromote(i);
    expect(writer.fx).toHaveLength(2);
    expect(writer.fx[1]!.mask).toBe(SET_VOICE_FX_MASK_HP_HZ);
    expect(writer.fx[1]!.hpHz).toBe(900);
  });

  it("forget restores every default and unlists the slot", () => {
    const { table, fx, voice } = rig();
    const i = slot(voice());
    fx.setLowpass(i, LowpassBy.OCCLUSION, 2000);
    fx.setHighpass(i, 800);
    fx.setSend(i, 0, 0.5);
    fx.setYaw(i, 0.3);
    fx.setAux(i, 2, 0.5);
    fx.forget(i);
    expect(fx.lowpass(i)).toBe(BUS_LP_OFF_HZ);
    expect(fx.lowpassBy(i)).toBe(LowpassBy.NONE);
    expect(table.lpHz[i]).toBe(BUS_LP_OFF_HZ);
    expect(fx.highpass(i)).toBe(0);
    expect(fx.send(i, 0)).toBe(0);
    expect(fx.yaw(i)).toBe(0);
    expect(fx.auxBus(i)).toBe(AUX_BUS_NONE);
    expect(fx.auxLevel(i)).toBe(0);
    expect(fx.isDefault(i)).toBe(true);
  });

  it("replayVoice appends one asap SET_VOICE_FX for a non-default voice, and nothing for a default one", () => {
    const { fx, voice } = rig();
    const id = voice();
    const i = slot(id);
    const b = new ReplayBuilder();
    fx.replayVoice(b, id, i);
    expect(b.count).toBe(0);

    fx.setHighpass(i, 800);
    fx.setSend(i, 2, 0.5);
    fx.setAux(i, 1, 0.25);
    fx.replayVoice(b, id, i);
    expect(b.count).toBe(1);

    // Decode what was staged: post it through a fake link and read the record back.
    const posted: ArrayBuffer[] = [];
    b.post({ post: (buf) => posted.push(buf), nextSeq: () => 0 }, 0, false);
    expect(posted).toHaveLength(1);
    const rec = readSetVoiceFx(new DataView(posted[0]!), 32);
    expect(rec.voiceId).toBe(id);
    expect(rec.frameOffset).toBe(ASAP);
    expect(rec.mask).toBe(SET_VOICE_FX_MASK_HP_HZ | SET_VOICE_FX_MASK_SENDS | SET_VOICE_FX_MASK_AUX);
    expect(rec.hpHz).toBe(800);
    expect(rec.send[2]).toBeCloseTo(0.5, 6);
    expect(rec.auxBus).toBe(1);
    expect(rec.auxLevel).toBeCloseTo(0.25, 6);
  });
});
