// ADR 0157, task A1.5: distance and cone values match Blink's distance_effect and cone_effect (pinned commit in
// spatial.ts). The expected numbers are worked out by hand from upstream's formulas, not read off the code.
import { describe, expect, it } from "vitest";
import { ConeEffect, DistanceEffect, listenerSpaceDirection, type Vec3 } from "./spatial";

const TOL = 1e-12;
const near = (actual: number, expected: number) => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(TOL);
};
const nearVec = (actual: Vec3, expected: Vec3) => {
  for (let i = 0; i < 3; i++) near(actual[i], expected[i]);
};

function distance(model: DistanceEffect["model"], ref: number, max: number, rolloff: number) {
  const d = new DistanceEffect();
  d.model = model;
  d.refDistance = ref;
  d.maxDistance = max;
  d.rolloffFactor = rolloff;
  return d;
}

describe("DistanceEffect defaults", () => {
  it("is the inverse model with ref 1, max 10000, rolloff 1", () => {
    const d = new DistanceEffect();
    expect([d.model, d.refDistance, d.maxDistance, d.rolloffFactor]).toEqual(["inverse", 1, 10000, 1]);
    near(d.gain(2), 1 / 2); // 1 / (1 + 1 * (2 - 1))
  });
});

describe("DistanceEffect inverse", () => {
  // ref 1, rolloff 1: gain = 1 / (1 + (d - 1))
  it("is 1 at and below refDistance (distance clamps up to ref)", () => {
    const d = distance("inverse", 1, 10000, 1);
    near(d.gain(0.5), 1); // clamped to 1: 1 / (1 + 0)
    near(d.gain(1), 1);
  });
  it("falls as 1 / d for ref 1, rolloff 1", () => {
    const d = distance("inverse", 1, 10000, 1);
    near(d.gain(2), 1 / 2);
    near(d.gain(5), 1 / 5);
  });
  it("ignores maxDistance (only the minimum clamp applies)", () => {
    const d = distance("inverse", 1, 10, 1);
    near(d.gain(20000), 1 / 20000); // 1 / (1 + 19999)
  });
  it("is unity at every distance with rolloff 0", () => {
    const d = distance("inverse", 1, 10000, 0);
    near(d.gain(7), 1);
    near(d.gain(0.2), 1);
  });
  it("treats a rolloff above 1 as written (no upper clamp)", () => {
    const d = distance("inverse", 2, 10000, 2);
    near(d.gain(6), 2 / 10); // 2 / (2 + 2 * (6 - 2))
  });
  it("uses a fractional rolloff directly", () => {
    const d = distance("inverse", 1, 10000, 0.5);
    near(d.gain(3), 1 / 2); // 1 / (1 + 0.5 * 2)
  });
  it("clamps a negative rolloff to 0 (unity gain)", () => {
    const d = distance("inverse", 1, 10000, -1);
    near(d.gain(9), 1);
  });
  it("is 0 when refDistance is 0", () => {
    const d = distance("inverse", 0, 10000, 1);
    expect(d.gain(5)).toBe(0);
  });
});

describe("DistanceEffect exponential", () => {
  // ref 1, rolloff 1: gain = d ^ -1
  it("is 1 at and below refDistance", () => {
    const d = distance("exponential", 1, 10000, 1);
    near(d.gain(0.5), 1);
    near(d.gain(1), 1);
  });
  it("falls as 1 / d for ref 1, rolloff 1", () => {
    const d = distance("exponential", 1, 10000, 1);
    near(d.gain(2), 1 / 2);
    near(d.gain(4), 1 / 4);
  });
  it("ignores maxDistance", () => {
    const d = distance("exponential", 1, 10, 1);
    near(d.gain(20000), 1 / 20000);
  });
  it("uses a rolloff above 1 as written", () => {
    const d = distance("exponential", 1, 10000, 2);
    near(d.gain(3), 1 / 9); // 3 ^ -2
  });
  it("is unity at every distance with rolloff 0", () => {
    const d = distance("exponential", 1, 10000, 0);
    near(d.gain(10), 1);
  });
  it("handles a fractional rolloff and a larger refDistance", () => {
    const d = distance("exponential", 4, 10000, 0.5);
    near(d.gain(16), 1 / 2); // (16 / 4) ^ -0.5 = 4 ^ -0.5
  });
  it("scales distance by refDistance", () => {
    const d = distance("exponential", 2, 10000, 1);
    near(d.gain(8), 1 / 4); // (8 / 2) ^ -1
  });
  it("clamps a negative rolloff to 0 (unity gain)", () => {
    const d = distance("exponential", 1, 10000, -1);
    near(d.gain(9), 1);
  });
  it("is 0 when refDistance is 0", () => {
    const d = distance("exponential", 0, 10000, 1);
    expect(d.gain(5)).toBe(0);
  });
});

