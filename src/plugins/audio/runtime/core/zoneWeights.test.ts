// ADR 0162 C5 / L-C5a: zone volumes, weights, normalisation, the send curve, the wet factor and the send (§1.5, §3.2,
// §4.4, S21; architecture §3.3).
import { describe, expect, it } from "vitest";
import { DEFAULT_SEND_CURVE } from "../backend";
import {
  makeZoneVolume,
  normalizeWeights,
  outsideDistance,
  sendCurveGain,
  sendCurveX,
  wetFactor,
  zoneSend,
  zoneVolumeFromMatrix,
  zoneWeight,
  ZONE_SHAPE_BOX,
  ZONE_SHAPE_SPHERE,
} from "./zoneWeights";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe("zone volumes", () => {
  it("an identity box: 0 inside and on the surface, the distance to the nearest face or edge outside", () => {
    const v = zoneVolumeFromMatrix(makeZoneVolume(), IDENTITY, 0, ZONE_SHAPE_BOX, 0, 0, 0, 10, 4, 10, 0);
    expect(v.hx).toBeCloseTo(5, 5);
    expect(v.hy).toBeCloseTo(2, 5);
    expect(v.hz).toBeCloseTo(5, 5);
    expect(outsideDistance(v, 0, 0, 0)).toBeCloseTo(0, 5);
    expect(outsideDistance(v, 5, 2, 5)).toBeCloseTo(0, 5);
    expect(outsideDistance(v, 7, 0, 0)).toBeCloseTo(2, 5);
    expect(outsideDistance(v, 7, 5, 0)).toBeCloseTo(Math.sqrt(13), 5);
    expect(outsideDistance(v, 0, 0, -9)).toBeCloseTo(4, 5);
  });

  it("a rotated, scaled, offset box: centre and half extents in world units", () => {
    // 90° about +Y, scale (2,1,1), translation (10,0,0): local +X -> world -Z (×2), local +Z -> world +X.
    const m = [0, 0, -2, 0, 0, 1, 0, 0, 1, 0, 0, 0, 10, 0, 0, 1];
    const v = zoneVolumeFromMatrix(makeZoneVolume(), m, 0, ZONE_SHAPE_BOX, 1, 0, 0, 10, 4, 10, 0);
    expect(v.cx).toBeCloseTo(10, 5);
    expect(v.cy).toBeCloseTo(0, 5);
    expect(v.cz).toBeCloseTo(-2, 5);
    expect(v.hx).toBeCloseTo(10, 5);
    expect(v.hy).toBeCloseTo(2, 5);
    expect(v.hz).toBeCloseTo(5, 5);
    expect(outsideDistance(v, 10, 0, -13)).toBeCloseTo(1, 5);
    expect(outsideDistance(v, 16, 0, -2)).toBeCloseTo(1, 5);
    expect(outsideDistance(v, 10, 0, -2)).toBeCloseTo(0, 5);
  });

  it("a sphere: radius times the largest scale axis", () => {
    // Scale (1,3,2) at the origin: the largest column length is 3, so radius 5 becomes 15.
    const m = [1, 0, 0, 0, 0, 3, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
    const v = zoneVolumeFromMatrix(makeZoneVolume(), m, 0, ZONE_SHAPE_SPHERE, 0, 0, 0, 10, 4, 10, 5);
    expect(v.shape).toBe(ZONE_SHAPE_SPHERE);
    expect(v.radius).toBeCloseTo(15, 5);
    expect(outsideDistance(v, 20, 0, 0)).toBeCloseTo(5, 5);
    expect(outsideDistance(v, 0, 10, 0)).toBeCloseTo(0, 5);

    const offset = zoneVolumeFromMatrix(makeZoneVolume(), m, 0, ZONE_SHAPE_SPHERE, 1, 0, 0, 10, 4, 10, 5);
    expect(offset.cx).toBeCloseTo(1, 5);
    expect(offset.cy).toBeCloseTo(0, 5);
    expect(offset.cz).toBeCloseTo(0, 5);
    expect(outsideDistance(offset, 17, 0, 0)).toBeCloseTo(1, 5);
  });

  it("negative sizes and zero-length columns", () => {
    const negative = zoneVolumeFromMatrix(makeZoneVolume(), IDENTITY, 0, ZONE_SHAPE_BOX, 0, 0, 0, -4, 4, 4, 0);
    expect(negative.hx).toBeCloseTo(0, 5);
    expect(negative.hy).toBeCloseTo(2, 5);

    // Scale 0 on x: the x column has no length, so its axis is the unit X axis and its half extent is 0.
    const flat = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const v = zoneVolumeFromMatrix(makeZoneVolume(), flat, 0, ZONE_SHAPE_BOX, 0, 0, 0, 10, 4, 10, 0);
    expect(v.r00).toBeCloseTo(1, 5);
    expect(v.r01).toBeCloseTo(0, 5);
    expect(v.r02).toBeCloseTo(0, 5);
    expect(v.hx).toBeCloseTo(0, 5);

    const blank = makeZoneVolume();
    expect(blank.shape).toBe(ZONE_SHAPE_BOX);
    expect([blank.cx, blank.cy, blank.cz]).toEqual([0, 0, 0]);
    expect([blank.r00, blank.r01, blank.r02, blank.r10, blank.r11, blank.r12, blank.r20, blank.r21, blank.r22])
      .toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect([blank.hx, blank.hy, blank.hz, blank.radius]).toEqual([0, 0, 0, 0]);
  });
});

describe("zone weights", () => {
  it("1 inside, linear to 0 over blendDistance, 0 beyond", () => {
    expect(zoneWeight(0, 2)).toBeCloseTo(1, 5);
    expect(zoneWeight(-1, 2)).toBeCloseTo(1, 5);
    expect(zoneWeight(0.5, 2)).toBeCloseTo(0.75, 5);
    expect(zoneWeight(1, 2)).toBeCloseTo(0.5, 5);
    expect(zoneWeight(1.5, 2)).toBeCloseTo(0.25, 5);
    expect(zoneWeight(2, 2)).toBeCloseTo(0, 5);
    expect(zoneWeight(3, 2)).toBeCloseTo(0, 5);
    expect(zoneWeight(NaN, 2)).toBeCloseTo(0, 5);
  });

  it("blendDistance 0 is a hard edge", () => {
    expect(zoneWeight(0, 0)).toBeCloseTo(1, 5);
    expect(zoneWeight(0.001, 0)).toBeCloseTo(0, 5);
    expect(zoneWeight(0, NaN)).toBeCloseTo(1, 5);
    expect(zoneWeight(0.5, NaN)).toBeCloseTo(0, 5);
  });

  it("overlaps normalise only above a total of 1; the total is min(1, norm)", () => {
    const a = Float32Array.from([1, 1]);
    expect(normalizeWeights(a, 2)).toBeCloseTo(1, 5);
    expect(a[0]).toBeCloseTo(0.707107, 5);
    expect(a[1]).toBeCloseTo(0.707107, 5);

    const b = Float32Array.from([1, 0.5]);
    expect(normalizeWeights(b, 2)).toBeCloseTo(1, 5);
    expect(b[0]).toBeCloseTo(0.894427, 5);
    expect(b[1]).toBeCloseTo(0.447214, 5);

    const c = Float32Array.from([0.6, 0.6]);
    expect(normalizeWeights(c, 2)).toBeCloseTo(0.848528, 5);
    expect(c[0]).toBeCloseTo(0.6, 5);
    expect(c[1]).toBeCloseTo(0.6, 5);

    const d = Float32Array.from([0.5]);
    expect(normalizeWeights(d, 1)).toBeCloseTo(0.5, 5);
    expect(d[0]).toBeCloseTo(0.5, 5);

    const e = Float32Array.from([1, 1]);
    expect(normalizeWeights(e, 0)).toBeCloseTo(0, 5);
    expect(e[0]).toBeCloseTo(1, 5);
    expect(e[1]).toBeCloseTo(1, 5);

    const f = Float32Array.from([1, 1, 9]);
    expect(normalizeWeights(f, 2)).toBeCloseTo(1, 5);
    expect(f[0]).toBeCloseTo(0.707107, 5);
    expect(f[1]).toBeCloseTo(0.707107, 5);
    expect(f[2]).toBeCloseTo(9, 5);
  });
});

describe("sends", () => {
  it("the send curve's x and gain against distance", () => {
    expect(sendCurveX(1, 1, 11)).toBeCloseTo(0, 5);
    expect(sendCurveGain(DEFAULT_SEND_CURVE, 1, 1, 11)).toBeCloseTo(1, 5);
    expect(sendCurveX(6, 1, 11)).toBeCloseTo(0.5, 5);
    expect(sendCurveGain(DEFAULT_SEND_CURVE, 6, 1, 11)).toBeCloseTo(0.75, 5);
    expect(sendCurveX(11, 1, 11)).toBeCloseTo(1, 5);
    expect(sendCurveGain(DEFAULT_SEND_CURVE, 11, 1, 11)).toBeCloseTo(0.5, 5);
    expect(sendCurveX(0.5, 1, 11)).toBeCloseTo(0, 5);
    expect(sendCurveGain(DEFAULT_SEND_CURVE, 0.5, 1, 11)).toBeCloseTo(1, 5);
    expect(sendCurveX(50, 1, 11)).toBeCloseTo(1, 5);
    expect(sendCurveGain(DEFAULT_SEND_CURVE, 50, 1, 11)).toBeCloseTo(0.5, 5);

    expect(sendCurveX(5, 5, 5)).toBeCloseTo(0, 5);
    expect(sendCurveGain(DEFAULT_SEND_CURVE, 5, 5, 5)).toBeCloseTo(1, 5);
    expect(sendCurveX(5.01, 5, 5)).toBeCloseTo(1, 5);
    expect(sendCurveGain(DEFAULT_SEND_CURVE, 5.01, 5, 5)).toBeCloseTo(0.5, 5);

    expect(sendCurveX(NaN, 1, 11)).toBeCloseTo(0, 5);

    const flat: [number, number][] = [[0, 3], [1, 3]];
    expect(sendCurveGain(flat, 0.5, 1, 11)).toBeCloseTo(3, 5);
    expect(sendCurveGain(flat, 6, 1, 11)).toBeCloseTo(3, 5);
    expect(sendCurveGain(flat, 50, 1, 11)).toBeCloseTo(3, 5);
  });

  it("the wet factor", () => {
    expect(wetFactor(0.25, 0.6)).toBeCloseTo(0.55, 5);
    expect(wetFactor(1, 0.9)).toBeCloseTo(1, 5);
    expect(wetFactor(0, 1)).toBeCloseTo(0, 5);
    expect(wetFactor(0.5, 0)).toBeCloseTo(1, 5);
    expect(wetFactor(-1, 1)).toBeCloseTo(0, 5);
    expect(wetFactor(2, 1)).toBeCloseTo(1, 5);
    expect(wetFactor(NaN, 1)).toBeCloseTo(1, 5);
    expect(wetFactor(0.5, NaN)).toBeCloseTo(1, 5);
  });

  it("the send, clamped to 4 in the product with the curve; bad inputs give 0", () => {
    expect(zoneSend(0.5, 2, 3, 0.75, 1)).toBeCloseTo(1.5, 5);
    expect(zoneSend(1, 1, 1, 1, 0.55)).toBeCloseTo(0.55, 5);
    expect(zoneSend(1, 1.5, 2, 1, 1)).toBeCloseTo(3, 5);
    expect(zoneSend(1, 2, 2, 1, 1)).toBeCloseTo(4, 5);
    expect(zoneSend(2, 2, 2, 1, 1)).toBeCloseTo(8, 5);
    expect(zoneSend(1, -1, 1, 1, 1)).toBeCloseTo(0, 5);
    expect(zoneSend(1, 1, NaN, 1, 1)).toBeCloseTo(0, 5);
    expect(zoneSend(1, 1, 1, Infinity, 1)).toBeCloseTo(0, 5);
    expect(zoneSend(0, 1, 1, 1, 1)).toBeCloseTo(0, 5);
  });
});
