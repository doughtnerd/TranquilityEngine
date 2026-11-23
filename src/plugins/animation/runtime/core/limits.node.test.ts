// ADR 0370 (T13t), after audio 0327/0328: the page's loader starts the committed core in Node (the dedicated server's
// path: the wasm read from disk) with one INIT record and honours the MEMORY_NEEDED reply: limits the core refuses
// (here more instances than a handle can index) fall back to the defaults, with one warning.
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CORE_LIMITS } from "./AnimationCore";
import { loadAnimationCore } from "./loader";

describe("the core's limits", () => {
  it("falls back to the defaults when the core refuses the limits asked for", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const load = await loadAnimationCore({ maxInstances: 70_000 });
      expect(load.status).toBe("ready");
      if (load.status !== "ready") return;
      expect(load.core.limits).toBe(DEFAULT_CORE_LIMITS);
      expect(load.core.stats().neededBytes).toBeGreaterThan(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/refused its limits/);
    } finally {
      warn.mockRestore();
    }
  });
});
