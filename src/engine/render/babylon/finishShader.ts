/**
 * The last pass of every camera on the Babylon backend (ADR 0051, 0075): colour grading
 * (brightness, contrast, saturation, hue), the vignette, tone mapping with exposure, and the sRGB
 * encode. Babylon's image processing has no AgX (the PostProcessing default), so the pass is ours,
 * with three.js's AgX, ACES Filmic and Khronos PBR Neutral curves, so a scene looks the same on
 * either backend. Written in WGSL for WebGPU and GLSL for the WebGL2 fallback.
 */
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore.js";

/** The post-process name `FrameGraphCustomPostProcessTask` looks up ("<name>PixelShader"). */
export const FINISH_SHADER = "mycoFinish";

/** The finish pass's uniforms (vec4s; see the shaders for their components). */
export const FINISH_UNIFORMS: readonly string[] = Object.freeze(["grade", "tone", "vignetteShape", "lut", "backdrop"]);

/** The finish pass's extra textures: the colour lookup table strip (ADR 0111, `lutTextures.ts`). */
export const FINISH_SAMPLERS: readonly string[] = Object.freeze(["lutSampler"]);

/** `toneMapping` uniform values. */
export const TONE_MAPPING_CODE = { none: 0, aces: 1, agx: 2, neutral: 3 } as const;

