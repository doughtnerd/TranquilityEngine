/**
 * The procedural sky's shaders (ADR 0112), in WGSL for WebGPU and GLSL for the WebGL2 fallback.
 * One sky function (`SKY_*_BODY`) serves two programs:
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
  "skyOut", // multiplier (exposure × skybox intensity), Z flip for baking (1/-1), -, -
] as const;

export type SkyUniform = (typeof SKY_UNIFORMS)[number];

/** The textures the sky samples (always bound; a 1×1 placeholder when unused). */
export const SKY_SAMPLERS = ["moonTex", "milkyTex"] as const;

// --- GLSL --------------------------------------------------------------------------------------------

const GLSL_UNIFORMS = SKY_UNIFORMS.map((u) => `uniform vec4 ${u};`).join("\n");

const GLSL_BODY = /* glsl */ `
${GLSL_UNIFORMS}
uniform sampler2D moonTex;
uniform sampler2D milkyTex;

const float PI = 3.14159265;
const float RE = 6371e3;
const float RA = 6471e3;
const vec3 K_RLH = vec3(5.5e-6, 13.0e-6, 22.4e-6);
const float K_MIE = 21e-6;
const float SH_RLH = 8e3;
const float SH_MIE = 1.2e3;

vec2 rsi(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  if (d < 0.0) return vec2(1e5, -1e5);
  float s = sqrt(d);
  return vec2(-b - s, -b + s);
}

// Single scattering of sunlight along r (after wwwtyro's glsl-atmosphere, with fewer, quadratically spaced steps).
vec3 atmosphere(vec3 r, vec3 sun) {
  vec3 ro = vec3(0.0, RE + atmos.w, 0.0);
  vec2 p = rsi(ro, r, RA);
  if (p.x > p.y) return vec3(0.0);
  vec2 ground = rsi(ro, r, RE);
  if (ground.x <= ground.y && ground.x > 0.0) p.y = min(p.y, ground.x);
  // Steps grow quadratically: the dense air (and haze) near the viewer gets most of the samples.
  float t0 = max(p.x, 0.0);
  float len = p.y - t0;
  vec3 totalRlh = vec3(0.0);
  vec3 totalMie = vec3(0.0);
  float odR = 0.0;
  float odM = 0.0;
  float mu = dot(r, sun);
  float g = atmos.z;
  float pRlh = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float pMie = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (mu * mu + 1.0)) / (pow(max(1.0 + g * g - 2.0 * mu * g, 1e-4), 1.5) * (2.0 + g * g));
  vec3 kR = K_RLH * atmos.x;
  float kM = K_MIE * atmos.y;
  for (int i = 0; i < 12; i++) {
    float fa = float(i) / 12.0;
    float fb = float(i + 1) / 12.0;
    float iStart = t0 + len * fa * fa;
    float iStep = len * (fb * fb - fa * fa);
    vec3 iPos = ro + r * (iStart + iStep * 0.5);
    float iHeight = length(iPos) - RE;
    float odStepR = exp(-iHeight / SH_RLH) * iStep;
    float odStepM = exp(-iHeight / SH_MIE) * iStep;
    // Sunlight that passes through the planet doesn't reach this sample.
    vec2 shade = rsi(iPos, sun, RE);
    float lit = shade.x <= shade.y && shade.x > 0.0 ? 0.0 : 1.0;
    float jStep = rsi(iPos, sun, RA).y / 6.0;
    float jTime = 0.0;
    float jodR = 0.0;
    float jodM = 0.0;
    for (int j = 0; j < 6; j++) {
      vec3 jPos = iPos + sun * (jTime + jStep * 0.5);
      float jHeight = length(jPos) - RE;
      jodR += exp(-jHeight / SH_RLH) * jStep;
      jodM += exp(-jHeight / SH_MIE) * jStep;
      jTime += jStep;
    }
    vec3 attn = lit * exp(-(kM * 1.1 * (odM + 0.5 * odStepM + jodM) + kR * (odR + 0.5 * odStepR + jodR)));
    totalRlh += odStepR * attn;
    totalMie += odStepM * attn;
    odR += odStepR;
    odM += odStepM;
  }
  return sunTint.w * (pRlh * kR * totalRlh + pMie * kM * totalMie);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec4 hash43(vec3 p) {
  vec4 p4 = fract(vec4(p.xyzx) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p4 += dot(p4, p4.wzxy + 33.33);
  return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise2(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return v;
}

// One cloud layer over the base colour.
vec3 cloudLayer(vec3 base, vec3 dir, vec3 sun, vec4 shape, vec4 drift, vec3 tint) {
  if (drift.z < 0.5 || dir.y <= 0.0) return base;
  vec2 uv = dir.xz / (dir.y + shape.w) * shape.z + drift.xy;
  float n = fbm(uv);
  float edge = 1.0 - shape.x;
  float d = smoothstep(edge, edge + 0.35 * (1.0 - 0.7 * shape.y) + 0.02, n);
  float alpha = d * (0.35 + 0.65 * shape.y) * smoothstep(0.0, 0.12, dir.y);
  float thick = smoothstep(edge, 1.0, n);
  float forward = pow(max(dot(dir, sun), 0.0), 6.0);
  vec3 lit = tint * (cloudAmb.rgb + cloudLit.rgb * (1.0 - 0.6 * thick * shape.y) * (0.6 + 0.4 * sun.y)) + cloudLit.rgb * forward * (1.0 - thick) * 0.6;
  return mix(base, lit, clamp(alpha, 0.0, 1.0));
}

vec3 skyColor(vec3 dir) {
  vec3 sun = sunDir.xyz;
  bool baking = moonDir.w > 0.5;
  vec3 col;
  float up = dir.y;
  if (sunDir.w < 0.5) {
    vec3 h = normalize(vec3(dir.x, max(up, 0.002), dir.z));
    col = atmosphere(h, sun);
    if (up < 0.0) col = mix(col, groundCol.rgb, smoothstep(0.0, -0.03, up));
  } else {
    float t = pow(clamp(abs(up), 0.0, 1.0), 1.0 / max(zenithCol.w, 0.1));
    col = up >= 0.0 ? mix(horizonCol.rgb, zenithCol.rgb, t) : mix(horizonCol.rgb, groundGrad.rgb, t);
  }
  col += nightCol.rgb * smoothstep(-0.05, 0.3, up + 0.05);

  float mu = dot(dir, sun);
  // Glow around the sun (kept in the bake), then the discs and stars (not baked: lights and noise).
  col += sunTint.rgb * sunDisc.z * sunDisc.y * (0.02 * pow(max(mu, 0.0), 8.0) + 0.25 * pow(max(mu, 0.0), 120.0)) * step(0.0, up + 0.02);
  vec3 moon = moonDir.xyz;
  float mm = dot(dir, moon);
  col += moonTint.rgb * moonDisc.z * moonDisc.y * 0.05 * pow(max(mm, 0.0), 60.0) * step(0.0, up);
  if (!baking && up > -0.02) {
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float vis = clamp(1.0 - lum * 8.0, 0.0, 1.0) * smoothstep(-0.02, 0.15, up);
    if (vis > 0.0 && stars.y > 0.0) {
      vec3 s = mat3(starRot0.xyz, starRot1.xyz, starRot2.xyz) * dir;
      vec3 p = s * 160.0;
      vec3 cell = floor(p);
      vec4 hs = hash43(cell);
      if (hs.x > stars.x) {
        vec3 c = cell + 0.15 + 0.7 * hs.yzw;
        float d = length(p - c);
        float tw = 1.0 - stars.z * 0.5 * (1.0 + sin(stars.w * (2.0 + 6.0 * hs.y) + hs.z * 60.0));
        float b = hs.w * hs.w;
        col += vec3(0.8 + 0.2 * hs.y, 0.85, 0.8 + 0.2 * hs.z) * smoothstep(0.12, 0.0, d) * stars.y * (0.3 + 2.0 * b) * tw * vis;
      }
      if (milky.y > 0.5) {
        vec2 uv = vec2(atan(s.x, -s.z) / (2.0 * PI) + 0.5, acos(clamp(s.y, -1.0, 1.0)) / PI);
        col += pow(texture2D(milkyTex, uv).rgb, vec3(2.2)) * milky.x * vis;
      }
    }
    if (sunDisc.z > 0.0 && mu > sunDisc.x) {
      float r = sqrt(clamp((1.0 - mu) / max(1.0 - sunDisc.x, 1e-6), 0.0, 1.0));
      float limb = 1.0 - 0.6 * (1.0 - sqrt(max(1.0 - r * r, 0.0)));
      col += sunTint.rgb * sunDisc.z * 40.0 * limb * smoothstep(1.0, 0.85, r);
    }
    if (moonDisc.z > 0.0 && mm > moonDisc.x) {
      vec3 tx = normalize(cross(abs(moon.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), moon));
      vec3 ty = cross(moon, tx);
      float rad = sqrt(max(1.0 - moonDisc.x * moonDisc.x, 1e-8));
      vec2 q = vec2(dot(dir, tx), dot(dir, ty)) / rad;
      float rr = dot(q, q);
      if (rr < 1.0) {
        vec3 n = q.x * tx + q.y * ty + sqrt(1.0 - rr) * moon;
        float lit = max(dot(n, sun), 0.0) + moonTint.w;
        vec3 albedo = moonDisc.w > 0.5 ? pow(texture2D(moonTex, q * vec2(0.5, -0.5) + 0.5).rgb, vec3(2.2)) : vec3(1.0);
        float a = smoothstep(1.0, 0.92, rr);
        col = mix(col, col * 0.2 + moonTint.rgb * albedo * lit * moonDisc.z * 2.0, a);
      }
    }
  }
  col = cloudLayer(col, dir, sun, cloudA, cloudADrift, cloudACol.rgb);
  col = cloudLayer(col, dir, sun, cloudB, cloudBDrift, cloudBCol.rgb);
  // Horizon blend towards the fog colour, then the World's fog over the whole sky (ADR 0071).
  col *= skyOut.x;
  float hb = fogCol.w * (1.0 - smoothstep(0.0, max(fogShape.x, 1e-3), max(up, 0.0)));
  col = mix(col, fogCol.rgb, clamp(hb, 0.0, 1.0));
  col = mix(col, fogCol.rgb, fogShape.y);
  return max(col, vec3(0.0));
}
`;

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
${GLSL_BODY}
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
${GLSL_BODY}
void main(void) {
  vec3 d = normalize(vDir);
  gl_FragColor = vec4(skyColor(vec3(d.x, d.y, d.z * skyOut.y)), 1.0);
}
`;

// --- WGSL --------------------------------------------------------------------------------------------

const WGSL_UNIFORMS = SKY_UNIFORMS.map((u) => `uniform ${u}: vec4f;`).join("\n");

/** `GLSL_BODY` in WGSL; uniforms are `uniforms.x`. Keep the two in step. */
const WGSL_BODY = /* wgsl */ `
${WGSL_UNIFORMS}
var moonTexSampler: sampler;
var moonTex: texture_2d<f32>;
var milkyTexSampler: sampler;
var milkyTex: texture_2d<f32>;

