import { describe, expect, it } from "vitest";
import { loadNavigation } from "../nav/loader";

// ADR 0065, W0: the navigation WebAssembly module loads in Node (as on the dedicated server).
describe("navigation module", () => {
  it("loads once and reports the crate version", async () => {
    const a = loadNavigation();
    const b = loadNavigation();
    expect(a).toBe(b);
    const nav = await a;
    expect(nav.version()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("reads bake files' headers, and says what's wrong with a bad one", async () => {
    const nav = await loadNavigation();
    expect(JSON.parse(nav.bakeInfo(new TextEncoder().encode("not a bake file"), true))).toEqual({ error: expect.stringMatching(/magic|truncated/i) });
  });
});
