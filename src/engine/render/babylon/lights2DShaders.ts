/**
 * The 2D light pass's shaders (ADR 0399, 0413) on Babylon: the light shader, which draws every light of one layer batch
 * and blend style into its light texture (flat, or with the directional textures as MRT), and the shadow shader, which
 * draws casters' edges extruded away from each shadowed light into a channel of a shadow texture. The maths is KSL
 * (`render/lights2D/lightShader.ts`, ADR 0250); only the entry points and Babylon's attribute, varying and uniform
 * spellings are per language here.
 *
 * Light vertex attributes (all per vertex; lights are batched into one draw per texture, so nothing is per draw):
 * - `position` (vec2): world XY, or clip XY for a global light (kind 0, a full-screen quad);
 * - `l2dLocal` (vec2): the light's local XY (point lights), or the sprite's UV (sprite lights);
 * - `l2dColor` (vec4): linear colour × intensity, and a per-vertex alpha (a freeform light's falloff band);
 * - `l2dShape` (vec4): inner and outer radius, half inner and half outer cone angle (degrees);
 * - `l2dMisc` (vec4): kind (0 global, 1 point, 2 freeform, 3 sprite), falloff exponent, directional (0/1), shadow slot (-1: none);
 * - `l2dLight` (vec4): the light's world X, Y, height, and shadow strength;
 * - `l2dExtra` (vec4): shadow softness, the light's world Z, overlap (0 additive, 1 alpha blend, ADR 0415), unused.
 *
 * Blending is premultiplied (`ONE, ONE_MINUS_SRC_ALPHA`): an additive light writes alpha 0 (so it adds), an alpha blend
 * light writes its brightness as alpha (so it covers the light below it by as much).
 *
 * Shadow vertex attributes: `position` (vec2, an edge end in world XY), `s2dExtrude` (vec2: 1 for the far ends, the
 * caster's world Z), `s2dLight` (vec4: light X, Y, reach, -), `s2dChannel` (vec4: the slot's channel as a mask).
 */
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore.js";
import { LIGHT2D_SHADER } from "../lights2D/lightShader";
import { shaderSource, type ShaderDialect } from "../shaderSource/shaderSource";

export const LIGHT2D_PASS = "myco2DLight";
export const LIGHT2D_PASS_DIR = "myco2DLightDir";
export const SHADOW2D_PASS = "myco2DShadow";

export const LIGHT2D_ATTRIBUTES = ["position", "l2dLocal", "l2dColor", "l2dShape", "l2dMisc", "l2dLight", "l2dExtra"] as const;
/** Floats per vertex of each light attribute, in `LIGHT2D_ATTRIBUTES` order. */
export const LIGHT2D_SIZES = [2, 2, 4, 4, 4, 4, 4] as const;
export const LIGHT2D_UNIFORMS = ["viewProjection", "l2dScreen"];
export const LIGHT2D_SAMPLERS = ["l2dShadow0", "l2dShadow1", "l2dShadow2", "l2dShadow3", "l2dSprite"];

export const SHADOW2D_ATTRIBUTES = ["position", "s2dExtrude", "s2dLight", "s2dChannel"] as const;
export const SHADOW2D_SIZES = [2, 2, 4, 4] as const;
export const SHADOW2D_UNIFORMS = ["viewProjection"];

