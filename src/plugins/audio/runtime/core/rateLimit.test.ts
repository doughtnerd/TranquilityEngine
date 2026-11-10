import { describe, expect, it } from "vitest";
import { RateLimit, RECOVERY_LIMIT, RECOVERY_WINDOW_MS } from "./rateLimit";

/** A limiter on a clock the test moves. */
function rig(limit = RECOVERY_LIMIT, windowMs = RECOVERY_WINDOW_MS) {
  const clock = { t: 1_000 };
  return { clock, limit: new RateLimit(limit, windowMs, () => clock.t) };
}

describe("RateLimit (architecture §7: 3 rebuilds per 60 s)", () => {
  it("defaults to 3 per 60 s", () => {
    expect(RECOVERY_LIMIT).toBe(3);
    expect(RECOVERY_WINDOW_MS).toBe(60_000);
  });

  it("grants three in a row and refuses the 4th inside the window", () => {
    const { clock, limit } = rig();
    expect(limit.take()).toBe(true);
    clock.t += 10_000;
    expect(limit.take()).toBe(true);
    clock.t += 10_000;
    expect(limit.take()).toBe(true);
    expect(limit.count).toBe(3);
    clock.t += 39_999; // 59.999 s after the first
    expect(limit.take()).toBe(false);
    expect(limit.count).toBe(3);
  });

  it("a refusal records nothing, and the oldest grant leaving the window frees one slot", () => {
    const { clock, limit } = rig();
    limit.take(); // t = 1 s
    clock.t += 1_000;
    limit.take(); // 2 s
    clock.t += 1_000;
    limit.take(); // 3 s
    clock.t += 1_000;
    expect(limit.take()).toBe(false); // 4 s
    clock.t = 1_000 + 60_000; // exactly 60 s after the first: it has left the window
    expect(limit.count).toBe(2);
    expect(limit.take()).toBe(true);
    expect(limit.take()).toBe(false); // the 2 s and 3 s grants are still inside
    clock.t = 3_000 + 60_000;
    expect(limit.count).toBe(1);
    expect(limit.take()).toBe(true);
    expect(limit.take()).toBe(true);
    expect(limit.take()).toBe(false);
  });

  it("a trap long after the window starts a fresh count", () => {
    const { clock, limit } = rig();
    for (let i = 0; i < 3; i++) expect(limit.take()).toBe(true);
    clock.t += 3_600_000;
    expect(limit.count).toBe(0);
    for (let i = 0; i < 3; i++) expect(limit.take()).toBe(true);
    expect(limit.take()).toBe(false);
  });

  it("reset forgets every grant", () => {
    const { limit } = rig();
    for (let i = 0; i < 3; i++) limit.take();
    limit.reset();
    expect(limit.count).toBe(0);
    expect(limit.take()).toBe(true);
  });

  it("other limits and windows; bad arguments throw", () => {
    const { clock, limit } = rig(1, 100);
    expect(limit.take()).toBe(true);
    expect(limit.take()).toBe(false);
    clock.t += 100;
    expect(limit.take()).toBe(true);
    expect(() => new RateLimit(0, 100)).toThrow(RangeError);
    expect(() => new RateLimit(1.5, 100)).toThrow(RangeError);
    expect(() => new RateLimit(3, 0)).toThrow(RangeError);
  });
});
