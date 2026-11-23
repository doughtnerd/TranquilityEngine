// The Studio components' models: latency calibration by tapping, offsets per device, the status bar's words.
import { describe, expect, it } from "vitest";
import { BEAT_MS, KEEP_TAPS, addTap, beatIndex, clampOffset, foldError, formatOffset, summarize } from "./calibrationModel";
import { DEFAULT_DEVICE, isCalibrated, offsetsFor, withOffset } from "./deviceOffsets";
import { statusReadouts, type StatusPart } from "./statusBarModel";

describe("tap calibration", () => {
  it("folds each tap's error from the nearest 500 ms beat into ±250 ms", () => {
    expect(foldError(1030, 0)).toBe(30);
    expect(foldError(980, 0)).toBe(-20);
    expect(foldError(1260, 0)).toBe(-240); // nearer the next beat
    expect(foldError(1250, 0)).toBe(-250);
    expect(foldError(100, 200)).toBe(-100); // before the first beat
    expect(beatIndex(1499, 0)).toBe(2);
    expect(BEAT_MS).toBe(500);
  });

  it("averages the last 16 taps and can be used from 4", () => {
    let taps: number[] = [];
    for (const e of [20, 30, 40]) taps = addTap(taps, e);
    expect(summarize(taps)).toMatchObject({ count: 3, average: 30, usable: false, offset: null });
    taps = addTap(taps, 30);
    expect(summarize(taps)).toMatchObject({ count: 4, average: 30, spread: 5, usable: true, offset: 30 });
    for (let i = 0; i < 20; i++) taps = addTap(taps, 100);
    expect(taps).toHaveLength(KEEP_TAPS);
    expect(summarize(taps).average).toBe(100);
    expect(summarize([])).toEqual({ count: 0, average: null, spread: null, usable: false, offset: null });
  });

  it("keeps offsets within ±300 ms and writes them signed", () => {
    expect(clampOffset(512)).toBe(300);
    expect(clampOffset(-12.4)).toBe(-12);
    expect(clampOffset("x")).toBe(0);
    expect(summarize([400, 400, 400, 400]).offset).toBe(300);
    expect([formatOffset(23), formatOffset(-12), formatOffset(0)]).toEqual(["+23 ms", "−12 ms", "0 ms"]);
  });
});

describe("offsets per device", () => {
  it("keeps audio and visual offsets per device, clamped, reading bad values as zero", () => {
    let store = withOffset({}, DEFAULT_DEVICE, "audio", 42);
    store = withOffset(store, DEFAULT_DEVICE, "visual", -999);
    store = withOffset(store, "usb", "audio", 10);
    expect(offsetsFor(store, DEFAULT_DEVICE)).toEqual({ audio: 42, visual: -300 });
    expect(offsetsFor(store, "usb")).toEqual({ audio: 10, visual: 0 });
    expect(offsetsFor(store, "hdmi")).toEqual({ audio: 0, visual: 0 });
    expect(offsetsFor({ x: { audio: "loud" } }, "x")).toEqual({ audio: 0, visual: 0 });
    expect(offsetsFor(null, "x")).toEqual({ audio: 0, visual: 0 });
    expect(isCalibrated(store, "usb")).toBe(true);
    expect(isCalibrated(store, "hdmi")).toBe(false);
  });
});

describe("status bar", () => {
  const stats = { backend: "core", status: "running", sampleRate: 48000, voices: 3, voiceCap: 4096, cpuPercent: 4.2, cpuNote: null, underruns: 0, latencyMs: 23.4, latencyReliable: true, bufferMs: 5.3, fxStarved: 0, fxStarvedOwner: null };
  const texts = (parts: readonly StatusPart[]) => parts.map((p) => p.text);
  it("reads like the prototype while running: the core, voices, CPU and the clock; the device, voice cap, meters and saved state", () => {
    const r = statusReadouts({ kind: "running" }, stats, { clock: { label: "Playhead", seconds: 0.52 }, document: "saved" });
    expect(texts(r.left)).toEqual(["Rust core · 48 kHz", "Voices 3 / 4,096", "CPU 4.2%", "Playhead 00:00.520"]);
    expect(texts(r.right)).toEqual(["Device OK", "Voice cap: OK", "Meters: live", "Saved"]);
    expect(r.right[0].tone).toBe("success");
  });
  it("shows the session clock, unsaved edits and a read-only project", () => {
    expect(texts(statusReadouts({ kind: "running" }, stats, { clock: { label: "Session", seconds: 61.5 } }).left)).toContain("Session 01:01.500");
    expect(texts(statusReadouts({ kind: "running" }, stats, { document: "unsaved" }).right).at(-1)).toBe("Unsaved");
    expect(texts(statusReadouts({ kind: "running" }, stats, { document: "readOnly" }).right).at(-1)).toBe("Read-only");
  });
  it("warns about a full voice cap, unmeasured CPU, underruns and a changed output", () => {
    const r = statusReadouts({ kind: "running" }, { ...stats, sampleRate: 44100, voices: 64, voiceCap: 64, cpuPercent: null, cpuNote: "CPU not measured yet", underruns: 2 });
    expect(r.left.map((p) => [p.text, p.tone])).toEqual([["Rust core · 44.1 kHz", undefined], ["Voices 64 / 64", "warning"], ["CPU —", "muted"]]);
    expect(r.right.map((p) => [p.text, p.tone])).toEqual([["2 underruns", "warning"], ["Voice cap: full", "warning"], ["Meters: live", undefined]]);
    expect(statusReadouts({ kind: "running" }, stats, { stale: true }).right[0]).toMatchObject({ text: "Device changed", tone: "warning" });
  });
  it("warns when effects ran out of the core's effect memory, naming the last owner (ABI 4.8)", () => {
    const part = statusReadouts({ kind: "running" }, { ...stats, fxStarved: 2, fxStarvedOwner: "Ambience" }).right.find((p) => p.text === "Effect memory full")!;
    expect(part.tone).toBe("warning");
    expect(part.title).toMatch(/2 effects got no effect memory.*\(last: Ambience\)/);
    expect(texts(statusReadouts({ kind: "running" }, stats).right)).not.toContain("Effect memory full");
  });
  it("says what the runtime is doing otherwise", () => {
    expect(statusReadouts({ kind: "idle" }, null).left[0].text).toBe("No project open");
    expect(statusReadouts({ kind: "locked" }, null).right[0].text).toMatch(/Click anywhere/);
    expect(statusReadouts({ kind: "failed", reason: "why" }, null).left).toEqual([{ text: "Audio core unavailable", tone: "danger", title: "why" }]);
  });
});
