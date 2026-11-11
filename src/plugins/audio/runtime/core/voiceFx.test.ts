// ADR 0162 (K4, leaf L-K4a): per-voice fx staging (`voiceFx.ts`): S3's low-pass merge, C3's thresholds and staging,
// C20's promotion re-send, and the replay hook. Driven with a real `VoiceTable` and a recording writer.
import { describe, it } from "vitest";

describe("VoiceFx low-pass merge (S3)", () => {
  it.skip("lpHz is the lowest contribution and lowpassBy names its source", () => {});
  it.skip("a contribution at or above LP_TOP (or non-finite) is no low-pass; with none left lpHz is BUS_LP_OFF_HZ and lowpassBy NONE", () => {});
  it.skip("setLowpass writes table.lpHz at once, so PLAY and SET_MIXED carry it", () => {});
});

describe("VoiceFx thresholds and staging (C3)", () => {
  it.skip("a default voice never sends anything (M2 bytes unchanged)", () => {});
  it.skip("flush sends SET_PARAMS with only the lpHz bit to a mixed voice when lpHz moved more than 1 Hz", () => {});
  it.skip("flush sends one SET_VOICE_FX per voice with the mask of what moved: hpHz past 1 Hz, a send past 0.5 dB, yaw past 0.001 rad, aux bus changed or level past 0.5 dB", () => {});
  it.skip("changes within the thresholds are not sent, and are measured from the value last sent, not the last staged", () => {});
  it.skip("a send or aux level from or to 0 is always past the threshold (levelMoved)", () => {});
  it.skip("a virtual voice is sent nothing; flush clears the dirty list", () => {});
  it.skip("onPlay sends SET_VOICE_FX at the PLAY's frame only for a mixed, non-default voice", () => {});
});

describe("VoiceFx promotion and lifetime (C20)", () => {
  it.skip("onPromote re-sends every non-default target (high-pass, sends, yaw, aux), whatever was sent before", () => {});
  it.skip("onDemote resets what was sent, so targets staged while virtual go out at the next promotion", () => {});
  it.skip("forget restores every default and unlists the slot", () => {});
  it.skip("replayVoice appends one asap SET_VOICE_FX for a non-default voice, and nothing for a default one", () => {});
});
