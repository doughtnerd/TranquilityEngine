import { describe, expect, it } from "vitest";
import { offerInstruction, offerProblem, offerStateText, shownCode } from "./offerRoomLogic";

describe("the offer's lines", () => {
  it("each state has its own line", () => {
    expect(offerStateText({ kind: "opening" })).toBe("Opening a room…");
    expect(offerStateText({ kind: "waiting", code: "ab" })).toBe("Waiting for a build to join.");
    expect(offerStateText({ kind: "joined" })).toContain("joined");
    expect(offerStateText({ kind: "retrying", why: "no route" })).toContain("no route");
    expect(offerStateText({ kind: "unavailable", why: "No rendezvous." })).toBe("No rendezvous.");
  });

  it("shows the code only while waiting, in upper case", () => {
    expect(shownCode("3f9qk-7kd2x", { kind: "waiting", code: "3f9qk-7kd2x" })).toBe("3F9QK-7KD2X");
    expect(shownCode("3f9qk", { kind: "joined" })).toBeNull();
    expect(shownCode(null, { kind: "waiting", code: "x" })).toBeNull();
  });

  it("names the code in both ways to use it", () => {
    expect(offerInstruction("AB-CD")).toBe("Open the game with ?debug-code=AB-CD in its address, or launch it with --debug-code AB-CD.");
    expect(offerInstruction(null)).toContain("?debug-code=<code>");
  });

  it("flags retrying and unavailable as problems", () => {
    expect(offerProblem({ kind: "retrying", why: "x" })).toBe(true);
    expect(offerProblem({ kind: "unavailable", why: "x" })).toBe(true);
    expect(offerProblem({ kind: "waiting", code: "x" })).toBe(false);
  });
});