const WGSL = /* wgsl */ `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
// Three vec4s keep the parameters few and aligned.
uniform grade: vec4f; // brightness, contrast, saturation, hue (radians)
uniform tone: vec4f; // exposure, tone mapping (TONE_MAPPING_CODE, -1 linear out), vignette on (0/1), -
uniform vignetteShape: vec4f; // darkness, offset, -, -
uniform lut: vec4f; // intensity (0: none), table size, -, -
uniform backdrop: vec4f; // editor background (sRGB) behind the scene, on (a = 1) or off (ADR 0111)
var lutSamplerSampler: sampler;
var lutSampler: texture_2d<f32>;

// A colour lookup table laid out as a strip of slices (render/lut.ts), blending two slices for blue.
fn applyLut(c0: vec3f) -> vec3f {
  let n = uniforms.lut.y;
  let c = clamp(c0, vec3f(0.0), vec3f(1.0));
  let b = c.b * (n - 1.0);
  let b0 = floor(b);
  let b1 = min(b0 + 1.0, n - 1.0);
  let x = c.r * (n - 1.0) + 0.5;
  let y = (c.g * (n - 1.0) + 0.5) / n;
  let s0 = textureSampleLevel(lutSampler, lutSamplerSampler, vec2f((x + b0 * n) / (n * n), y), 0.0).rgb;
  let s1 = textureSampleLevel(lutSampler, lutSamplerSampler, vec2f((x + b1 * n) / (n * n), y), 0.0).rgb;
  return mix(s0, s1, b - b0);
}

fn aces(c0: vec3f) -> vec3f {
  let input = mat3x3f(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  let output = mat3x3f(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  var c = input * (c0 / 0.6);
  let a = c * (c + 0.0245786) - 0.000090537;
  let b = c * (0.983729 * c + 0.4329510) + 0.238081;
  c = output * (a / b);
  return clamp(c, vec3f(0.0), vec3f(1.0));
}

fn agxContrast(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

fn agx(c0: vec3f) -> vec3f {
  let toRec2020 = mat3x3f(0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.0880, 0.0433, 0.0113, 0.8956);
  let fromRec2020 = mat3x3f(1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187);
  let inset = mat3x3f(0.856627153315983, 0.137318972929847, 0.11189821299995, 0.0951212405381588, 0.761241990602591, 0.0767994186031903, 0.0482516061458583, 0.101439036467562, 0.811302368396859);
  let outset = mat3x3f(1.1271005818144368, -0.1413297634984383, -0.14132976349843826, -0.11060664309660323, 1.157823702216272, -0.11060664309660294, -0.016493938717834573, -0.016493938717834257, 1.2519364065950405);
  var c = inset * (toRec2020 * c0);
  c = log2(max(c, vec3f(1e-10)));
  c = clamp((c + 12.47393) / (4.026069 + 12.47393), vec3f(0.0), vec3f(1.0));
  c = outset * agxContrast(c);
  c = pow(max(vec3f(0.0), c), vec3f(2.2));
  return clamp(fromRec2020 * c, vec3f(0.0), vec3f(1.0));
}

fn neutral(c0: vec3f) -> vec3f {
  var c = c0;
  let x = min(c.r, min(c.g, c.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  c = c - offset;
  let peak = max(c.r, max(c.g, c.b));
  let start = 0.76;
  if (peak < start) { return c; }
  let d = 1.0 - start;
  let newPeak = 1.0 - d * d / (peak + d - start);
  c = c * (newPeak / peak);
  let g = 1.0 - 1.0 / (0.15 * (peak - newPeak) + 1.0);
  return mix(c, vec3f(newPeak), g);
}

fn srgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

#define CUSTOM_FRAGMENT_DEFINITIONS
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let source = textureSample(textureSampler, textureSamplerSampler, input.vUV);
  var c = source.rgb + uniforms.grade.x;
  if (uniforms.grade.y > 0.0) { c = (c - 0.5) / (1.0 - uniforms.grade.y) + 0.5; }
  else { c = (c - 0.5) * (1.0 + uniforms.grade.y) + 0.5; }
  let k = vec3f(0.57735);
  let ca = cos(uniforms.grade.w);
  c = c * ca + cross(k, c) * sin(uniforms.grade.w) + k * dot(k, c) * (1.0 - ca);
  let luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3f(luma), c, 1.0 + uniforms.grade.z), vec3f(0.0));
  if (uniforms.tone.z > 0.5) {
    // The postprocessing library's default vignette, as three.js draws it (ADR 0051).
    let d = distance(input.vUV, vec2f(0.5));
    c = c * smoothstep(0.8, uniforms.vignetteShape.y * 0.799, d * (uniforms.vignetteShape.x + uniforms.vignetteShape.y));
  }
  c = c * uniforms.tone.x;
  // -1: an HDR render texture (ADR 0109) keeps linear, unclamped colour.
  if (uniforms.tone.y < -0.5) {
    fragmentOutputs.color = vec4f(c, source.a);
    return fragmentOutputs;
  }
  let mode = i32(uniforms.tone.y + 0.5);
  if (mode == 1) { c = aces(c); }
  else if (mode == 2) { c = agx(c); }
  else if (mode == 3) { c = clamp(neutral(c), vec3f(0.0), vec3f(1.0)); }
  else { c = clamp(c, vec3f(0.0), vec3f(1.0)); }
  var outc = srgb(c);
  // A .cube table grades the display-referred image, after tone mapping and encoding.
  if (uniforms.lut.x > 0.0) { outc = mix(outc, applyLut(outc), uniforms.lut.x); }
  if (uniforms.backdrop.a > 0.5) {
    // The editor's background, not tone mapped: behind what the camera drew (premultiplied by its alpha).
    fragmentOutputs.color = vec4f(outc + uniforms.backdrop.rgb * (1.0 - clamp(source.a, 0.0, 1.0)), 1.0);
    return fragmentOutputs;
  }
  fragmentOutputs.color = vec4f(outc, source.a);
}
`;