const PI = 3.14159265;
const RE = 6371e3;
const RA = 6471e3;
const K_RLH = vec3f(5.5e-6, 13.0e-6, 22.4e-6);
const K_MIE = 21e-6;
const SH_RLH = 8e3;
const SH_MIE = 1.2e3;

fn rsi(ro: vec3f, rd: vec3f, r: f32) -> vec2f {
  let b = dot(ro, rd);
  let c = dot(ro, ro) - r * r;
  let d = b * b - c;
  if (d < 0.0) { return vec2f(1e5, -1e5); }
  let s = sqrt(d);
  return vec2f(-b - s, -b + s);
}

fn atmosphere(r: vec3f, sun: vec3f) -> vec3f {
  let ro = vec3f(0.0, RE + uniforms.atmos.w, 0.0);
  var p = rsi(ro, r, RA);
  if (p.x > p.y) { return vec3f(0.0); }
  let ground = rsi(ro, r, RE);
  if (ground.x <= ground.y && ground.x > 0.0) { p.y = min(p.y, ground.x); }
  let t0 = max(p.x, 0.0);
  let len = p.y - t0;
  var totalRlh = vec3f(0.0);
  var totalMie = vec3f(0.0);
  var odR = 0.0;
  var odM = 0.0;
  let mu = dot(r, sun);
  let g = uniforms.atmos.z;
  let pRlh = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  let pMie = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (mu * mu + 1.0)) / (pow(max(1.0 + g * g - 2.0 * mu * g, 1e-4), 1.5) * (2.0 + g * g));
  let kR = K_RLH * uniforms.atmos.x;
  let kM = K_MIE * uniforms.atmos.y;
  for (var i = 0; i < 12; i++) {
    let fa = f32(i) / 12.0;
    let fb = f32(i + 1) / 12.0;
    let iStart = t0 + len * fa * fa;
    let iStep = len * (fb * fb - fa * fa);
    let iPos = ro + r * (iStart + iStep * 0.5);
    let iHeight = length(iPos) - RE;
    let odStepR = exp(-iHeight / SH_RLH) * iStep;
    let odStepM = exp(-iHeight / SH_MIE) * iStep;
    let shade = rsi(iPos, sun, RE);
    let lit = select(1.0, 0.0, shade.x <= shade.y && shade.x > 0.0);
    let jStep = rsi(iPos, sun, RA).y / 6.0;
    var jTime = 0.0;
    var jodR = 0.0;
    var jodM = 0.0;
    for (var j = 0; j < 6; j++) {
      let jPos = iPos + sun * (jTime + jStep * 0.5);
      let jHeight = length(jPos) - RE;
      jodR += exp(-jHeight / SH_RLH) * jStep;
      jodM += exp(-jHeight / SH_MIE) * jStep;
      jTime += jStep;
    }
    let attn = lit * exp(-(kM * 1.1 * (odM + 0.5 * odStepM + jodM) + kR * (odR + 0.5 * odStepR + jodR)));
    totalRlh += odStepR * attn;
    totalMie += odStepM * attn;
    odR += odStepR;
    odM += odStepM;
  }
  return uniforms.sunTint.w * (pRlh * kR * totalRlh + pMie * kM * totalMie);
}

