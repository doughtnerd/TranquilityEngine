/**
 * The last pass of every camera on the Babylon backend (ADR 0051, 0075): colour grading
 * (brightness, contrast, saturation, hue), the vignette, tone mapping with exposure, and the sRGB
 * encode. Babylon's image processing has no AgX (the PostProcessing default), so the pass is ours,
 * with the AgX, ACES Filmic and Khronos PBR Neutral curves three.js uses (the look scenes were made
 * with before ADR 0081). The maths is written once in KSL (ADR 0250) and compiled to WGSL for WebGPU and
 * GLSL for the WebGL2 fallback; only the entry point is written per language.
 */
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore.js";
import { shaderSource } from "../shaderSource/shaderSource";

/** The post-process name `FrameGraphCustomPostProcessTask` looks up ("<name>PixelShader"). */
export const FINISH_SHADER = "mycoFinish";

/** The finish pass's uniforms (vec4s; see the shaders for their components). */
export const FINISH_UNIFORMS: readonly string[] = Object.freeze(["grade", "tone", "vignetteShape", "lut", "backdrop"]);

/** The finish pass's extra textures: the colour lookup table strip (ADR 0111, `lutTextures.ts`). */
export const FINISH_SAMPLERS: readonly string[] = Object.freeze(["lutSampler"]);

/** `toneMapping` uniform values. */
export const TONE_MAPPING_CODE = { none: 0, aces: 1, agx: 2, neutral: 3 } as const;

/** The pass's uniforms, textures and colour maths. */
const FINISH = shaderSource(/* KSL */ `
TEXTURE2D(textureSampler);
// Five vec4s keep the parameters few and aligned.
// grade: brightness, contrast, saturation, hue (radians)
UNIFORM(KV4, grade);
// tone: exposure, tone mapping (TONE_MAPPING_CODE, -1 linear out), vignette on (0/1), -
UNIFORM(KV4, tone);
// vignetteShape: darkness, offset, -, -
UNIFORM(KV4, vignetteShape);
// lut: intensity (0: none), table size, -, -
UNIFORM(KV4, lut);
// backdrop: editor background (sRGB) behind the scene, on (a = 1) or off (ADR 0111)
UNIFORM(KV4, backdrop);
TEXTURE2D(lutSampler);

// A colour lookup table laid out as a strip of slices (render/lut.ts), blending two slices for blue.
FN(KV3, applyLut, KV3 c0) {
  VAR(KF, n) = UNI(lut).y;
  VAR(KV3, c) = clamp(c0, KV3(0.0), KV3(1.0));
  VAR(KF, b) = c.z * (n - 1.0);
  VAR(KF, b0) = floor(b);
  VAR(KF, b1) = min(b0 + 1.0, n - 1.0);
  VAR(KF, x) = c.x * (n - 1.0) + 0.5;
  VAR(KF, y) = (c.y * (n - 1.0) + 0.5) / n;
  VAR(KV3, s0) = KTEX(lutSampler, KV2((x + b0 * n) / (n * n), y)).xyz;
  VAR(KV3, s1) = KTEX(lutSampler, KV2((x + b1 * n) / (n * n), y)).xyz;
  return mix(s0, s1, b - b0);
}

FN(KV3, aces, KV3 c0) {
  CONST(KM3, inputM) = KM3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  CONST(KM3, outputM) = KM3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  VAR(KV3, c) = inputM * (c0 / 0.6);
  VAR(KV3, a) = c * (c + 0.0245786) - 0.000090537;
  VAR(KV3, b) = c * (0.983729 * c + 0.4329510) + 0.238081;
  return clamp(outputM * (a / b), KV3(0.0), KV3(1.0));
}

FN(KV3, agxContrast, KV3 x) {
  VAR(KV3, x2) = x * x;
  VAR(KV3, x4) = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

FN(KV3, agx, KV3 c0) {
  CONST(KM3, toRec2020) = KM3(0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.0880, 0.0433, 0.0113, 0.8956);
  CONST(KM3, fromRec2020) = KM3(1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187);
  CONST(KM3, inset) = KM3(0.856627153315983, 0.137318972929847, 0.11189821299995, 0.0951212405381588, 0.761241990602591, 0.0767994186031903, 0.0482516061458583, 0.101439036467562, 0.811302368396859);
  CONST(KM3, outset) = KM3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826, -0.11060664309660323, 1.157823702216272, -0.11060664309660294, -0.016493938717834573, -0.016493938717834257, 1.2519364065950405);
  VAR(KV3, c) = inset * (toRec2020 * c0);
  c = log2(max(c, KV3(1e-10)));
  c = clamp((c + 12.47393) / (4.026069 + 12.47393), KV3(0.0), KV3(1.0));
  c = outset * agxContrast(c);
  c = pow(max(KV3(0.0), c), KV3(2.2));
  return clamp(fromRec2020 * c, KV3(0.0), KV3(1.0));
}

FN(KV3, neutral, KV3 c0) {
  VAR(KV3, c) = c0;
  VAR(KF, x) = min(c.x, min(c.y, c.z));
  VAR(KF, offset) = select(0.04, x - 6.25 * x * x, x < 0.08);
  c = c - offset;
  VAR(KF, peak) = max(c.x, max(c.y, c.z));
  CONST(KF, start) = 0.76;
  if (peak < start) { return c; }
  VAR(KF, d) = 1.0 - start;
  VAR(KF, newPeak) = 1.0 - d * d / (peak + d - start);
  c = c * (newPeak / peak);
  VAR(KF, g) = 1.0 - 1.0 / (0.15 * (peak - newPeak) + 1.0);
  return mix(c, KV3(newPeak), g);
}

FN(KF, srgb1, KF c) {
  return select(1.055 * pow(max(c, 0.0), 1.0 / 2.4) - 0.055, c * 12.92, c <= 0.0031308);
}

FN(KV3, srgb, KV3 c) {
  return KV3(srgb1(c.x), srgb1(c.y), srgb1(c.z));
}

// The grade, the vignette and the exposure: linear colour, before tone mapping.
FN(KV3, gradeColor, KV3 source, KV2 uv) {
  VAR(KV3, c) = source + UNI(grade).x;
  if (UNI(grade).y > 0.0) { c = (c - 0.5) / (1.0 - UNI(grade).y) + 0.5; } else { c = (c - 0.5) * (1.0 + UNI(grade).y) + 0.5; }
  VAR(KV3, k) = KV3(0.57735);
  VAR(KF, ca) = cos(UNI(grade).w);
  c = c * ca + cross(k, c) * sin(UNI(grade).w) + k * dot(k, c) * (1.0 - ca);
  VAR(KF, luma) = dot(c, KV3(0.2126, 0.7152, 0.0722));
  c = max(mix(KV3(luma), c, 1.0 + UNI(grade).z), KV3(0.0));
  if (UNI(tone).z > 0.5) {
    // The postprocessing library's default vignette (ADR 0051).
    VAR(KF, d) = distance(uv, KV2(0.5));
    c = c * smoothstep(0.8, UNI(vignetteShape).y * 0.799, d * (UNI(vignetteShape).x + UNI(vignetteShape).y));
  }
  return c * UNI(tone).x;
}

// Tone mapping, the sRGB encode, then a .cube table grades the display-referred image.
FN(KV3, displayColor, KV3 c0) {
  VAR(KV3, c) = c0;
  VAR(KI, mode) = KI(UNI(tone).y + 0.5);
  if (mode == 1) { c = aces(c); } else if (mode == 2) { c = agx(c); } else if (mode == 3) { c = clamp(neutral(c), KV3(0.0), KV3(1.0)); } else { c = clamp(c, KV3(0.0), KV3(1.0)); }
  VAR(KV3, outc) = srgb(c);
  if (UNI(lut).x > 0.0) { outc = mix(outc, applyLut(outc), UNI(lut).x); }
  return outc;
}
`);