describe("DistanceEffect linear", () => {
  // ref 1, max 11, rolloff 1: gain = 1 - (d - 1) / 10 on [1, 11], clamped outside
  it("is 1 at and below refDistance", () => {
    const d = distance("linear", 1, 11, 1);
    near(d.gain(0.5), 1);
    near(d.gain(1), 1);
  });
  it("falls linearly to 0 at maxDistance", () => {
    const d = distance("linear", 1, 11, 1);
    near(d.gain(6), 1 / 2); // 1 - 1 * 5 / 10
    near(d.gain(11), 0);
  });
  it("is 0 beyond maxDistance", () => {
    const d = distance("linear", 1, 11, 1);
    near(d.gain(20), 0);
  });
  it("scales the fall by rolloff", () => {
    const d = distance("linear", 1, 11, 0.5);
    near(d.gain(6), 3 / 4); // 1 - 0.5 * 5 / 10
  });
  it("is unity at every distance with rolloff 0", () => {
    const d = distance("linear", 1, 11, 0);
    near(d.gain(6), 1);
    near(d.gain(11), 1);
  });
  it("clamps a rolloff above 1 to 1", () => {
    const d = distance("linear", 1, 11, 2);
    near(d.gain(6), 1 / 2); // same as rolloff 1, not 1 - 2 * 0.5
  });
  it("clamps a negative rolloff to 0", () => {
    const d = distance("linear", 1, 11, -1);
    near(d.gain(6), 1);
  });
  it("swaps reversed ref and max", () => {
    // ref 10, max 2: refDistance-to-max span is [2, 10]
    const d = distance("linear", 10, 2, 1);
    near(d.gain(6), 1 / 2); // 1 - (6 - 2) / 8
    near(d.gain(1), 1); // clamped to 2
    near(d.gain(12), 0); // clamped to 10
  });
  it("returns 1 - rolloff, unclamped, when ref equals max", () => {
    const d = distance("linear", 5, 5, 0.3);
    near(d.gain(7), 0.7);
    near(d.gain(1), 0.7);
    const big = distance("linear", 5, 5, 2);
    near(big.gain(5), -1); // upstream does not clamp the rolloff on this branch
  });
});

describe("ConeEffect", () => {
  const facing = [0, 0, -1] as const; // the source faces -Z
  const origin = [0, 0, 0] as const;
  const at = (degrees: number, r: number): Vec3 => {
    const rad = (degrees * Math.PI) / 180;
    return [r * Math.sin(rad), 0, -r * Math.cos(rad)];
  };

  it("has no cone by default (both angles 360) and an outer gain of 0", () => {
    const c = new ConeEffect();
    expect([c.innerAngle, c.outerAngle, c.outerGain]).toEqual([360, 360, 0]);
    near(c.gain(origin, facing, [0, 0, 5]), 1); // behind, but no cone
  });

  it("is unity for a zero orientation", () => {
    const c = new ConeEffect();
    c.innerAngle = 60;
    c.outerAngle = 120;
    c.outerGain = 0.25;
    near(c.gain(origin, [0, 0, 0], [0, 0, 5]), 1);
  });

  describe("inner 60, outer 120, outer gain 0.25 (half angles 30 and 60)", () => {
    const cone = () => {
      const c = new ConeEffect();
      c.innerAngle = 60;
      c.outerAngle = 120;
      c.outerGain = 0.25;
      return c;
    };

    it("is 1 inside the inner cone", () => {
      near(cone().gain(origin, facing, at(0, 5)), 1);
      near(cone().gain(origin, facing, at(20, 5)), 1);
    });
    it("is outerGain at 90 degrees (outside the outer cone)", () => {
      near(cone().gain(origin, facing, [5, 0, 0]), 0.25);
    });
    it("is outerGain behind the source", () => {
      near(cone().gain(origin, facing, [0, 0, 5]), 0.25);
    });
    it("interpolates between the cones: 40 degrees gives 0.75", () => {
      // x = (40 - 30) / (60 - 30) = 1/3; gain = (1 - 1/3) + 0.25 * 1/3 = 3/4
      near(cone().gain(origin, facing, at(40, 3)), 3 / 4);
    });
    it("interpolates at 45 degrees: x = 1/2, gain 0.625", () => {
      // x = (45 - 30) / 30 = 1/2; gain = 1/2 + 0.25 / 2
      near(cone().gain(origin, facing, [Math.SQRT2, 0, -Math.SQRT2]), 0.625);
    });
    it("uses the absolute value of negative angles", () => {
      const c = new ConeEffect();
      c.innerAngle = -60;
      c.outerAngle = -120;
      c.outerGain = 0.25;
      near(c.gain(origin, facing, [Math.SQRT2, 0, -Math.SQRT2]), 0.625);
    });
    it("does not depend on the length of the orientation", () => {
      near(cone().gain(origin, [0, 0, -7], [Math.SQRT2, 0, -Math.SQRT2]), 0.625);
    });
    it("measures the angle from the source position, not the origin", () => {
      const src: Vec3 = [10, 0, 10];
      near(cone().gain(src, facing, [10 + Math.SQRT2, 0, 10 - Math.SQRT2]), 0.625);
    });
  });

  it("is unity inside a 180-degree half angle (inner 360, outer 90)", () => {
    const c = new ConeEffect();
    c.innerAngle = 360;
    c.outerAngle = 90;
    c.outerGain = 0;
    near(c.gain(origin, facing, [0, 0, 5]), 1); // exactly 180: at the inner edge
  });

  it("halves the way between a 45-degree inner and 90-degree outer half angle at 67.5 degrees", () => {
    const c = new ConeEffect();
    c.innerAngle = 90;
    c.outerAngle = 180;
    c.outerGain = 0;
    // x = (67.5 - 45) / (90 - 45) = 1/2; gain = 1/2 + 0 * 1/2
    near(c.gain(origin, facing, at(67.5, 1)), 1 / 2);
  });
});

