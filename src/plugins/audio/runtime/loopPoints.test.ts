import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets } from "../../../engine/index";
import { fileSampleRate, loadFileLoopPoints, loopPointsFor, onLoopPoints, resetFileLoopPoints, scanFileLoopPoints, setFileLoopFrames, setFileLoopPoints } from "./loopPoints";

const le32 = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const chunk = (id: string, body: number[]): number[] => [...ascii(id), ...le32(body.length), ...body, ...(body.length & 1 ? [0] : [])];
/** A mono 16-bit WAV; `loop` is a forward smpl loop `[start, inclusiveEnd]`. */
function wav(rate: number, loop?: [number, number]): Uint8Array {
  const fmt = chunk("fmt ", [1, 0, 1, 0, ...le32(rate), ...le32(rate * 2), 2, 0, 16, 0]);
  const smpl = loop ? chunk("smpl", [...new Array<number>(28).fill(0), ...le32(1), ...le32(0), ...le32(0), ...le32(0), ...le32(loop[0]), ...le32(loop[1]), ...le32(0), ...le32(0)]) : [];
  const body = [...ascii("WAVE"), ...fmt, ...chunk("data", new Array<number>(8).fill(0)), ...smpl];
  return new Uint8Array([...ascii("RIFF"), ...le32(body.length), ...body]);
}
/** The first Ogg page of a stream, holding one packet. */
function oggFirstPage(packet: number[]): Uint8Array {
  return new Uint8Array([...ascii("OggS"), 0, 2, ...new Array<number>(8).fill(0), ...le32(1), ...le32(0), ...le32(0), 1, packet.length, ...packet]);
}

beforeEach(() => resetFileLoopPoints());
afterEach(() => Assets.clearSources());

describe("loopPoints", () => {
  it("is null and unknown until the file reports, then known (even when the file has none)", () => {
    const cb = vi.fn();
    onLoopPoints("a.wav", cb);
    expect(loopPointsFor("a.wav")).toBeNull();
    expect(cb).not.toHaveBeenCalled();
    setFileLoopPoints("a.wav", { start: 1, end: 2 });
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith({ start: 1, end: 2 });
    setFileLoopPoints("a.wav", { start: 3, end: 4 });
    expect(cb).toHaveBeenCalledOnce();
    const none = vi.fn();
    onLoopPoints("b.wav", none);
    setFileLoopPoints("b.wav", null);
    expect(none).toHaveBeenCalledWith(null);
  });

  it("calls at once when already known, and unsubscribe stops the callback", () => {
    setFileLoopPoints("a.wav", { start: 1, end: 2 });
    const now = vi.fn();
    onLoopPoints("a.wav", now);
    expect(now).toHaveBeenCalledWith({ start: 1, end: 2 });
    const cb = vi.fn();
    const off = onLoopPoints("c.wav", cb);
    off();
    setFileLoopPoints("c.wav", { start: 0, end: 1 });
    expect(cb).not.toHaveBeenCalled();
  });

  it("the sidecar wins over the file, a lone key overrides only its end, and a full sidecar needs no file", () => {
    Assets.addSource(
      Assets.fromObject({
        "full.wav.meta.json": { format: "myco.import@1", loopStart: 2, loopEnd: 6 },
        "end.wav.meta.json": { format: "myco.import@1", loopEnd: 5 },
        "start.wav.meta.json": { format: "myco.import@1", loopStart: 1 },
      }),
    );
    const early = vi.fn();
    onLoopPoints("full.wav", early);
    expect(early).toHaveBeenCalledWith({ start: 2, end: 6 });
    setFileLoopPoints("full.wav", { start: 0, end: 1 });
    expect(loopPointsFor("full.wav")).toEqual({ start: 2, end: 6 });
    setFileLoopPoints("end.wav", { start: 1, end: 9 });
    expect(loopPointsFor("end.wav")).toEqual({ start: 1, end: 5 });
    setFileLoopPoints("start.wav", { start: 4, end: 9 });
    expect(loopPointsFor("start.wav")).toEqual({ start: 1, end: 9 });
    setFileLoopPoints("start.wav", null);
    expect(loopPointsFor("start.wav")).toBeNull();
  });

  it("converts frames to seconds and treats an empty region or bad rate as none", () => {
    setFileLoopFrames("a.wav", { start: 4000, end: 12000 }, 8000);
    expect(loopPointsFor("a.wav")).toEqual({ start: 0.5, end: 1.5 });
    setFileLoopFrames("b.wav", { start: 5, end: 5 }, 8000);
    expect(loopPointsFor("b.wav")).toBeNull();
    setFileLoopFrames("c.wav", { start: 1, end: 5 }, 0);
    expect(loopPointsFor("c.wav")).toBeNull();
  });

  it("reads a file's rate and a WAV's loop from its bytes", () => {
    const bytes = wav(8000, [4000, 11999]);
    expect(fileSampleRate(bytes)).toBe(8000);
    scanFileLoopPoints("s.wav", bytes);
    expect(loopPointsFor("s.wav")).toEqual({ start: 0.5, end: 1.5 });
    scanFileLoopPoints("n.wav", wav(8000));
    expect(loopPointsFor("n.wav")).toBeNull();
    expect(fileSampleRate(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(fileSampleRate(new Uint8Array(0))).toBeNull();
    expect(fileSampleRate(oggFirstPage([...ascii("OpusHead"), 1, 2, 0, 0]))).toBe(48000);
    expect(fileSampleRate(oggFirstPage([1, ...ascii("vorbis"), ...le32(0), 2, ...le32(44100)]))).toBe(44100);
  });

  it("loadFileLoopPoints fetches once per path and resolves waiters, also on a fetch failure", async () => {
    const bytes = wav(8000, [0, 7999]);
    const fetchMock = vi.fn(async (url: string) => (url === "good" ? { ok: true, arrayBuffer: async () => bytes.buffer } : { ok: false, status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const good = vi.fn();
      onLoopPoints("g.wav", good);
      await Promise.all([loadFileLoopPoints("g.wav", "good"), loadFileLoopPoints("g.wav", "good")]);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(good).toHaveBeenCalledWith({ start: 0, end: 1 });
      const bad = vi.fn();
      onLoopPoints("x.wav", bad);
      await loadFileLoopPoints("x.wav", "bad");
      expect(bad).toHaveBeenCalledWith(null);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