fn hash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn hash43(p: vec3f) -> vec4f {
  var p4 = fract(vec4f(p.x, p.y, p.z, p.x) * vec4f(0.1031, 0.1030, 0.0973, 0.1099));
  p4 += dot(p4, p4.wzxy + 33.33);
  return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}

fn noise2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2f(1.0, 0.0)), u.x), mix(hash12(i + vec2f(0.0, 1.0)), hash12(i + vec2f(1.0, 1.0)), u.x), u.y);
}

fn fbm(p0: vec2f) -> f32 {
  var p = p0;
  var v = 0.0;
  var a = 0.5;
  for (var i = 0; i < 5; i++) {
    v += a * noise2(p);
    p = p * 2.03 + vec2f(17.1, 9.2);
    a *= 0.5;
  }
  return v;
}

fn cloudLayer(base: vec3f, dir: vec3f, sun: vec3f, shape: vec4f, drift: vec4f, tint: vec3f) -> vec3f {
  if (drift.z < 0.5 || dir.y <= 0.0) { return base; }
  let uv = dir.xz / (dir.y + shape.w) * shape.z + drift.xy;
  let n = fbm(uv);
  let edge = 1.0 - shape.x;
  let d = smoothstep(edge, edge + 0.35 * (1.0 - 0.7 * shape.y) + 0.02, n);
  let alpha = d * (0.35 + 0.65 * shape.y) * smoothstep(0.0, 0.12, dir.y);
  let thick = smoothstep(edge, 1.0, n);
  let forward = pow(max(dot(dir, sun), 0.0), 6.0);
  let lit = tint * (uniforms.cloudAmb.rgb + uniforms.cloudLit.rgb * (1.0 - 0.6 * thick * shape.y) * (0.6 + 0.4 * sun.y)) + uniforms.cloudLit.rgb * forward * (1.0 - thick) * 0.6;
  return mix(base, lit, clamp(alpha, 0.0, 1.0));
}

