import { describe, expect, it } from "vitest";
import { MAX_VOICE_ROWS, voiceRows } from "./AudioDebugPanel";

type V = Parameters<typeof voiceRows>[0][number];
const voice = (id: number, audibility: number, state: V["state"] = "playing", priority = 128): V => ({
  id, clip: `c${id}`, bus: "SFX", world: null, state, priority, gain: 1, pitch: 1, audibility, playheadSeconds: null, owner: null,
});

describe("AudioDebugPanel voice rows", () => {
  it("shows every voice when there are few", () => {
    const r = voiceRows([voice(1, 0.2), voice(2, 0.9)]);
    expect(r.rows.map((v) => v.id)).toEqual([1, 2]);
    expect(r.hidden).toBe(0);
  });

  it("shows only the most audible voices of thousands and counts the rest by state", () => {
    const voices = Array.from({ length: 4096 }, (_, i) => voice(i + 1, (i % 1000) / 1000, i % 3 === 0 ? "virtual" : "playing"));
    const r = voiceRows(voices);
    expect(r.rows).toHaveLength(MAX_VOICE_ROWS);
    expect(r.rows.every((v, i) => i === 0 || r.rows[i - 1]!.audibility >= v.audibility)).toBe(true);
    expect(r.rows[0]!.audibility).toBe(0.999);
    expect(r.hidden).toBe(4096 - MAX_VOICE_ROWS);
    expect(Object.values(r.hiddenByState).reduce((a, b) => a + b, 0)).toBe(r.hidden);
  });
});