const GLSL = /* glsl */ `
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform vec4 grade; // brightness, contrast, saturation, hue (radians)
uniform vec4 tone; // exposure, tone mapping (TONE_MAPPING_CODE), vignette on (0/1), -
uniform vec4 vignetteShape; // darkness, offset, -, -
uniform vec4 lut; // intensity (0: none), table size, -, -
uniform vec4 backdrop; // editor background (sRGB) behind the scene, on (a = 1) or off
uniform sampler2D lutSampler;

vec3 applyLut(vec3 c) {
  float n = lut.y;
  c = clamp(c, 0.0, 1.0);
  float b = c.b * (n - 1.0);
  float b0 = floor(b);
  float b1 = min(b0 + 1.0, n - 1.0);
  float x = c.r * (n - 1.0) + 0.5;
  float y = (c.g * (n - 1.0) + 0.5) / n;
  vec3 s0 = texture2D(lutSampler, vec2((x + b0 * n) / (n * n), y)).rgb;
  vec3 s1 = texture2D(lutSampler, vec2((x + b1 * n) / (n * n), y)).rgb;
  return mix(s0, s1, b - b0);
}

vec3 aces(vec3 c) {
  const mat3 inputM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 outputM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  c = inputM * (c / 0.6);
  vec3 a = c * (c + 0.0245786) - 0.000090537;
  vec3 b = c * (0.983729 * c + 0.4329510) + 0.238081;
  return clamp(outputM * (a / b), 0.0, 1.0);
}

vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 agx(vec3 c) {
  const mat3 toRec2020 = mat3(0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.0880, 0.0433, 0.0113, 0.8956);
  const mat3 fromRec2020 = mat3(1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187);
  const mat3 inset = mat3(0.856627153315983, 0.137318972929847, 0.11189821299995, 0.0951212405381588, 0.761241990602591, 0.0767994186031903, 0.0482516061458583, 0.101439036467562, 0.811302368396859);
  const mat3 outset = mat3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826, -0.11060664309660323, 1.157823702216272, -0.11060664309660294, -0.016493938717834573, -0.016493938717834257, 1.2519364065950405);
  c = inset * (toRec2020 * c);
  c = log2(max(c, vec3(1e-10)));
  c = clamp((c + 12.47393) / (4.026069 + 12.47393), 0.0, 1.0);
  c = outset * agxContrast(c);
  c = pow(max(vec3(0.0), c), vec3(2.2));
  return clamp(fromRec2020 * c, 0.0, 1.0);
}

vec3 neutral(vec3 c) {
  float x = min(c.r, min(c.g, c.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  c -= offset;
  float peak = max(c.r, max(c.g, c.b));
  const float start = 0.76;
  if (peak < start) return c;
  float d = 1.0 - start;
  float newPeak = 1.0 - d * d / (peak + d - start);
  c *= newPeak / peak;
  float g = 1.0 - 1.0 / (0.15 * (peak - newPeak) + 1.0);
  return mix(c, vec3(newPeak), g);
}

vec3 srgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.0031308))));
}

#define CUSTOM_FRAGMENT_DEFINITIONS
void main(void) {
  vec4 source = texture2D(textureSampler, vUV);
  float brightness = grade.x, contrast = grade.y, saturation = grade.z, hue = grade.w;
  vec3 c = source.rgb + brightness;
  if (contrast > 0.0) c = (c - 0.5) / (1.0 - contrast) + 0.5;
  else c = (c - 0.5) * (1.0 + contrast) + 0.5;
  const vec3 k = vec3(0.57735);
  float ca = cos(hue);
  c = c * ca + cross(k, c) * sin(hue) + k * dot(k, c) * (1.0 - ca);
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3(luma), c, 1.0 + saturation), 0.0);
  if (tone.z > 0.5) {
    float d = distance(vUV, vec2(0.5));
    c *= smoothstep(0.8, vignetteShape.y * 0.799, d * (vignetteShape.x + vignetteShape.y));
  }
  c *= tone.x;
  // -1: an HDR render texture (ADR 0109) keeps linear, unclamped colour.
  if (tone.y < -0.5) {
    gl_FragColor = vec4(c, source.a);
    return;
  }
  int mode = int(tone.y + 0.5);
  if (mode == 1) c = aces(c);
  else if (mode == 2) c = agx(c);
  else if (mode == 3) c = clamp(neutral(c), 0.0, 1.0);
  else c = clamp(c, 0.0, 1.0);
  vec3 outc = srgb(c);
  if (lut.x > 0.0) outc = mix(outc, applyLut(outc), lut.x);
  if (backdrop.a > 0.5) {
    gl_FragColor = vec4(outc + backdrop.rgb * (1.0 - clamp(source.a, 0.0, 1.0)), 1.0);
    return;
  }
  gl_FragColor = vec4(outc, source.a);
}
`;

ShaderStore.ShadersStoreWGSL[`${FINISH_SHADER}PixelShader`] = WGSL;
ShaderStore.ShadersStore[`${FINISH_SHADER}PixelShader`] = GLSL;