fn skyColor(dir: vec3f) -> vec3f {
  let sun = uniforms.sunDir.xyz;
  let baking = uniforms.moonDir.w > 0.5;
  var col: vec3f;
  let up = dir.y;
  if (uniforms.sunDir.w < 0.5) {
    let h = normalize(vec3f(dir.x, max(up, 0.002), dir.z));
    col = atmosphere(h, sun);
    if (up < 0.0) { col = mix(col, uniforms.groundCol.rgb, smoothstep(0.0, -0.03, up)); }
  } else {
    let t = pow(clamp(abs(up), 0.0, 1.0), 1.0 / max(uniforms.zenithCol.w, 0.1));
    col = select(mix(uniforms.horizonCol.rgb, uniforms.groundGrad.rgb, t), mix(uniforms.horizonCol.rgb, uniforms.zenithCol.rgb, t), up >= 0.0);
  }
  col += uniforms.nightCol.rgb * smoothstep(-0.05, 0.3, up + 0.05);

  let mu = dot(dir, sun);
  col += uniforms.sunTint.rgb * uniforms.sunDisc.z * uniforms.sunDisc.y * (0.02 * pow(max(mu, 0.0), 8.0) + 0.25 * pow(max(mu, 0.0), 120.0)) * step(0.0, up + 0.02);
  let moon = uniforms.moonDir.xyz;
  let mm = dot(dir, moon);
  col += uniforms.moonTint.rgb * uniforms.moonDisc.z * uniforms.moonDisc.y * 0.05 * pow(max(mm, 0.0), 60.0) * step(0.0, up);
  if (!baking && up > -0.02) {
    let lum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
    let vis = clamp(1.0 - lum * 8.0, 0.0, 1.0) * smoothstep(-0.02, 0.15, up);
    if (vis > 0.0 && uniforms.stars.y > 0.0) {
      let s = mat3x3f(uniforms.starRot0.xyz, uniforms.starRot1.xyz, uniforms.starRot2.xyz) * dir;
      let p = s * 160.0;
      let cell = floor(p);
      let hs = hash43(cell);
      if (hs.x > uniforms.stars.x) {
        let c = cell + 0.15 + 0.7 * hs.yzw;
        let d = length(p - c);
        let tw = 1.0 - uniforms.stars.z * 0.5 * (1.0 + sin(uniforms.stars.w * (2.0 + 6.0 * hs.y) + hs.z * 60.0));
        let b = hs.w * hs.w;
        col += vec3f(0.8 + 0.2 * hs.y, 0.85, 0.8 + 0.2 * hs.z) * smoothstep(0.12, 0.0, d) * uniforms.stars.y * (0.3 + 2.0 * b) * tw * vis;
      }
      if (uniforms.milky.y > 0.5) {
        let uv = vec2f(atan2(s.x, -s.z) / (2.0 * PI) + 0.5, acos(clamp(s.y, -1.0, 1.0)) / PI);
        col += pow(textureSampleLevel(milkyTex, milkyTexSampler, uv, 0.0).rgb, vec3f(2.2)) * uniforms.milky.x * vis;
      }
    }
    if (uniforms.sunDisc.z > 0.0 && mu > uniforms.sunDisc.x) {
      let r = sqrt(clamp((1.0 - mu) / max(1.0 - uniforms.sunDisc.x, 1e-6), 0.0, 1.0));
      let limb = 1.0 - 0.6 * (1.0 - sqrt(max(1.0 - r * r, 0.0)));
      col += uniforms.sunTint.rgb * uniforms.sunDisc.z * 40.0 * limb * smoothstep(1.0, 0.85, r);
    }
    if (uniforms.moonDisc.z > 0.0 && mm > uniforms.moonDisc.x) {
      let tx = normalize(cross(select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(moon.y) < 0.99), moon));
      let ty = cross(moon, tx);
      let rad = sqrt(max(1.0 - uniforms.moonDisc.x * uniforms.moonDisc.x, 1e-8));
      let q = vec2f(dot(dir, tx), dot(dir, ty)) / rad;
      let rr = dot(q, q);
      if (rr < 1.0) {
        let n = q.x * tx + q.y * ty + sqrt(1.0 - rr) * moon;
        let lit = max(dot(n, sun), 0.0) + uniforms.moonTint.w;
        var albedo = vec3f(1.0);
        if (uniforms.moonDisc.w > 0.5) { albedo = pow(textureSampleLevel(moonTex, moonTexSampler, q * vec2f(0.5, -0.5) + 0.5, 0.0).rgb, vec3f(2.2)); }
        let a = smoothstep(1.0, 0.92, rr);
        col = mix(col, col * 0.2 + uniforms.moonTint.rgb * albedo * lit * uniforms.moonDisc.z * 2.0, a);
      }
    }
  }
  col = cloudLayer(col, dir, sun, uniforms.cloudA, uniforms.cloudADrift, uniforms.cloudACol.rgb);
  col = cloudLayer(col, dir, sun, uniforms.cloudB, uniforms.cloudBDrift, uniforms.cloudBCol.rgb);
  col *= uniforms.skyOut.x;
  let hb = uniforms.fogCol.w * (1.0 - smoothstep(0.0, max(uniforms.fogShape.x, 1e-3), max(up, 0.0)));
  col = mix(col, uniforms.fogCol.rgb, clamp(hb, 0.0, 1.0));
  col = mix(col, uniforms.fogCol.rgb, uniforms.fogShape.y);
  return max(col, vec3f(0.0));
}
`;

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
${WGSL_BODY}
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
${WGSL_BODY}
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let d = normalize(fragmentInputs.vDir);
  fragmentOutputs.color = vec4f(skyColor(vec3f(d.x, d.y, d.z * uniforms.skyOut.y)), 1.0);
}
`;