const WGSL = /* wgsl */ `
varying vUV: vec2f;
${FINISH.text("wgsl")}
#define CUSTOM_FRAGMENT_DEFINITIONS
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let source = textureSample(textureSampler, textureSamplerSampler, input.vUV);
  let c = gradeColor(source.rgb, input.vUV);
  // -1: an HDR render texture (ADR 0109) keeps linear, unclamped colour.
  if (uniforms.tone.y < -0.5) {
    fragmentOutputs.color = vec4f(c, source.a);
    return fragmentOutputs;
  }
  let outc = displayColor(c);
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
${FINISH.text("glsl")}
#define CUSTOM_FRAGMENT_DEFINITIONS
void main(void) {
  vec4 source = texture2D(textureSampler, vUV);
  vec3 c = gradeColor(source.rgb, vUV);
  // -1: an HDR render texture (ADR 0109) keeps linear, unclamped colour.
  if (tone.y < -0.5) {
    gl_FragColor = vec4(c, source.a);
    return;
  }
  vec3 outc = displayColor(c);
  if (backdrop.a > 0.5) {
    gl_FragColor = vec4(outc + backdrop.rgb * (1.0 - clamp(source.a, 0.0, 1.0)), 1.0);
    return;
  }
  gl_FragColor = vec4(outc, source.a);
}
`;

ShaderStore.ShadersStoreWGSL[`${FINISH_SHADER}PixelShader`] = WGSL;
ShaderStore.ShadersStore[`${FINISH_SHADER}PixelShader`] = GLSL;
