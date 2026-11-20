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

describe("the pending voice records what it can't do yet and forwards it at the hand-over (ADR 0264)", () => {
  const req = { path: "a.ogg", url: "a.ogg", loop: false, stream: false, bus: "Master" };

  it("a seek and the stamped ramps given while the core loads reach the real voice", () => {
    const p = new PendingCoreBackend();
    const v = p.play(req)!;
    v.seek(0.75);
    v.fadeShaped({ to: 0, seconds: 1, law: "equalPowerOut", at: 3, stopAtEnd: true });
    v.paramsShaped({ gain: 0.5, seconds: 0, at: 2 });
    const f = makeFakeBackend();
    p.handOver(f);
    const real = f.voices[0]!;
    expect(real.events.filter((e) => e.kind === "seek" || e.kind === "fadeShaped" || e.kind === "paramsShaped")).toEqual([
      { kind: "seek", seconds: 0.75 },
      { kind: "fadeShaped", to: 0, seconds: 1, law: "equalPowerOut", at: 3, stopAtEnd: true },
      { kind: "paramsShaped", gain: 0.5, seconds: 0, at: 2 },
    ]);
    v.seek(0.1); // after the hand-over: forwarded at once
    expect(real.events.at(-1)).toEqual({ kind: "seek", seconds: 0.1 });
    p.dispose();
  });

  it("a plain fade given after a shaped one wins, as on a voice", () => {
    const p = new PendingCoreBackend();
    const v = p.play(req)!;
    v.fadeShaped({ to: 0, seconds: 1, law: "linear" });
    v.fade(0.5, 0);
    const f = makeFakeBackend();
    p.handOver(f);
    expect(f.voices[0]!.events.filter((e) => e.kind === "fade" || e.kind === "fadeShaped")).toEqual([{ kind: "fade", to: 0.5, seconds: 0 }]);
    p.dispose();
  });
});
