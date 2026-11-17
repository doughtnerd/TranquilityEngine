// ADR 0162 E4: the occlusion overlay the Audio Debug panel's toggle draws in the scene view.
import { describe, expect, it } from "vitest";
import type { AudioDebugInfo } from "../runtime/backend";
import { gainColor, occludedVoices, occlusionColors, occlusionOverlay } from "./occlusionRays";
import { voice as baseVoice } from "./testing/debugSnapshot";

describe("occlusion overlay", () => {
  const voice = (id: number, gain: number, hits: number, world: string | null = "1"): AudioDebugInfo["voices"][number] =>
    baseVoice(id, { world, occlusion: { gain, cutoffHz: 1000, ageFrames: 0, hits, material: "", collider: null } });
  const colors = { open: 0x00ff00, half: 0xffff00, closed: 0xff0000 };

  it("colours go from open to half to closed by gain", () => {
    expect([gainColor(1, colors), gainColor(0.5, colors), gainColor(0, colors)]).toEqual([0x00ff00, 0xffff00, 0xff0000]);
    expect(gainColor(Number.NaN, colors)).toBe(0x00ff00);
  });

  it("takes only occluded voices of the World, most muffled first, at most 48", () => {
    const vs = [voice(1, 1, 0), voice(2, 0.5, 1), voice(3, 0.1, 1), voice(4, 0.2, 1, "2"), voice(5, 1, 1), { ...voice(6, 1, 0), occlusion: undefined }];
    expect(occludedVoices(vs, 1).map((v) => v.id)).toEqual([3, 2, 5]);
    const many = Array.from({ length: 48 + 10 }, (_, i) => voice(i + 1, 0.5, 1));
    expect(occludedVoices(many, 1)).toHaveLength(48);
  });

  it("draws a ray to the listener and a cross at the hit; no source, no ray; no hit, no cross", () => {
    const scene = { worldKey: 1, listener: [0, 0, 0] as const, sourceOf: (id: number) => (id === 2 ? ([10, 0, 0] as const) : null), hitOf: (id: number) => (id === 2 ? ([5, 0, 0] as const) : null) };
    const o = occlusionOverlay([voice(2, 0.5, 1), voice(3, 0.5, 1)], scene, colors);
    expect(o.lines).toHaveLength(4);
    expect(o.lines[0]!.points).toEqual([[10, 0, 0], [0, 0, 0]]);
    expect(o.lines.every((l) => l.color === 0xffff00)).toBe(true);
    const noHit = occlusionOverlay([voice(2, 0.5, 1)], { ...scene, hitOf: () => null }, colors);
    expect(noHit.lines).toHaveLength(1);
  });

  it("takes its colours from the theme", () => {
    const c = occlusionColors({ success: "#00ff00", warning: "#ffff00", danger: "#ff0000" } as never);
    expect(c).toEqual(colors);
  });
});