describe("listenerSpaceDirection", () => {
  // Engine world: left-handed, +Z forward (ADR 0164). Listener space stays right-handed: -Z ahead, +X right.
  const origin: Vec3 = [0, 0, 0];
  const forward: Vec3 = [0, 0, 1];
  const up: Vec3 = [0, 1, 0];

  it("a source ahead (+Z) is -Z", () => {
    const r = listenerSpaceDirection([0, 0, 5], origin, forward, up);
    nearVec(r.direction, [0, 0, -1]);
    near(r.distance, 5);
  });
  it("a source to the right (+X) is +X", () => {
    const r = listenerSpaceDirection([3, 0, 0], origin, forward, up);
    nearVec(r.direction, [1, 0, 0]);
    near(r.distance, 3);
  });
  it("a source to the left (-X) is -X", () => {
    const r = listenerSpaceDirection([-1, 0, 0], origin, forward, up);
    nearVec(r.direction, [-1, 0, 0]);
    near(r.distance, 1);
  });
  it("a source behind (-Z) is +Z", () => {
    const r = listenerSpaceDirection([0, 0, -4], origin, forward, up);
    nearVec(r.direction, [0, 0, 1]);
    near(r.distance, 4);
  });
  it("a source above is +Y", () => {
    const r = listenerSpaceDirection([0, 2, 0], origin, forward, up);
    nearVec(r.direction, [0, 1, 0]);
    near(r.distance, 2);
  });
  it("is relative to the listener's position", () => {
    const r = listenerSpaceDirection([1, 1, 6], [1, 1, 1], forward, up);
    nearVec(r.direction, [0, 0, -1]);
    near(r.distance, 5);
  });
  it("normalises a non-unit forward", () => {
    const r = listenerSpaceDirection([0, 0, 5], origin, [0, 0, 10], up);
    nearVec(r.direction, [0, 0, -1]);
    near(r.distance, 5);
  });
  it("follows a turned listener: facing +X (turned right), right is -Z", () => {
    const facingX: Vec3 = [1, 0, 0];
    nearVec(listenerSpaceDirection([5, 0, 0], origin, facingX, up).direction, [0, 0, -1]); // ahead
    nearVec(listenerSpaceDirection([0, 0, -3], origin, facingX, up).direction, [1, 0, 0]); // right
    near(listenerSpaceDirection([0, 0, -3], origin, facingX, up).distance, 3);
  });
  it("orthonormalises an up vector that is not perpendicular to forward", () => {
    const tilted: Vec3 = [0, 1, -1];
    nearVec(listenerSpaceDirection([0, 2, 0], origin, forward, tilted).direction, [0, 1, 0]);
    const r = listenerSpaceDirection([0, 1, -1], origin, forward, tilted);
    nearVec(r.direction, [0, Math.SQRT1_2, Math.SQRT1_2]);
    near(r.distance, Math.SQRT2);
  });
  it("gives a zero direction and distance for a coincident source", () => {
    const r = listenerSpaceDirection(origin, origin, forward, up);
    nearVec(r.direction, [0, 0, 0]);
    expect(r.distance).toBe(0);
  });
  it("gives a zero direction for a degenerate frame (up parallel to forward)", () => {
    const r = listenerSpaceDirection([0, 0, 5], origin, forward, [0, 0, 1]);
    nearVec(r.direction, [0, 0, 0]);
    near(r.distance, 5);
  });
});
