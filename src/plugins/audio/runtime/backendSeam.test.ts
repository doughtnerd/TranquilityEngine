// ADR 0179: which capabilities each adapter of the `AudioBackend` seam has (the table in the record). The core's are
// typed (`CoreBackend implements` each capability, every getter returns the backend); its loopback tests cover them.
import { describe, expect, it, vi } from "vitest";
import type { AudioBackend } from "./backend";
import { BabylonBackend } from "./babylonBackend";
import { PendingCoreBackend } from "./pendingBackend";
import { makeFakeBackend } from "./testing";

vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);

describe("AudioBackend capabilities per adapter (ADR 0179)", () => {
  it("the Babylon fallback: clip cache (durations only), music, live mix and capture are the backend; no clock, no automation", () => {
    const b = new BabylonBackend({ visibility: null, unlockTarget: null });
    expect(b.clipCache).toBe(b);
    expect(b.mix).toBe(b);
    expect(b.capture).toBe(b);
    expect(b.music).toBeDefined();
    const seam: AudioBackend = b;
    expect(seam.clock).toBeUndefined();
    expect(seam.automation).toBeUndefined();
    expect(b.clipCache.clipFacts("a.ogg")).toBeUndefined();
    expect(b.clipCache.holdSpan("a.ogg", 0, 100)).toBeNull();
    expect(b.mix.mixCaps.capture).toBe("mainSideOnly");
    expect(b.capture.recorderTap).toBeNull();
    b.dispose();
  });

  it("the pending backend has the required members only", () => {
    const p = new PendingCoreBackend();
    for (const cap of ["clipCache", "clock", "music", "automation", "mix", "capture"] as const) expect(p[cap as keyof PendingCoreBackend]).toBeUndefined();
    p.dispose();
  });

  it("the fake has every capability but automation, each the fake itself and each removable", () => {
    const f = makeFakeBackend();
    expect([f.clipCache, f.clock, f.mix, f.capture]).toEqual([f, f, f, f]);
    expect(f.music).toBeDefined();
    expect(f.automation).toBeUndefined();
    expect(f.clock!.horizon()).toBeNull();
    f.horizonTime = 2;
    expect(f.clock!.horizon()).toBe(2);
    f.clock = undefined;
    expect(f.clock).toBeUndefined();
  });
});