/** @internal Tests: every shader source by name. */
export const SKY_SOURCES = {
  glsl: { vertex: GLSL_VERTEX, fragment: GLSL_FRAGMENT, bakeVertex: GLSL_BAKE_VERTEX, bakeFragment: GLSL_BAKE_FRAGMENT },
  wgsl: { vertex: WGSL_VERTEX, fragment: WGSL_FRAGMENT, bakeVertex: WGSL_BAKE_VERTEX, bakeFragment: WGSL_BAKE_FRAGMENT },
} as const;

ShaderStore.ShadersStore[`${SKY_SHADER}VertexShader`] = GLSL_VERTEX;
ShaderStore.ShadersStore[`${SKY_SHADER}FragmentShader`] = GLSL_FRAGMENT;
ShaderStore.ShadersStore[`${SKY_BAKE_SHADER}VertexShader`] = GLSL_BAKE_VERTEX;
ShaderStore.ShadersStore[`${SKY_BAKE_SHADER}FragmentShader`] = GLSL_BAKE_FRAGMENT;
ShaderStore.ShadersStoreWGSL[`${SKY_SHADER}VertexShader`] = WGSL_VERTEX;
ShaderStore.ShadersStoreWGSL[`${SKY_SHADER}FragmentShader`] = WGSL_FRAGMENT;
ShaderStore.ShadersStoreWGSL[`${SKY_BAKE_SHADER}VertexShader`] = WGSL_BAKE_VERTEX;
ShaderStore.ShadersStoreWGSL[`${SKY_BAKE_SHADER}FragmentShader`] = WGSL_BAKE_FRAGMENT;
