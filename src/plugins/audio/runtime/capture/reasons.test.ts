// ADR 0260: a capture's reason codes read back as the sink's words, and the one text of each word.
import { describe, expect, it } from "vitest";
import { reasonText, voiceRowReason } from "./reasons";

describe("a voice row's reason, read by its state (§5.6)", () => {
  it("words each code by the table its state uses", () => {
    expect([1, 2, 3].map((r) => voiceRowReason("stolen", r))).toEqual(["busMaxVoices", "globalLimit", "priority"]);
    expect([1, 2, 3, 4].map((r) => voiceRowReason("virtual", r))).toEqual(["capDemoted", "belowAudibility", "paused", "worldInaudible"]);
    expect([1, 2].map((r) => voiceRowReason("playing", r))).toEqual(["promoted", "capRaised"]);
    expect([1, 2].map((r) => voiceRowReason("waitingForData", r))).toEqual(["clipLoading", "streamPriming"]);
  });

  it("is null for no reason, a state without reasons and a code this build doesn't know", () => {
    expect(voiceRowReason("playing", 0)).toBeNull();
    expect(voiceRowReason("busMuted", 1)).toBeNull();
    expect(voiceRowReason("stolen", 9)).toBeNull();
  });
});

describe("reasonText", () => {
  it("spells a word out, with its own text where the word alone reads badly; empty for none", () => {
    expect(["busMaxVoices", "globalLimit", "belowAudibility", "worldReleased", "streamPriming", "promoted"].map((w) => reasonText(w as never)))
      .toEqual(["bus max voices", "global limit", "below audibility", "world released", "stream priming", "promoted"]);
    expect(reasonText("capDemoted")).toBe("demoted by the cap");
    expect(reasonText(null)).toBe("");
  });
});
