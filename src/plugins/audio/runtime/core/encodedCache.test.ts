import { describe, expect, it } from "vitest";
import { createEncodedCache, ENCODED_CACHE_CAP_BYTES } from "./encodedCache";

const MB = 1024 * 1024;

describe("encodedCache (A1.3a-L2)", () => {
  it("set then get returns the same buffer; has and size agree", () => {
    const cache = createEncodedCache(1024);
    const buf = new ArrayBuffer(100);
    expect(cache.set("a.ogg", buf)).toBe(true);
    expect(cache.get("a.ogg")).toBe(buf);
    expect(cache.has("a.ogg")).toBe(true);
    expect(cache.has("b.ogg")).toBe(false);
    expect(cache.get("b.ogg")).toBeUndefined();
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(100);
  });

  it("refuses an entry that would pass the cap and stores nothing", () => {
    const cache = createEncodedCache(100);
    expect(cache.set("a.ogg", new ArrayBuffer(60))).toBe(true);
    expect(cache.set("b.ogg", new ArrayBuffer(41))).toBe(false);
    expect(cache.has("b.ogg")).toBe(false);
    expect(cache.get("b.ogg")).toBeUndefined();
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(60);
  });

  it("an entry exactly filling the cap is accepted", () => {
    const cache = createEncodedCache(100);
    expect(cache.set("a.ogg", new ArrayBuffer(60))).toBe(true);
    expect(cache.set("b.ogg", new ArrayBuffer(40))).toBe(true);
    expect(cache.bytes).toBe(100);
    expect(cache.size).toBe(2);
  });

  it("replacing a path counts the new size against the cap, not both", () => {
    const cache = createEncodedCache(100);
    const first = new ArrayBuffer(60);
    const second = new ArrayBuffer(90);
    expect(cache.set("a.ogg", first)).toBe(true);
    // 60 + 90 would exceed 100, but replacing a.ogg leaves only 90 held.
    expect(cache.set("a.ogg", second)).toBe(true);
    expect(cache.get("a.ogg")).toBe(second);
    expect(cache.bytes).toBe(90);
    expect(cache.size).toBe(1);
  });

  it("a refused replacement leaves the old entry for the path in place", () => {
    const cache = createEncodedCache(100);
    const first = new ArrayBuffer(60);
    expect(cache.set("a.ogg", first)).toBe(true);
    expect(cache.set("a.ogg", new ArrayBuffer(101))).toBe(false);
    expect(cache.get("a.ogg")).toBe(first);
    expect(cache.bytes).toBe(60);
    expect(cache.size).toBe(1);
  });

  it("delete frees its bytes and reports whether it existed", () => {
    const cache = createEncodedCache(100);
    cache.set("a.ogg", new ArrayBuffer(60));
    cache.set("b.ogg", new ArrayBuffer(30));
    expect(cache.delete("a.ogg")).toBe(true);
    expect(cache.has("a.ogg")).toBe(false);
    expect(cache.bytes).toBe(30);
    expect(cache.size).toBe(1);
    expect(cache.delete("a.ogg")).toBe(false);
    expect(cache.bytes).toBe(30);
    expect(cache.delete("missing.ogg")).toBe(false);
  });

  it("clear empties the cache", () => {
    const cache = createEncodedCache(100);
    cache.set("a.ogg", new ArrayBuffer(60));
    cache.set("b.ogg", new ArrayBuffer(30));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
    expect(cache.has("a.ogg")).toBe(false);
    expect(cache.get("b.ogg")).toBeUndefined();
    // The freed space is usable again.
    expect(cache.set("c.ogg", new ArrayBuffer(100))).toBe(true);
  });

  it("a default cache caps at 32 MB", () => {
    expect(ENCODED_CACHE_CAP_BYTES).toBe(32 * MB);
    const cache = createEncodedCache();
    expect(cache.set("big.ogg", new ArrayBuffer(32 * MB))).toBe(true);
    expect(cache.bytes).toBe(32 * MB);
    expect(cache.set("one.ogg", new ArrayBuffer(1))).toBe(false);
    expect(cache.has("one.ogg")).toBe(false);
    expect(cache.bytes).toBe(32 * MB);
  });
});
