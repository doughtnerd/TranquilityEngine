// The token gate (ADR 0403; plan task L3): single use, the next code issued after a use or an expiry, 5-minute expiry,
// 5 failures lock LAN connections for 60 s, same-machine bypass, all on an injected clock.
import { describe, expect, it } from "vitest";
import { LOCK_MS, TOKEN_EXPIRY_MS, TokenGate, type GateCaller, type IssuedToken } from "./gate";

const LAN: GateCaller = { sameMachine: false };
const SAME: GateCaller = { sameMachine: true };

/**
 * A gate on a stepped clock (`clock.t`). The random source hands out `queued` tokens first, then 1000, 1001, ...;
 * `drawn` records the bit width of each draw.
 */
function setup(queued: number[] = [], options: { tokenBits?: number } = {}) {
  const clock = { t: 0 };
  const issued: IssuedToken[] = [];
  const drawn: number[] = [];
  let fresh = 1000;
  const gate = new TokenGate({
    now: () => clock.t,
    randomToken: (bits) => {
      drawn.push(bits);
      return queued.length > 0 ? queued.shift()! : fresh++;
    },
    onIssued: (token) => issued.push(token),
    ...options,
  });
  return { gate, clock, issued, drawn };
}

describe("the token gate", () => {
  it("issues a first token at once and tells onIssued", () => {
    const { gate, issued } = setup();
    expect(issued).toEqual([{ token: 1000, issuedAt: 0, expiresAt: TOKEN_EXPIRY_MS, serial: 1 }]);
    expect(gate.current()).toEqual(issued[0]);
    expect(issued).toHaveLength(1);
  });

  it("admits the current token once (via token), then issues the next one; the used token is refused as used", () => {
    const { gate, issued } = setup([42]);
    expect(gate.check(42, LAN)).toEqual({ verdict: "admit", via: "token" });
    expect(issued.map((t) => t.token)).toEqual([42, 1000]);
    expect(issued[1]!.serial).toBe(2);
    expect(gate.current().token).toBe(1000);
    expect(gate.check(42, LAN)).toEqual({ verdict: "refuse", reason: "used" });
    expect(gate.check(1000, LAN)).toEqual({ verdict: "admit", via: "token" });
  });

  it("expires a token after 5 minutes on the clock: current() issues the next one, the old one is refused as expired", () => {
    const { gate, clock, issued } = setup([42]);
    clock.t = TOKEN_EXPIRY_MS - 1;
    expect(gate.current().token).toBe(42);
    expect(issued).toHaveLength(1);
    clock.t = TOKEN_EXPIRY_MS;
    expect(gate.current()).toMatchObject({ token: 1000, issuedAt: TOKEN_EXPIRY_MS, serial: 2 });
    expect(issued).toHaveLength(2);
    expect(gate.check(42, LAN)).toEqual({ verdict: "refuse", reason: "expired" });
  });

  it("refuses a token presented at exactly 5 minutes as expired, even before current() is called", () => {
    const { gate, clock, issued } = setup([42]);
    clock.t = TOKEN_EXPIRY_MS;
    expect(gate.check(42, LAN)).toEqual({ verdict: "refuse", reason: "expired" });
    expect(issued.map((t) => t.token)).toEqual([42, 1000]);
    expect(gate.check(1000, LAN)).toEqual({ verdict: "admit", via: "token" });
  });

  it("refuses a wrong token as bad-token", () => {
    const { gate } = setup([42]);
    expect(gate.check(7, LAN)).toEqual({ verdict: "refuse", reason: "bad-token" });
    expect(gate.current().token).toBe(42);
    expect(gate.check(42, LAN)).toEqual({ verdict: "admit", via: "token" });
  });

  it("locks LAN connections for 60 s after 5 failures: even the right token is refused as locked", () => {
    const { gate } = setup([42]);
    for (const wrong of [1, 2, 3, 4, 5]) {
      expect(gate.check(wrong, LAN)).toEqual({ verdict: "refuse", reason: "bad-token" });
    }
    expect(gate.lockedUntil()).toBe(LOCK_MS);
    expect(gate.check(42, LAN)).toEqual({ verdict: "refuse", reason: "locked" });
    expect(gate.check(undefined, LAN)).toEqual({ verdict: "refuse", reason: "locked" });
  });

  it("does not lock on the 4th failure, but does on the 5th", () => {
    const { gate } = setup([42]);
    for (const wrong of [1, 2, 3, 4]) gate.check(wrong, LAN);
    expect(gate.lockedUntil()).toBeNull();
    expect(gate.check(5, LAN)).toEqual({ verdict: "refuse", reason: "bad-token" });
    expect(gate.lockedUntil()).toBe(LOCK_MS);
  });

  it("lifts the lock at exactly 60 s, and still holds a millisecond before", () => {
    const { gate, clock } = setup([42]);
    for (const wrong of [1, 2, 3, 4, 5]) gate.check(wrong, LAN);
    clock.t = LOCK_MS - 1;
    expect(gate.lockedUntil()).toBe(LOCK_MS);
    expect(gate.check(42, LAN)).toEqual({ verdict: "refuse", reason: "locked" });
    clock.t = LOCK_MS;
    expect(gate.lockedUntil()).toBeNull();
    expect(gate.check(42, LAN)).toEqual({ verdict: "admit", via: "token" });
  });

  it("counts again from zero once the lock ends; a valid token resets the count", () => {
    const { gate, clock } = setup([42]);
    for (const wrong of [1, 2, 3, 4, 5]) gate.check(wrong, LAN);
    clock.t = LOCK_MS;
    for (const wrong of [6, 7, 8, 9]) gate.check(wrong, LAN);
    expect(gate.lockedUntil()).toBeNull();
    gate.check(10, LAN);
    expect(gate.lockedUntil()).toBe(LOCK_MS + LOCK_MS);
  });

  it("a valid token resets the failure count before the lock", () => {
    const { gate } = setup([42, 43]);
    for (const wrong of [1, 2, 3, 4]) gate.check(wrong, LAN);
    expect(gate.check(42, LAN)).toEqual({ verdict: "admit", via: "token" });
    for (const wrong of [5, 6, 7, 8]) gate.check(wrong, LAN);
    expect(gate.lockedUntil()).toBeNull();
    gate.check(9, LAN);
    expect(gate.lockedUntil()).not.toBeNull();
  });

  it("counts a used token and an expired one as failures too", () => {
    const { gate, clock } = setup([42]);
    expect(gate.check(42, LAN)).toEqual({ verdict: "admit", via: "token" });
    expect(gate.check(42, LAN)).toEqual({ verdict: "refuse", reason: "used" });
    clock.t = TOKEN_EXPIRY_MS;
    expect(gate.check(1000, LAN)).toEqual({ verdict: "refuse", reason: "expired" });
    for (const wrong of [1, 2]) gate.check(wrong, LAN);
    expect(gate.lockedUntil()).toBeNull();
    gate.check(3, LAN);
    expect(gate.lockedUntil()).toBe(TOKEN_EXPIRY_MS + LOCK_MS);
  });

  it("admits a same-machine connection with no token, a wrong token, or while locked, without using the token or counting a failure", () => {
    const { gate, issued } = setup([42]);
    expect(gate.check(undefined, SAME)).toEqual({ verdict: "admit", via: "same-machine" });
    expect(gate.check(7, SAME)).toEqual({ verdict: "admit", via: "same-machine" });
    for (const wrong of [1, 2, 3, 4, 5]) gate.check(wrong, SAME);
    expect(gate.lockedUntil()).toBeNull();
    expect(gate.check(undefined, SAME)).toEqual({ verdict: "admit", via: "same-machine" });
    expect(issued).toHaveLength(1);
    expect(gate.current().token).toBe(42);
    expect(gate.check(42, LAN)).toEqual({ verdict: "admit", via: "token" });
  });

  it("answers prompt for a tokenless connection from another machine, without counting a failure", () => {
    const { gate } = setup([42]);
    for (let i = 0; i < 10; i++) expect(gate.check(undefined, LAN)).toEqual({ verdict: "prompt" });
    expect(gate.lockedUntil()).toBeNull();
    for (const wrong of [1, 2, 3, 4]) gate.check(wrong, LAN);
    expect(gate.lockedUntil()).toBeNull();
    expect(gate.check(42, LAN)).toEqual({ verdict: "admit", via: "token" });
  });

  it("draws tokens of tokenBits bits (30 by default, 20 for a LAN room code)", () => {
    const hosted = setup([42]);
    expect(hosted.drawn).toEqual([30]);
    hosted.gate.check(42, LAN);
    expect(hosted.drawn).toEqual([30, 30]);

    const lan = setup([], { tokenBits: 20 });
    expect(lan.drawn).toEqual([20]);
    lan.gate.check(1000, LAN);
    expect(lan.drawn).toEqual([20, 20]);
  });
});
