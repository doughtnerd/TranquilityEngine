/**
 * The procedural sky's shaders (ADR 0112), in WGSL for WebGPU and GLSL for the WebGL2 fallback.
 * One sky function (`skyColor`, written once in KSL, ADR 0250) serves two programs:
 *
 * - `mycoSky`: the sky drawn behind each camera, a box around it whose local vertex positions are
 *   the view directions (a ShaderMaterial).
 * - `mycoSkyBake`: one cube face of the bake per draw (an EffectWrapper over Babylon's full-screen
 *   quad), mapping the quad to a face's directions as Babylon's HDR filtering does.
 *
 * Every parameter is a vec4 uniform (`SKY_UNIFORMS`), packed on the CPU by `skyUniforms.ts`.
 * Images (sRGB) are decoded with a 2.2 power. Textures are sampled at level 0 (`textureSampleLevel`) so WGSL may sample in non-uniform control flow.
 */
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore.js";
import { shaderSource } from "../../shaderSource/shaderSource";

export const SKY_SHADER = "mycoSky";
export const SKY_BAKE_SHADER = "mycoSkyBake";

/** The sky's vec4 uniforms, in packing order (see `skyUniforms.ts` for each one's components). */
export const SKY_UNIFORMS = [
  "sunDir", // xyz towards the sun, w mode (0 atmosphere, 1 gradient)
  "moonDir", // xyz towards the moon, w 1 while baking (no discs or stars)
  "sunDisc", // cos(angular radius), glow, intensity (0 = off), -
  "sunTint", // rgb disc colour, w sun radiance for the atmosphere
  "moonDisc", // cos(angular radius), glow, intensity (0 = off), 1 if textured
  "moonTint", // rgb, w earthshine
  "atmos", // Rayleigh scale, Mie scale, Mie anisotropy g, viewer height (m)
  "groundCol", // rgb lit ground (atmosphere mode), w -
  "zenithCol", // rgb, w gradient sharpness
  "horizonCol", // rgb, w -
  "groundGrad", // rgb gradient ground, w -
  "cloudA", // coverage, density, 1/scale, curvature
  "cloudADrift", // offset x, offset z, 1 if on, -
  "cloudACol", // rgb
  "cloudB",
  "cloudBDrift",
  "cloudBCol",
  "cloudLit", // rgb direct light on clouds
  "cloudAmb", // rgb ambient light on clouds
  "stars", // threshold (1 - density), brightness, twinkle, time (s)
  "milky", // intensity, 1 if textured, -, -
  "starRot0", // star-space rotation, columns
  "starRot1",
  "starRot2",
  "fogCol", // rgb horizon/fog colour, w horizon blend 0–1
  "fogShape", // sin(horizon height), whole-sky fog 0–1, -, -
  "nightCol", // rgb night-sky glow
  "quality", // atmosphere view steps (≤ 12), light steps (≤ 6), cloud octaves (≤ 5), - (`SKY_QUALITY`)
  "skyOut", // multiplier (exposure × skybox intensity), -, -, -
] as const;

export type SkyUniform = (typeof SKY_UNIFORMS)[number];

/** The textures the sky samples (always bound; a 1×1 placeholder when unused). */
export const SKY_SAMPLERS = ["moonTex", "milkyTex"] as const;

// --- the sky (KSL) -----------------------------------------------------------------------------------

