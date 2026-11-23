// ADR 0370 (T13t): the animation core's loader. Without `simd128` it never instantiates the module, warns once and
// reports `unsupported` (Animators stay at their bind pose); a failed instantiation is tried again on the next load;
// this Node's WebAssembly passes the real feature check.
import { describe, expect, it, vi } from "vitest";
import { createAnimationCoreLoader } from "./loader";
import { supportsSimd128 } from "./simd";

describe("loading the animation core", () => {
  it("reports unsupported without simd128, warning once and never instantiating", async () => {
    const instantiate = vi.fn(() => Promise.reject(new Error("must not instantiate")));
    const warn = vi.fn();
    const load = createAnimationCoreLoader({ supportsSimd: () => false, instantiate, warn });
    expect(await load()).toEqual({ status: "unsupported" });
    expect(await load({ maxBones: 64 })).toEqual({ status: "unsupported" });
    expect(instantiate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/simd128.*bind pose/);
  });

  it("tries a failed instantiation again on the next load", async () => {
    const instantiate = vi.fn(() => Promise.reject(new Error("offline")));
    const load = createAnimationCoreLoader({ supportsSimd: () => true, instantiate, warn: vi.fn() });
    await expect(load()).rejects.toThrow("offline");
    await expect(load()).rejects.toThrow("offline");
    expect(instantiate).toHaveBeenCalledTimes(2);
  });

  it("detects simd128 in this runtime", () => {
    expect(supportsSimd128()).toBe(true);
  });
});
