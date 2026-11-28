/**
 * The wake shader (ADR 0445), written once in KSL (ADR 0250): the water's renderer splices it into
 * its fragment shader (and, in "field" mode, its vertex shader). It reads what `wakes.ts` packs:
 * - `mycoWake` (mode: 0 off, 1 trail, 2 field; trail wakes in use; water time; unused);
 * - `mycoWakeArea` (the field's world origin x, z, its side and its cells per side);
 * - `mycoWakeTrail`: `MAX_WAKES` rows of `TRAIL_TEXELS` RGBA texels (layout in `wakes.ts`' `trailRow`);
 * - `mycoWakeField`: the height field, RGBA per cell (height, ∂h/∂x, ∂h/∂z, foam).
 * Both textures are float, sampled at texel centres (no filtering needed; the field is interpolated here).
 *
 * `mycoWakeAt(p)` at world (x, z) returns (∂h/∂x, ∂h/∂z, foam, height): the surface's slope to add, the
 * foam to mix in and the wake's height there (the water lightens its crests by it, as it does its own
 * waves'). `mycoWakeHeight(p)` is the field's height, for the vertex (0 in the other modes).
 */
import { shaderSource } from "../shaderSource/shaderSource";
import { MAX_WAKES, TRAIL_HEADER, TRAIL_POINTS, TRAIL_TEXELS } from "./wakes";

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);
const deg = (d: number) => (d * Math.PI) / 180;
/** The Kelvin wedge's half-angle (arcsin 1/3 ≈ 19.47°): its tangent. */
const KELVIN_TAN = Math.tan(Math.asin(1 / 3));
/** Divergent crests run about 35° off the path. */
const DIV = deg(35);
/** The bow wave's arms: 32° off the keel. */
const BOW = deg(32);

/** The texture declarations the plugin's samplers need, in both stages (part of `WAKE_SHADER`; a material plugin that omits declarations writes these out itself). */
export const WAKE_TEXTURES = shaderSource(/* KSL */ `
TEXTURE2D(mycoWakeTrail);
TEXTURE2D(mycoWakeField);
`);