/** The sky's uniforms, textures and `skyColor(dir)`. */
const SKY = shaderSource(/* KSL */ `
${SKY_UNIFORMS.map((u) => `UNIFORM(KV4, ${u});`).join("\n")}
TEXTURE2D(moonTex);
TEXTURE2D(milkyTex);

CONST(KF, PI) = 3.14159265;
CONST(KF, RE) = 6371e3;
CONST(KF, RA) = 6471e3;
CONST(KV3, K_RLH) = KV3(5.5e-6, 13.0e-6, 22.4e-6);
CONST(KF, K_MIE) = 21e-6;
CONST(KF, SH_RLH) = 8e3;
CONST(KF, SH_MIE) = 1.2e3;

FN(KV2, rsi, KV3 ro, KV3 rd, KF r) {
  VAR(KF, b) = dot(ro, rd);
  VAR(KF, c) = dot(ro, ro) - r * r;
  VAR(KF, d) = b * b - c;
  if (d < 0.0) { return KV2(1e5, -1e5); }
  VAR(KF, s) = sqrt(d);
  return KV2(-b - s, -b + s);
}

// Single scattering of sunlight along r (after wwwtyro's glsl-atmosphere, with fewer, quadratically spaced steps).
FN(KV3, atmosphere, KV3 r, KV3 sun) {
  VAR(KV3, ro) = KV3(0.0, RE + UNI(atmos).w, 0.0);
  VAR(KV2, p) = rsi(ro, r, RA);
  if (p.x > p.y) { return KV3(0.0); }
  VAR(KV2, ground) = rsi(ro, r, RE);
  if (ground.x <= ground.y && ground.x > 0.0) { p.y = min(p.y, ground.x); }
  // Steps grow quadratically: the dense air (and haze) near the viewer gets most of the samples.
  VAR(KF, t0) = max(p.x, 0.0);
  VAR(KF, len) = p.y - t0;
  VAR(KV3, totalRlh) = KV3(0.0);
  VAR(KV3, totalMie) = KV3(0.0);
  VAR(KF, odR) = 0.0;
  VAR(KF, odM) = 0.0;
  VAR(KF, mu) = dot(r, sun);
  VAR(KF, g) = UNI(atmos).z;
  VAR(KF, pRlh) = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  VAR(KF, pMie) = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (mu * mu + 1.0)) / (pow(max(1.0 + g * g - 2.0 * mu * g, 1e-4), 1.5) * (2.0 + g * g));
  VAR(KV3, kR) = K_RLH * UNI(atmos).x;
  VAR(KF, kM) = K_MIE * UNI(atmos).y;
  VAR(KF, n) = UNI(quality).x;
  for (VAR(KI, i) = 0; i < 12; i++) {
    if (KF(i) >= n) { break; }
    VAR(KF, fa) = KF(i) / n;
    VAR(KF, fb) = KF(i + 1) / n;
    VAR(KF, iStart) = t0 + len * fa * fa;
    VAR(KF, iStep) = len * (fb * fb - fa * fa);
    VAR(KV3, iPos) = ro + r * (iStart + iStep * 0.5);
    VAR(KF, iHeight) = length(iPos) - RE;
    VAR(KF, odStepR) = exp(-iHeight / SH_RLH) * iStep;
    VAR(KF, odStepM) = exp(-iHeight / SH_MIE) * iStep;
    // Sunlight that passes through the planet doesn't reach this sample.
    VAR(KV2, shade) = rsi(iPos, sun, RE);
    VAR(KF, lit) = select(1.0, 0.0, shade.x <= shade.y && shade.x > 0.0);
    VAR(KF, jStep) = rsi(iPos, sun, RA).y / UNI(quality).y;
    VAR(KF, jTime) = 0.0;
    VAR(KF, jodR) = 0.0;
    VAR(KF, jodM) = 0.0;
    for (VAR(KI, j) = 0; j < 6; j++) {
      if (KF(j) >= UNI(quality).y) { break; }
      VAR(KV3, jPos) = iPos + sun * (jTime + jStep * 0.5);
      VAR(KF, jHeight) = length(jPos) - RE;
      jodR += exp(-jHeight / SH_RLH) * jStep;
      jodM += exp(-jHeight / SH_MIE) * jStep;
      jTime += jStep;
    }
    VAR(KV3, attn) = lit * exp(-(kM * 1.1 * (odM + 0.5 * odStepM + jodM) + kR * (odR + 0.5 * odStepR + jodR)));
    totalRlh += odStepR * attn;
    totalMie += odStepM * attn;
    odR += odStepR;
    odM += odStepM;
  }
  return UNI(sunTint).w * (pRlh * kR * totalRlh + pMie * kM * totalMie);
}

FN(KF, hash12, KV2 p) {
  VAR(KV3, p3) = fract(p.xyx * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

FN(KV4, hash43, KV3 p) {
  VAR(KV4, p4) = fract(p.xyzx * KV4(0.1031, 0.1030, 0.0973, 0.1099));
  p4 += dot(p4, p4.wzxy + 33.33);
  return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}

FN(KF, noise2, KV2 p) {
  VAR(KV2, i) = floor(p);
  VAR(KV2, f) = fract(p);
  VAR(KV2, u) = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + KV2(1.0, 0.0)), u.x), mix(hash12(i + KV2(0.0, 1.0)), hash12(i + KV2(1.0, 1.0)), u.x), u.y);
}

FN(KF, fbm, KV2 p0) {
  VAR(KV2, p) = p0;
  VAR(KF, v) = 0.0;
  VAR(KF, a) = 0.5;
  for (VAR(KI, i) = 0; i < 5; i++) {
    if (KF(i) >= UNI(quality).z) { break; }
    v += a * noise2(p);
    p = p * 2.03 + KV2(17.1, 9.2);
    a *= 0.5;
  }
  return v;
}

// One cloud layer over the base colour.
FN(KV3, cloudLayer, KV3 base, KV3 dir, KV3 sun, KV4 shape, KV4 drift, KV3 tint) {
  if (drift.z < 0.5 || dir.y <= 0.0) { return base; }
  // z mirrored: the pattern from when north was -Z
  VAR(KV2, uv) = KV2(dir.x, -dir.z) / (dir.y + shape.w) * shape.z + drift.xy;
  VAR(KF, n) = fbm(uv);
  VAR(KF, edge) = 1.0 - shape.x;
  VAR(KF, d) = smoothstep(edge, edge + 0.35 * (1.0 - 0.7 * shape.y) + 0.02, n);
  VAR(KF, alpha) = d * (0.35 + 0.65 * shape.y) * smoothstep(0.0, 0.12, dir.y);
  VAR(KF, thick) = smoothstep(edge, 1.0, n);
  VAR(KF, forward) = pow(max(dot(dir, sun), 0.0), 6.0);
  VAR(KV3, lit) = tint * (UNI(cloudAmb).rgb + UNI(cloudLit).rgb * (1.0 - 0.6 * thick * shape.y) * (0.6 + 0.4 * sun.y)) + UNI(cloudLit).rgb * forward * (1.0 - thick) * 0.6;
  return mix(base, lit, clamp(alpha, 0.0, 1.0));
}

FN(KV3, skyColor, KV3 dir) {
  VAR(KV3, sun) = UNI(sunDir).xyz;
  VAR(KB, baking) = UNI(moonDir).w > 0.5;
  VAR(KV3, col) = KV3(0.0);
  VAR(KF, up) = dir.y;
  if (UNI(sunDir).w < 0.5) {
    VAR(KV3, h) = normalize(KV3(dir.x, max(up, 0.002), dir.z));
    col = atmosphere(h, sun);
    if (up < 0.0) { col = mix(col, UNI(groundCol).rgb, smoothstep(0.0, -0.03, up)); }
  } else {
    VAR(KF, t) = pow(clamp(abs(up), 0.0, 1.0), 1.0 / max(UNI(zenithCol).w, 0.1));
    col = select(mix(UNI(horizonCol).rgb, UNI(groundGrad).rgb, t), mix(UNI(horizonCol).rgb, UNI(zenithCol).rgb, t), up >= 0.0);
  }
  col += UNI(nightCol).rgb * smoothstep(-0.05, 0.3, up + 0.05);

  VAR(KF, mu) = dot(dir, sun);
  // Glow around the sun (kept in the bake), then the discs and stars (not baked: lights and noise).
  col += UNI(sunTint).rgb * UNI(sunDisc).z * UNI(sunDisc).y * (0.02 * pow(max(mu, 0.0), 8.0) + 0.25 * pow(max(mu, 0.0), 120.0)) * step(0.0, up + 0.02);
  VAR(KV3, moon) = UNI(moonDir).xyz;
  VAR(KF, mm) = dot(dir, moon);
  col += UNI(moonTint).rgb * UNI(moonDisc).z * UNI(moonDisc).y * 0.05 * pow(max(mm, 0.0), 60.0) * step(0.0, up);
  if (!baking && up > -0.02) {
    VAR(KF, lum) = dot(col, KV3(0.2126, 0.7152, 0.0722));
    VAR(KF, vis) = clamp(1.0 - lum * 8.0, 0.0, 1.0) * smoothstep(-0.02, 0.15, up);
    if (vis > 0.0 && UNI(stars).y > 0.0) {
      VAR(KV3, s) = KM3(UNI(starRot0).xyz, UNI(starRot1).xyz, UNI(starRot2).xyz) * dir;
      VAR(KV3, p) = s * 160.0;
      VAR(KV3, cell) = floor(p);
      VAR(KV4, hs) = hash43(cell);
      if (hs.x > UNI(stars).x) {
        VAR(KV3, c) = cell + 0.15 + 0.7 * hs.yzw;
        VAR(KF, d) = length(p - c);
        VAR(KF, tw) = 1.0 - UNI(stars).z * 0.5 * (1.0 + sin(UNI(stars).w * (2.0 + 6.0 * hs.y) + hs.z * 60.0));
        VAR(KF, b) = hs.w * hs.w;
        col += KV3(0.8 + 0.2 * hs.y, 0.85, 0.8 + 0.2 * hs.z) * smoothstep(0.12, 0.0, d) * UNI(stars).y * (0.3 + 2.0 * b) * tw * vis;
      }
      if (UNI(milky).y > 0.5) {
        VAR(KV2, uv) = KV2(atan2(s.x, -s.z) / (2.0 * PI) + 0.5, acos(clamp(s.y, -1.0, 1.0)) / PI);
        col += pow(KTEX(milkyTex, uv).rgb, KV3(2.2)) * UNI(milky).x * vis;
      }
    }
    if (UNI(sunDisc).z > 0.0 && mu > UNI(sunDisc).x) {
      VAR(KF, r) = sqrt(clamp((1.0 - mu) / max(1.0 - UNI(sunDisc).x, 1e-6), 0.0, 1.0));
      VAR(KF, limb) = 1.0 - 0.6 * (1.0 - sqrt(max(1.0 - r * r, 0.0)));
      col += UNI(sunTint).rgb * UNI(sunDisc).z * 40.0 * limb * smoothstep(1.0, 0.85, r);
    }
    if (UNI(moonDisc).z > 0.0 && mm > UNI(moonDisc).x) {
      // Left-handed axes (ADR 0164): the texture keeps its picture.
      VAR(KV3, tx) = normalize(cross(moon, select(KV3(1.0, 0.0, 0.0), KV3(0.0, 1.0, 0.0), abs(moon.y) < 0.99)));
      VAR(KV3, ty) = cross(tx, moon);
      VAR(KF, rad) = sqrt(max(1.0 - UNI(moonDisc).x * UNI(moonDisc).x, 1e-8));
      VAR(KV2, q) = KV2(dot(dir, tx), dot(dir, ty)) / rad;
      VAR(KF, rr) = dot(q, q);
      if (rr < 1.0) {
        VAR(KV3, n) = q.x * tx + q.y * ty + sqrt(1.0 - rr) * moon;
        VAR(KF, lit) = max(dot(n, sun), 0.0) + UNI(moonTint).w;
        VAR(KV3, albedo) = KV3(1.0);
        if (UNI(moonDisc).w > 0.5) { albedo = pow(KTEX(moonTex, q * KV2(0.5, -0.5) + 0.5).rgb, KV3(2.2)); }
        VAR(KF, a) = smoothstep(1.0, 0.92, rr);
        col = mix(col, col * 0.2 + UNI(moonTint).rgb * albedo * lit * UNI(moonDisc).z * 2.0, a);
      }
    }
  }
  col = cloudLayer(col, dir, sun, UNI(cloudA), UNI(cloudADrift), UNI(cloudACol).rgb);
  col = cloudLayer(col, dir, sun, UNI(cloudB), UNI(cloudBDrift), UNI(cloudBCol).rgb);
  // Horizon blend towards the fog colour, then the World's fog over the whole sky (ADR 0071).
  col *= UNI(skyOut).x;
  VAR(KF, hb) = UNI(fogCol).w * (1.0 - smoothstep(0.0, max(UNI(fogShape).x, 1e-3), max(up, 0.0)));
  col = mix(col, UNI(fogCol).rgb, clamp(hb, 0.0, 1.0));
  col = mix(col, UNI(fogCol).rgb, UNI(fogShape).y);
  return max(col, KV3(0.0));
}
`);

