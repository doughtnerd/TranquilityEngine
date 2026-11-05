import { describe, expect, it } from "vitest";
import { LIGHTNING_SCORE_SCALE, RAM_DAMAGE, SHIP_HP, SHIP_SPEED, STORM_SECONDS, lightningWeight, pickLightningTarget } from "../../../samples/pirates/scripts/data";
import { ramDamage } from "../../../samples/pirates/scripts/systems";
import { heldHelm } from "../../../samples/pirates/scripts/client";

// King of Pirates' tuned rules (samples/pirates/scripts/data.ts): ramming, the storm's length,
// lightning favouring the leaders, and the helm held while the "Leave the match?" dialog is open.

/** A small seeded generator (mulberry32), so the draws are the same every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ship = (team: number, score: number, more: { sunk?: number; invulnerable?: number } = {}) => ({ data: { team, score, sunk: more.sunk ?? 0, invulnerable: more.invulnerable ?? 0 } });

describe("King of Pirates: ramming and the storm", () => {
  it("ramming a rock head-on at full sail costs 9 of the hull's 100 (a third of the first version's 27)", () => {
    expect(RAM_DAMAGE).toBe(1);
    expect(ramDamage(SHIP_SPEED, 1)).toBeCloseTo(9);
    expect(ramDamage(SHIP_SPEED, 1) / SHIP_HP).toBeLessThan(0.1);
    expect(ramDamage(SHIP_SPEED, 0.7)).toBeCloseTo(6.3); // a glancing blow costs less
  });

  it("stormy seas last 10 seconds", () => {
    expect(STORM_SECONDS).toBe(10);
  });
});

describe("King of Pirates: lightning", () => {
  it("weighs ships by score: 1 + score / LIGHTNING_SCORE_SCALE", () => {
    expect(lightningWeight(0)).toBe(1);
    expect(lightningWeight(LIGHTNING_SCORE_SCALE)).toBe(2);
    expect(lightningWeight(30)).toBe(1 + 30 / LIGHTNING_SCORE_SCALE);
    expect(lightningWeight(-5)).toBe(1); // never below the floor
    expect(lightningWeight(50)).toBeGreaterThan(lightningWeight(20));
  });

  it("never strikes the storm's caller, a sunk ship or one that can't be hurt", () => {
    const fleet = [ship(0, 90), ship(1, 0, { sunk: 2 }), ship(2, 40, { invulnerable: 1 }), ship(3, 5)];
    const random = seeded(7);
    for (let i = 0; i < 500; i++) expect(pickLightningTarget(fleet, 0, random())!.data.team).toBe(3);
    expect(pickLightningTarget([ship(0, 10), ship(1, 0, { sunk: 1 })], 0, 0.5)).toBeNull();
    expect(pickLightningTarget([], -1, 0.5)).toBeNull();
  });

  it("strikes leaders more often, in proportion to their weights", () => {
    const fleet = [ship(0, 0), ship(1, 10), ship(2, 30), ship(3, 60)];
    const random = seeded(2026);
    const hits = new Map<number, number>();
    const draws = 40_000;
    for (let i = 0; i < draws; i++) {
      const t = pickLightningTarget(fleet, -1, random())!.data.team;
      hits.set(t, (hits.get(t) ?? 0) + 1);
    }
    const total = fleet.reduce((sum, s) => sum + lightningWeight(s.data.score), 0); // 1 + 2 + 4 + 7 = 14
    for (const s of fleet) expect(hits.get(s.data.team)! / draws).toBeCloseTo(lightningWeight(s.data.score) / total, 2);
    // The leader is struck about seven times as often as a captain on no points.
    expect(hits.get(3)! / hits.get(0)!).toBeGreaterThan(6);
    expect(hits.get(3)! / hits.get(0)!).toBeLessThan(8);
  });

  it("picks across the whole range of the draw", () => {
    const fleet = [ship(1, 0), ship(2, 0)];
    expect(pickLightningTarget(fleet, -1, 0)!.data.team).toBe(1);
    expect(pickLightningTarget(fleet, -1, 0.49)!.data.team).toBe(1);
    expect(pickLightningTarget(fleet, -1, 0.51)!.data.team).toBe(2);
    expect(pickLightningTarget(fleet, -1, 0.999999)!.data.team).toBe(2);
  });
});

describe("King of Pirates: the helm while the leave dialog is open", () => {
  it("holds the course (no steering), doesn't fire or drop a cloud, and keeps the battery", () => {
    const helm = { x: 4, z: 9, steer: 1, battery: 2, fire: 1, drop: 1 };
    expect(heldHelm(helm, false)).toEqual(helm);
    expect(heldHelm(helm, true)).toEqual({ x: 4, z: 9, steer: 0, battery: 2, fire: 0, drop: 0 });
  });
});