/** The shadow lookup (KSL): slot → texture and channel, with a few taps for soft edges. The lit 2D material reads it too, for accurate lights (ADR 0415). */
export const SHADOW2D_LOOKUP = shaderSource(/* KSL */ `
TEXTURE2D(l2dShadow0);
TEXTURE2D(l2dShadow1);
TEXTURE2D(l2dShadow2);
TEXTURE2D(l2dShadow3);

FN(KF, myco2DShadowTap, KV2 uv, KF tex, KV4 mask) {
  VAR(KV4, s) = KV4(0.0, 0.0, 0.0, 0.0);
  if (tex < 0.5) {
    s = KTEX(l2dShadow0, uv);
  } else {
    if (tex < 1.5) {
      s = KTEX(l2dShadow1, uv);
    } else {
      if (tex < 2.5) {
        s = KTEX(l2dShadow2, uv);
      } else {
        s = KTEX(l2dShadow3, uv);
      }
    }
  }
  return dot(s, mask);
}

FN(KF, myco2DShadow, KV2 uv, KF slot, KV2 texel, KF soft) {
  if (slot < -0.5) {
    return 0.0;
  }
  VAR(KF, tex) = floor(slot / 4.0 + 0.001);
  VAR(KF, c) = slot - tex * 4.0;
  VAR(KV4, mask) = KV4(select(0.0, 1.0, c < 0.5), select(0.0, 1.0, c > 0.5 && c < 1.5), select(0.0, 1.0, c > 1.5 && c < 2.5), select(0.0, 1.0, c > 2.5));
  VAR(KF, s) = myco2DShadowTap(uv, tex, mask);
  if (soft > 0.001) {
    VAR(KV2, o) = texel * (soft * 6.0);
    s = s * 0.2 + 0.2 * (myco2DShadowTap(uv + KV2(o.x, 0.0), tex, mask) + myco2DShadowTap(uv - KV2(o.x, 0.0), tex, mask) + myco2DShadowTap(uv + KV2(0.0, o.y), tex, mask) + myco2DShadowTap(uv - KV2(0.0, o.y), tex, mask));
  }
  return s;
}
`);

/** The light's value at a fragment (KSL): attenuation by kind, the sprite texture, shadows. */
const LIGHT_VALUE = shaderSource(/* KSL */ `
TEXTURE2D(l2dSprite);

FN(KV4, myco2DLightValue, KV2 local, KV4 color, KV4 shape, KV4 misc, KV4 light, KV4 extra, KV2 screenUv, KV2 texel) {
  VAR(KF, k) = 1.0;
  VAR(KV3, c) = KV3(color.x, color.y, color.z);
  if (misc.x > 0.5 && misc.x < 1.5) {
    k = myco2DPointAtten(local, shape, misc.y);
  }
  if (misc.x > 1.5 && misc.x < 2.5) {
    k = color.w;
  }
  if (misc.x > 2.5) {
    VAR(KV4, t) = KTEX(l2dSprite, local);
    c = c * KV3(t.x, t.y, t.z);
    k = t.w * color.w;
  }
  if (misc.w > -0.5) {
    k = k * (1.0 - clamp(light.w, 0.0, 1.0) * myco2DShadow(screenUv, misc.w, texel, extra.x));
  }
  return KV4(c * max(k, 0.0), clamp(k, 0.0, 1.0));
}
`);

const FRAG = shaderSource(LIGHT2D_SHADER, SHADOW2D_LOOKUP, LIGHT_VALUE);

const VARYINGS: [string, string][] = [
  ["vWorld", "vec2"],
  ["vLocal", "vec2"],
  ["vColor", "vec4"],
  ["vShape", "vec4"],
  ["vMisc", "vec4"],
  ["vLight", "vec4"],
  ["vExtra", "vec4"],
];

const wgslType = (t: string) => `${t}f`;