// --- GLSL --------------------------------------------------------------------------------------------

const GLSL_VERTEX = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec3 vDir;
void main(void) {
  vDir = position;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;

const GLSL_FRAGMENT = /* glsl */ `
precision highp float;
varying vec3 vDir;
${SKY.text("glsl")}
void main(void) {
  gl_FragColor = vec4(skyColor(normalize(vDir)), 1.0);
}
`;

const GLSL_BAKE_VERTEX = /* glsl */ `
attribute vec2 position;
uniform vec3 up;
uniform vec3 right;
uniform vec3 front;
varying vec3 vDir;
void main(void) {
  vDir = mat3(up, right, front) * vec3(position, 1.0);
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const GLSL_BAKE_FRAGMENT = /* glsl */ `
precision highp float;
varying vec3 vDir;
${SKY.text("glsl")}
void main(void) {
  vec3 d = normalize(vDir);
  gl_FragColor = vec4(skyColor(d), 1.0);
}
`;

// --- WGSL --------------------------------------------------------------------------------------------

const WGSL_VERTEX = /* wgsl */ `
attribute position: vec3f;
uniform worldViewProjection: mat4x4f;
varying vDir: vec3f;
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  vertexOutputs.vDir = vertexInputs.position;
  vertexOutputs.position = uniforms.worldViewProjection * vec4f(vertexInputs.position, 1.0);
}
`;

const WGSL_FRAGMENT = /* wgsl */ `
varying vDir: vec3f;
${SKY.text("wgsl")}
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  fragmentOutputs.color = vec4f(skyColor(normalize(fragmentInputs.vDir)), 1.0);
}
`;

const WGSL_BAKE_VERTEX = /* wgsl */ `
attribute position: vec2f;
uniform up: vec3f;
uniform right: vec3f;
uniform front: vec3f;
varying vDir: vec3f;
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  vertexOutputs.vDir = mat3x3f(uniforms.up, uniforms.right, uniforms.front) * vec3f(vertexInputs.position, 1.0);
  vertexOutputs.position = vec4f(vertexInputs.position, 0.0, 1.0);
}
`;

const WGSL_BAKE_FRAGMENT = /* wgsl */ `
varying vDir: vec3f;
${SKY.text("wgsl")}
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let d = normalize(fragmentInputs.vDir);
  fragmentOutputs.color = vec4f(skyColor(d), 1.0);
}
`;

ShaderStore.ShadersStore[`${SKY_SHADER}VertexShader`] = GLSL_VERTEX;
ShaderStore.ShadersStore[`${SKY_SHADER}FragmentShader`] = GLSL_FRAGMENT;
ShaderStore.ShadersStore[`${SKY_BAKE_SHADER}VertexShader`] = GLSL_BAKE_VERTEX;
ShaderStore.ShadersStore[`${SKY_BAKE_SHADER}FragmentShader`] = GLSL_BAKE_FRAGMENT;
ShaderStore.ShadersStoreWGSL[`${SKY_SHADER}VertexShader`] = WGSL_VERTEX;
ShaderStore.ShadersStoreWGSL[`${SKY_SHADER}FragmentShader`] = WGSL_FRAGMENT;
ShaderStore.ShadersStoreWGSL[`${SKY_BAKE_SHADER}VertexShader`] = WGSL_BAKE_VERTEX;
ShaderStore.ShadersStoreWGSL[`${SKY_BAKE_SHADER}FragmentShader`] = WGSL_BAKE_FRAGMENT;
