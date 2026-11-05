/**
 * The water material's shader patches (ADR 0072): GLSL spliced into three's MeshPhysicalMaterial
 * in `onBeforeCompile`. The vertex part displaces the grid by the Gerstner sum (`gerstnerGLSL`, the
 * same text the CPU sampler is tested against) and gives it the analytic normal; the fragment part
 * mixes deep to shallow colour, adds crest foam from the waves' Jacobian and scrolling ripple
 * normals. Everything else (lights, shadows, environment and probe reflections, fog) is three's
 * own physical shading, so fog (ADR 0071) and the environment (0053/0054) apply as on any material.
 */
import { gerstnerGLSL } from "./gerstner";

/** Uniform names the patches read, besides `mycoWaves` and `mycoWaveCount`. */
export const WATER_UNIFORMS = ["mycoWaterTime", "mycoDeepColor", "mycoShallowColor", "mycoFoamColor", "mycoFoamAmount", "mycoNormalDetail", "mycoMaxHeight"] as const;

const VERTEX_PARS = `${gerstnerGLSL()}
varying float vMycoHeight;
varying float vMycoJacobian;
varying vec2 vMycoRest;
varying vec3 vMycoAxisX;
varying vec3 vMycoAxisZ;
`;

/** Replaces `#include <beginnormal_vertex>`: the wave sum, its normal, and what the fragment needs. */
const VERTEX_NORMAL = `
vec3 mycoDisp; vec3 mycoTangent; vec3 mycoBinormal;
mycoGerstner(position.x, position.z, mycoDisp, mycoTangent, mycoBinormal);
vec3 objectNormal = normalize(cross(mycoBinormal, mycoTangent));
#ifdef USE_TANGENT
  vec3 objectTangent = normalize(mycoTangent);
#endif
vMycoHeight = mycoDisp.y;
vMycoJacobian = mycoTangent.x * mycoBinormal.z - mycoTangent.z * mycoBinormal.x;
vMycoRest = position.xz;
vMycoAxisX = normalize((modelViewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
vMycoAxisZ = normalize((modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
`;

/** After `#include <begin_vertex>`: move the vertex (shadows and fog then use the moved position). */
const VERTEX_DISPLACE = `
transformed += mycoDisp;
`;

const FRAGMENT_PARS = `
uniform float mycoWaterTime;
uniform vec3 mycoDeepColor;
uniform vec3 mycoShallowColor;
uniform vec3 mycoFoamColor;
uniform float mycoFoamAmount;
uniform float mycoNormalDetail;
uniform float mycoMaxHeight;
varying float vMycoHeight;
varying float vMycoJacobian;
varying vec2 vMycoRest;
varying vec3 vMycoAxisX;
varying vec3 vMycoAxisZ;

float mycoHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
// Value noise and its gradient.
vec3 mycoNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = mycoHash(i);
  float b = mycoHash(i + vec2(1.0, 0.0));
  float c = mycoHash(i + vec2(0.0, 1.0));
  float d = mycoHash(i + vec2(1.0, 1.0));
  float v = a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
  vec2 g = du * vec2(b - a + (a - b - c + d) * u.y, c - a + (a - b - c + d) * u.x);
  return vec3(v, g);
}
`;

/** After `#include <normal_fragment_maps>`: ripples, colour, foam. */
const FRAGMENT_SURFACE = `
{
  // Two scrolling layers of ripple normals.
  vec3 r1 = mycoNoise(vMycoRest * 0.35 + vec2(mycoWaterTime * 0.11, mycoWaterTime * 0.07));
  vec3 r2 = mycoNoise(vMycoRest * 0.9 + vec2(-mycoWaterTime * 0.05, mycoWaterTime * 0.13));
  vec2 slope = (r1.yz * 0.35 + r2.yz * 0.9 * 0.5) * mycoNormalDetail * 0.25;
  normal = normalize(normal - vMycoAxisX * slope.x - vMycoAxisZ * slope.y);

  vec3 mycoView = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);
  float facing = clamp(dot(normal, mycoView), 0.0, 1.0);
  float crest = mycoMaxHeight > 0.0 ? clamp(vMycoHeight / mycoMaxHeight * 0.5 + 0.5, 0.0, 1.0) : 0.5;
  float shallow = clamp(0.55 * crest + 0.45 * (1.0 - facing), 0.0, 1.0);
  diffuseColor.rgb = mix(mycoDeepColor, mycoShallowColor, shallow);

  // Foam where the surface is compressed (the Jacobian falls toward 0 where crests fold), broken up by the ripples.
  float fold = 1.0 - vMycoJacobian + (r1.x - 0.5) * 0.15;
  float threshold = 1.0 - clamp(mycoFoamAmount, 0.0, 1.0);
  float foam = mycoFoamAmount > 0.0 ? smoothstep(threshold, threshold + 0.35, fold) : 0.0;
  diffuseColor.rgb = mix(diffuseColor.rgb, mycoFoamColor, foam);
  roughnessFactor = mix(roughnessFactor, 0.9, foam);
}
`;

/** The parts of a three.js shader `onBeforeCompile` hands over that the patch edits. */
export interface PatchableShader {
  vertexShader: string;
  fragmentShader: string;
}

function replaceOnce(source: string, find: string, replace: string, where: string): string {
  if (!source.includes(find)) throw new Error(`[myco] water shader: "${find}" not found in the ${where} shader.`);
  return source.replace(find, replace);
}

/** Splice the water code into a MeshPhysicalMaterial's shaders. */
export function patchWaterShader(shader: PatchableShader): void {
  let v = shader.vertexShader;
  v = replaceOnce(v, "#include <common>", `#include <common>\n${VERTEX_PARS}`, "vertex");
  v = replaceOnce(v, "#include <beginnormal_vertex>", VERTEX_NORMAL, "vertex");
  v = replaceOnce(v, "#include <begin_vertex>", `#include <begin_vertex>\n${VERTEX_DISPLACE}`, "vertex");
  shader.vertexShader = v;
  let f = shader.fragmentShader;
  f = replaceOnce(f, "#include <common>", `#include <common>\n${FRAGMENT_PARS}`, "fragment");
  f = replaceOnce(f, "#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${FRAGMENT_SURFACE}`, "fragment");
  shader.fragmentShader = f;
}