export const WAKE_SHADER = shaderSource(WAKE_TEXTURES, /* KSL */ `
UNIFORM(KV4, mycoWake);
UNIFORM(KV4, mycoWakeArea);
FN(KF, mycoWakeHash, KV2 p0) {
  VAR(KV2, p) = fract(p0 * KV2(127.1, 311.7));
  p = p + KV2(dot(p, p + KV2(19.19)));
  return fract(p.x * p.y);
}
FN(KF, mycoWakeNoise, KV2 p) {
  VAR(KV2, i) = floor(p);
  VAR(KV2, t) = fract(p);
  VAR(KV2, u) = t * t * (3.0 - 2.0 * t);
  VAR(KF, a) = mycoWakeHash(i);
  VAR(KF, b) = mycoWakeHash(i + KV2(1.0, 0.0));
  VAR(KF, c) = mycoWakeHash(i + KV2(0.0, 1.0));
  VAR(KF, d) = mycoWakeHash(i + KV2(1.0, 1.0));
  return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
}
FN(KF, mycoWakeGrain, KV2 p, KF time) {
  return 0.65 * mycoWakeNoise(p * 1.9 + KV2(time * 0.31, -time * 0.17)) + 0.35 * mycoWakeNoise(p * 4.7 - KV2(time * 0.23, time * 0.41));
}
FN(KV4, mycoTrailTexel, KI wake, KI i) {
  return KTEX(mycoWakeTrail, KV2((KF(i) + 0.5) / ${f(TRAIL_TEXELS)}, (KF(wake) + 0.5) / ${f(MAX_WAKES)}));
}
FN(KV4, mycoTrailWake, KV2 p) {
  VAR(KV4, acc) = KV4(0.0);
  VAR(KI, count) = KI(UNI(mycoWake).y + 0.5);
  VAR(KF, time) = UNI(mycoWake).z;
  VAR(KF, grain) = mycoWakeGrain(p, time);
  for (VAR(KI, w) = 0; w < ${MAX_WAKES}; w++) {
    if (w >= count) { break; }
    VAR(KV4, bounds) = mycoTrailTexel(w, 2);
    if (length(p - bounds.xy) > bounds.z) { continue; }
    VAR(KV4, head) = mycoTrailTexel(w, 0);
    VAR(KI, n) = KI(head.x + 0.5);
    VAR(KF, width) = head.y;
    // The nearest point of the path: how far across it (signed), how far behind the stern along it, its age and strength.
    VAR(KF, best) = 1e9;
    VAR(KF, across) = 0.0;
    VAR(KF, behind) = 0.0;
    VAR(KF, age) = 1.0;
    VAR(KF, laid) = 0.0;
    VAR(KV2, dir) = KV2(1.0, 0.0);
    VAR(KF, run) = 0.0;
    VAR(KV4, p0) = mycoTrailTexel(w, ${TRAIL_HEADER});
    for (VAR(KI, i) = 1; i < ${TRAIL_POINTS}; i++) {
      if (i >= n) { break; }
      VAR(KV4, p1) = mycoTrailTexel(w, ${TRAIL_HEADER} + i);
      VAR(KV2, seg) = p1.xy - p0.xy;
      VAR(KF, len) = max(length(seg), 1e-4);
      VAR(KV2, t) = seg / len;
      VAR(KF, u) = clamp(dot(p - p0.xy, t) / len, 0.0, 1.0);
      VAR(KV2, q) = p0.xy + seg * u;
      VAR(KF, dist) = length(p - q);
      if (dist < best) {
        best = dist;
        // Signed by side, but the true distance, so water off the path's ends is as far as it really is.
        across = select(-dist, dist, t.x * (p.y - q.y) - t.y * (p.x - q.x) >= 0.0);
        behind = run + len * u;
        age = mix(p0.z, p1.z, u);
        laid = mix(p0.w, p1.w, u);
        dir = t;
      }
      run = run + len;
      p0 = p1;
    }
    if (best < 1e8) {
      // Fading with age, and tapering over the last metres of the path so it never ends in a ring.
      VAR(KF, taper) = smoothstep(0.0, 3.0, run - behind);
      VAR(KF, fade) = (1.0 - age) * taper;
      VAR(KF, side) = abs(across);
      // The foam trail: a band widening with age, torn into streaks along the path (noise stretched
      // along it), thinning out as it ages.
      VAR(KF, halfW) = 0.5 * width * (1.0 + 0.9 * age);
      VAR(KF, band) = 1.0 - smoothstep(halfW * 0.2, halfW, side);
      VAR(KF, streak) = mycoWakeNoise(KV2(behind * 0.35, across * 2.2)) * 0.6 + mycoWakeNoise(KV2(behind * 0.9 + 7.0, across * 4.5)) * 0.4;
      VAR(KF, breakup) = smoothstep(0.3 + 0.35 * age, 0.75 + 0.1 * age, streak * 0.7 + grain * 0.3 + 0.25 * (1.0 - age));
      acc.z = max(acc.z, head.z * laid * fade * clamp(band * breakup, 0.0, 1.0));
      // Kelvin waves: divergent crests inside the wedge (about ${f(Math.round(DIV * 180 / Math.PI))}° off the path), transverse ones nearer the path.
      VAR(KF, wedge) = behind * ${f(KELVIN_TAN)} + 0.5 * width;
      VAR(KF, inWedge) = (1.0 - smoothstep(wedge * 0.75, wedge * 1.1, side)) * smoothstep(0.0, 1.5, behind);
      VAR(KF, amp) = head.w * laid * fade * inWedge;
      VAR(KF, ph) = 2.2 * (side * ${f(Math.cos(DIV))} - behind * ${f(Math.sin(DIV))}) - time * 3.0;
      VAR(KF, div) = amp * 0.18 * 2.2 * cos(ph);
      acc.w = acc.w + amp * 0.18 * sin(ph);
      VAR(KF, inner) = 1.0 - smoothstep(wedge * 0.3, wedge * 0.7, side);
      VAR(KF, tr) = amp * inner * 0.1 * 1.6 * cos(1.6 * behind - time * 2.0);
      acc.w = acc.w + amp * inner * 0.1 * sin(1.6 * behind - time * 2.0);
      VAR(KF, sgn) = select(-1.0, 1.0, across >= 0.0);
      VAR(KF, gAlong) = tr - div * ${f(Math.sin(DIV))};
      VAR(KF, gAcross) = div * ${f(Math.cos(DIV))} * sgn;
      VAR(KV2, g) = dir * gAlong + KV2(-dir.y, dir.x) * gAcross;
      acc = acc + KV4(g, 0.0, 0.0);
    }
    // The bow wave: a V of foam and a raised crest from the stem, its arms as long as the boat is fast.
    VAR(KV4, extra) = mycoTrailTexel(w, 3);
    if (extra.x > 0.01) {
      VAR(KV4, stem) = mycoTrailTexel(w, 1);
      VAR(KV2, rel) = p - stem.xy;
      VAR(KF, back) = -dot(rel, stem.zw);
      VAR(KF, off) = dot(rel, KV2(-stem.w, stem.z));
      VAR(KF, arm) = (abs(off) - max(back, 0.0) * ${f(Math.tan(BOW))}) * ${f(Math.cos(BOW))};
      VAR(KF, on) = smoothstep(-0.4, 0.1, back) * (1.0 - smoothstep(0.6, 1.0, back / max(bounds.w, 0.1)));
      VAR(KF, crest) = exp(-arm * arm / 0.15);
      acc.z = max(acc.z, clamp(head.z * 1.4 * extra.x * on * crest * (0.5 + 0.8 * grain), 0.0, 1.0));
      // The crest's slope: up toward it from both sides, across the arm (outward from the keel).
      VAR(KF, lift) = crest * 0.1 * extra.x * on * head.w;
      acc.w = acc.w + lift;
      VAR(KF, rise) = -2.0 * arm / 0.15 * lift;
      VAR(KF, outward) = select(-1.0, 1.0, off >= 0.0);
      VAR(KV2, normalArm) = KV2(-stem.w, stem.z) * (outward * ${f(Math.cos(BOW))}) - stem.zw * ${f(Math.sin(BOW))};
      acc = acc + KV4(normalArm * rise, 0.0, 0.0);
    }
  }
  return acc;
}
FN(KV4, mycoFieldAt, KV2 p) {
  VAR(KV4, area) = UNI(mycoWakeArea);
  VAR(KF, n) = area.w;
  VAR(KV2, c) = (p - area.xy) / area.z * n - KV2(0.5);
  if (c.x < 0.0 || c.y < 0.0 || c.x > n - 1.0 || c.y > n - 1.0) { return KV4(0.0); }
  VAR(KV2, i) = floor(c);
  VAR(KV2, t) = c - i;
  VAR(KV4, c00) = KTEX(mycoWakeField, (i + KV2(0.5, 0.5)) / n);
  VAR(KV4, c10) = KTEX(mycoWakeField, (i + KV2(1.5, 0.5)) / n);
  VAR(KV4, c01) = KTEX(mycoWakeField, (i + KV2(0.5, 1.5)) / n);
  VAR(KV4, c11) = KTEX(mycoWakeField, (i + KV2(1.5, 1.5)) / n);
  VAR(KV4, v) = mix(mix(c00, c10, t.x), mix(c01, c11, t.x), t.y);
  // Fade to still water over the field's outer tenth, so its edge never shows.
  VAR(KV2, e) = min(c, KV2(n - 1.0) - c) / (n * 0.1);
  return v * clamp(min(e.x, e.y), 0.0, 1.0);
}
FN(KV4, mycoFieldWake, KV2 p) {
  VAR(KV4, v) = mycoFieldAt(p);
  VAR(KF, grain) = mycoWakeGrain(p, UNI(mycoWake).z);
  VAR(KF, foam) = clamp(v.w * 1.2, 0.0, 1.0) * smoothstep(0.35, 0.8, grain + 0.35 * v.w);
  // The field's slopes, a little steeper than the simulated water's, so its ripples read from a ship-game camera.
  return KV4(v.y * 1.6, v.z * 1.6, foam, v.x);
}
FN(KV4, mycoWakeAt, KV2 p) {
  VAR(KF, mode) = UNI(mycoWake).x;
  if (mode > 1.5) { return mycoFieldWake(p); }
  if (mode > 0.5) { return mycoTrailWake(p); }
  return KV4(0.0);
}
FN(KF, mycoWakeHeight, KV2 p) {
  if (UNI(mycoWake).x > 1.5) { return mycoFieldAt(p).x; }
  return 0.0;
}
`);

/** The `mycoWake` mode number for a wake mode. */
export function wakeModeNumber(mode: string): number {
  return mode === "field" ? 2 : mode === "trail" ? 1 : 0;
}
