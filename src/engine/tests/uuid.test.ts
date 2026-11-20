import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUuid } from "../core/uuid";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomUuid", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is a v4 UUID, a new one each time", () => {
    const a = randomUuid(), b = randomUuid();
    expect(a).toMatch(V4);
    expect(b).toMatch(V4);
    expect(a).not.toBe(b);
  });

  it("builds one from random bytes where crypto.randomUUID is missing (plain-http pages)", () => {
    const getRandomValues = (b: Uint8Array) => b.fill(0xff);
    vi.stubGlobal("crypto", { getRandomValues });
    expect(randomUuid()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  });

  it("falls back to Math.random without crypto at all", () => {
    vi.stubGlobal("crypto", undefined);
    expect(randomUuid()).toMatch(V4);
  });
});