function lightVertex(dialect: ShaderDialect): string {
  const src = ["position", "l2dLocal", "l2dColor", "l2dShape", "l2dMisc", "l2dLight", "l2dExtra"];
  if (dialect === "glsl") {
    return [
      "precision highp float;",
      ...src.map((a, i) => `attribute ${["vec2", "vec2", "vec4", "vec4", "vec4", "vec4", "vec4"][i]} ${a};`),
      "uniform mat4 viewProjection;",
      ...VARYINGS.map(([n, t]) => `varying ${t} ${n};`),
      "void main(void) {",
      "  vWorld = position; vLocal = l2dLocal; vColor = l2dColor; vShape = l2dShape; vMisc = l2dMisc; vLight = l2dLight; vExtra = l2dExtra;",
      "  if (l2dMisc.x < 0.5) { gl_Position = vec4(position, 0.0, 1.0); } else { gl_Position = viewProjection * vec4(position, l2dExtra.y, 1.0); }",
      "}",
    ].join("\n");
  }
  return [
    ...src.map((a, i) => `attribute ${a}: ${wgslType(["vec2", "vec2", "vec4", "vec4", "vec4", "vec4", "vec4"][i])};`),
    "uniform viewProjection: mat4x4f;",
    ...VARYINGS.map(([n, t]) => `varying ${n}: ${wgslType(t)};`),
    "@vertex",
    "fn main(input: VertexInputs) -> FragmentInputs {",
    "  vertexOutputs.vWorld = vertexInputs.position; vertexOutputs.vLocal = vertexInputs.l2dLocal; vertexOutputs.vColor = vertexInputs.l2dColor;",
    "  vertexOutputs.vShape = vertexInputs.l2dShape; vertexOutputs.vMisc = vertexInputs.l2dMisc; vertexOutputs.vLight = vertexInputs.l2dLight; vertexOutputs.vExtra = vertexInputs.l2dExtra;",
    "  if (vertexInputs.l2dMisc.x < 0.5) { vertexOutputs.position = vec4f(vertexInputs.position, 0.0, 1.0); } else { vertexOutputs.position = uniforms.viewProjection * vec4f(vertexInputs.position, vertexInputs.l2dExtra.y, 1.0); }",
    "}",
  ].join("\n");
}

/** The light fragment shader; `directional` writes three targets (flat, directional colour, direction sum). */
function lightFragment(dialect: ShaderDialect, directional: boolean): string {
  const lum = "KV3(0.2126, 0.7152, 0.0722)";
  if (dialect === "glsl") {
    const body = [
      "  vec2 texel = l2dScreen.xy;",
      "  vec2 uv = gl_FragCoord.xy * texel;",
      "  vec4 lv = myco2DLightValue(vLocal, vColor, vShape, vMisc, vLight, vExtra, uv, texel);",
      "  vec3 light = lv.xyz * l2dScreen.z;",
      "  float a = vExtra.z > 0.5 ? lv.w : 0.0;",
    ];
    const out = directional
      ? [
          "  if (vMisc.z > 0.5) {",
          `    mycoOut0 = vec4(0.0, 0.0, 0.0, a); mycoOut1 = vec4(light, a); mycoOut2 = vec4(myco2DLightDir(vLight.xy, vLight.z, vWorld) * dot(light, ${lum.replace("KV3", "vec3")}), a);`,
          "  } else { mycoOut0 = vec4(light, a); mycoOut1 = vec4(0.0, 0.0, 0.0, a); mycoOut2 = vec4(0.0, 0.0, 0.0, a); }",
        ]
      : ["  gl_FragColor = vec4(light, a);"];
    return [
      "precision highp float;",
      ...(directional ? ["layout(location = 0) out vec4 mycoOut0;", "layout(location = 1) out vec4 mycoOut1;", "layout(location = 2) out vec4 mycoOut2;"] : []),
      "uniform vec4 l2dScreen;",
      ...VARYINGS.map(([n, t]) => `varying ${t} ${n};`),
      FRAG.text("glsl"),
      "void main(void) {",
      ...body,
      ...out,
      "}",
    ].join("\n");
  }
  const out = directional
    ? [
        "  if (fragmentInputs.vMisc.z > 0.5) {",
        `    fragmentOutputs.fragData0 = vec4f(0.0, 0.0, 0.0, a); fragmentOutputs.fragData1 = vec4f(light, a); fragmentOutputs.fragData2 = vec4f(myco2DLightDir(fragmentInputs.vLight.xy, fragmentInputs.vLight.z, fragmentInputs.vWorld) * dot(light, ${lum.replace("KV3", "vec3f")}), a);`,
        "  } else { fragmentOutputs.fragData0 = vec4f(light, a); fragmentOutputs.fragData1 = vec4f(0.0, 0.0, 0.0, a); fragmentOutputs.fragData2 = vec4f(0.0, 0.0, 0.0, a); }",
      ]
    : ["  fragmentOutputs.color = vec4f(light, a);"];
  return [
    "uniform l2dScreen: vec4f;",
    ...VARYINGS.map(([n, t]) => `varying ${n}: ${wgslType(t)};`),
    FRAG.text("wgsl"),
    "@fragment",
    "fn main(input: FragmentInputs) -> FragmentOutputs {",
    "  let texel = uniforms.l2dScreen.xy;",
    "  let uv = fragmentInputs.position.xy * texel;",
    "  let lv = myco2DLightValue(fragmentInputs.vLocal, fragmentInputs.vColor, fragmentInputs.vShape, fragmentInputs.vMisc, fragmentInputs.vLight, fragmentInputs.vExtra, uv, texel);",
    "  let light = lv.xyz * uniforms.l2dScreen.z;",
    "  let a = select(0.0, lv.w, fragmentInputs.vExtra.z > 0.5);",
    ...out,
    "}",
  ].join("\n");
}

function shadowVertex(dialect: ShaderDialect): string {
  const extrude = (p: string, e: string, l: string) =>
    dialect === "glsl"
      ? [`vec2 p = ${p};`, `if (${e}.x > 0.5) { vec2 d = p - ${l}.xy; float len = length(d); if (len > 0.000001) { p = p + d / len * (${l}.z * 2.0 + 1.0); } }`]
      : [`var p = ${p};`, `if (${e}.x > 0.5) { let d = p - ${l}.xy; let len = length(d); if (len > 0.000001) { p = p + d / len * (${l}.z * 2.0 + 1.0); } }`];
  if (dialect === "glsl") {
    return [
      "precision highp float;",
      "attribute vec2 position;",
      "attribute vec2 s2dExtrude;",
      "attribute vec4 s2dLight;",
      "attribute vec4 s2dChannel;",
      "uniform mat4 viewProjection;",
      "varying vec4 vChannel;",
      "void main(void) {",
      ...extrude("position", "s2dExtrude", "s2dLight").map((l) => `  ${l}`),
      "  vChannel = s2dChannel;",
      "  gl_Position = viewProjection * vec4(p, s2dExtrude.y, 1.0);",
      "}",
    ].join("\n");
  }
  return [
    "attribute position: vec2f;",
    "attribute s2dExtrude: vec2f;",
    "attribute s2dLight: vec4f;",
    "attribute s2dChannel: vec4f;",
    "uniform viewProjection: mat4x4f;",
    "varying vChannel: vec4f;",
    "@vertex",
    "fn main(input: VertexInputs) -> FragmentInputs {",
    ...extrude("vertexInputs.position", "vertexInputs.s2dExtrude", "vertexInputs.s2dLight").map((l) => `  ${l}`),
    "  vertexOutputs.vChannel = vertexInputs.s2dChannel;",
    "  vertexOutputs.position = uniforms.viewProjection * vec4f(p, vertexInputs.s2dExtrude.y, 1.0);",
    "}",
  ].join("\n");
}

const shadowFragment = (dialect: ShaderDialect): string =>
  dialect === "glsl"
    ? ["precision highp float;", "varying vec4 vChannel;", "void main(void) { gl_FragColor = vChannel; }"].join("\n")
    : ["varying vChannel: vec4f;", "@fragment", "fn main(input: FragmentInputs) -> FragmentOutputs { fragmentOutputs.color = fragmentInputs.vChannel; }"].join("\n");

for (const dialect of ["glsl", "wgsl"] as const) {
  const store = dialect === "glsl" ? ShaderStore.ShadersStore : ShaderStore.ShadersStoreWGSL;
  store[`${LIGHT2D_PASS}VertexShader`] = lightVertex(dialect);
  store[`${LIGHT2D_PASS}PixelShader`] = lightFragment(dialect, false);
  store[`${LIGHT2D_PASS_DIR}VertexShader`] = lightVertex(dialect);
  store[`${LIGHT2D_PASS_DIR}PixelShader`] = lightFragment(dialect, true);
  store[`${SHADOW2D_PASS}VertexShader`] = shadowVertex(dialect);
  store[`${SHADOW2D_PASS}PixelShader`] = shadowFragment(dialect);
}

