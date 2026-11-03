/**
 * Compiled shader graphs as three.js materials (ADR 0047). Internal to the render backend: a lit
 * graph extends `MeshStandardMaterial` and an unlit one `MeshBasicMaterial`, their shader source
 * patched before WebGL compiles it, so graphs keep three's lights, shadows, environment, fog,
 * tone mapping and colour management.
 */
import {
  DataTexture,
  DoubleSide,
  FrontSide,
  type IUniform,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshDistanceMaterial,
  MeshStandardMaterial,
  RGBADepthPacking,
  SRGBColorSpace,
  type Texture,
  Vector2,
  Vector3,
  Vector4,
  type WebGLProgramParametersWithUniforms,
} from "three";
import { checkPropertyValue, type GraphValue } from "../../scene/shaderGraph";
import { linearColor, SHARED_UNIFORMS, srgbToLinear, type CompiledShaderGraph, type CompiledUniform } from "./compile";

/** The uniforms every graph material shares (time, drawing-buffer size), owned by whoever draws them. */
export interface SharedGraphUniforms {
  time: IUniform<number>;
  resolution: IUniform<Vector2>;
}

export const createSharedGraphUniforms = (): SharedGraphUniforms => ({ time: { value: 0 }, resolution: { value: new Vector2(1, 1) } });

let white: DataTexture | null = null;
/** A 1×1 white texture: what an empty texture slot reads. */
export function whiteTexture(): DataTexture {
  if (!white) {
    white = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    white.colorSpace = SRGBColorSpace;
    white.needsUpdate = true;
  }
  return white;
}

export interface GraphMaterial {
  material: MeshStandardMaterial | MeshBasicMaterial;
  /** Shadow materials that move vertices as the graph does; null without a vertex offset. */
  depth: MeshDepthMaterial | null;
  distance: MeshDistanceMaterial | null;
  /** The compiled graph it was made from. */
  compiled: CompiledShaderGraph;
  /** The property values it was made with (a material's, over the graph's defaults). */
  properties: Record<string, GraphValue>;
  /** Set every property from `values` (missing ones go back to the graph's defaults), without recompiling (ADR 0049). */
  setProperties(values: Record<string, GraphValue>): void;
  dispose(): void;
}

/** Load a texture asset; `linear` asks for data (normal maps) rather than sRGB colour. */
export type LoadTexture = (path: string, linear: boolean) => Promise<Texture>;

/** Insert `code` after the first `anchor` in `source`; throws if three's shader no longer has it. */
function after(source: string, anchor: string, code: string): string {
  const i = source.indexOf(anchor);
  if (i < 0) throw new Error(`shader graph: three.js shader has no "${anchor}" to patch`);
  return `${source.slice(0, i + anchor.length)}\n${code}${source.slice(i + anchor.length)}`;
}

function beforeMain(source: string, declarations: string, startOfMain = ""): string {
  const i = source.indexOf("void main() {");
  if (i < 0) throw new Error("shader graph: three.js shader has no main()");
  return `${source.slice(0, i)}${declarations}\nvoid main() {\n${startOfMain}${source.slice(i + "void main() {".length)}`;
}

/** Patch a vertex shader: declarations, the vertex offset, and (if wanted) the graph's varyings. */
export function patchVertexShader(source: string, c: CompiledShaderGraph, varyings: boolean): string {
  let s = beforeMain(source, c.vertex.declarations);
  s = after(s, "#include <begin_vertex>", `${c.vertex.body}${c.vertex.offset ? `\ntransformed += ${c.vertex.offset};` : ""}`);
  if (varyings) s = after(s, "#include <project_vertex>", c.vertex.varyings);
  return s;
}

/** Patch a lit (`meshphysical`) or unlit (`meshbasic`) fragment shader to take its surface from the graph. */
export function patchFragmentShader(source: string, c: CompiledShaderGraph): string {
  const f = c.fragment;
  let s = beforeMain(source, f.declarations, `${f.body}\n`);
  s = after(s, "#include <color_fragment>", `diffuseColor = vec4(${f.baseColor}, ${f.alpha});${f.alphaClip ? `\nif (diffuseColor.a < ${f.alphaClip}) discard;` : ""}`);
  if (c.target === "lit") {
    s = after(s, "#include <roughnessmap_fragment>", `roughnessFactor = ${f.roughness};`);
    s = after(s, "#include <metalnessmap_fragment>", `metalnessFactor = ${f.metalness};`);
    if (f.normal) s = after(s, "#include <normal_fragment_maps>", `normal = normalize(mycoTangentFrame(-vViewPosition, normal, vMycoUv) * ${f.normal});`);
    s = after(s, "#include <emissivemap_fragment>", `totalEmissiveRadiance = ${f.emission};`);
  }
  return s;
}

/** A property's value for a uniform: the material's override if it suits the type, else the graph's default. */
function uniformValue(u: CompiledUniform, overrides: Record<string, GraphValue>): unknown {
  let v: GraphValue = u.value;
  const own = u.property ? overrides[u.property] : undefined;
  // A colour given as numbers (sRGB 0–1, from a script) instead of "#rrggbb".
  if (u.propertyType === "color" && Array.isArray(own) && own.length >= 3) return new Vector4(srgbToLinear(own[0]), srgbToLinear(own[1]), srgbToLinear(own[2]), own[3] ?? 1);
  if (u.property && u.propertyType && own !== undefined) v = checkPropertyValue(u.propertyType, own) ?? u.value;
  if (u.type === "sampler2D") return v;
  if (u.propertyType === "color") return new Vector4(...linearColor(String(v)));
  if (u.type === "float") return typeof v === "number" ? v : 0;
  const a = Array.isArray(v) ? v : [];
  return u.type === "vec2" ? new Vector2(a[0] ?? 0, a[1] ?? 0) : u.type === "vec3" ? new Vector3(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0) : new Vector4(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0);
}

/**
 * A three.js material for a compiled graph. `overrides` are a material's property values;
 * `loadTexture` fetches texture assets (slots read white until they load).
 */
export function createGraphMaterial(c: CompiledShaderGraph, overrides: Record<string, GraphValue>, shared: SharedGraphUniforms, loadTexture: LoadTexture, onTexture?: () => void): GraphMaterial {
  const uniforms: Record<string, IUniform> = { [SHARED_UNIFORMS.time]: shared.time, [SHARED_UNIFORMS.resolution]: shared.resolution };
  let disposed = false;
  /** Each texture slot's path, so setting the same texture again doesn't reload it. */
  const slotPaths = new Map<string, string>();
  const apply = (values: Record<string, GraphValue>) => {
    for (const u of c.uniforms) {
      const value = uniformValue(u, values);
      if (u.type !== "sampler2D") {
        if (uniforms[u.name]) uniforms[u.name].value = value;
        else uniforms[u.name] = { value };
        continue;
      }
      const slot = (uniforms[u.name] ??= { value: whiteTexture() }) as IUniform<Texture>;
      const path = String(value).replace(/^asset:/, "");
      if (slotPaths.get(u.name) === path) continue;
      slotPaths.set(u.name, path);
      slot.value = whiteTexture();
      if (path)
        loadTexture(path, !!u.linear)
          .then((tex) => {
            if (disposed || slotPaths.get(u.name) !== path) return;
            slot.value = tex;
            onTexture?.();
          })
          .catch((err) => console.error(`[myco] failed to load texture "${path}" for a shader graph:`, err));
    }
  };
  apply(overrides);
  const transparent = c.surface === "transparent";
  const common = { transparent, depthWrite: !transparent, side: c.doubleSided ? DoubleSide : FrontSide };
  const material = c.target === "lit" ? new MeshStandardMaterial({ ...common, color: 0xffffff }) : new MeshBasicMaterial({ ...common, color: 0xffffff });
  const key = `myco-graph-${c.key}`;
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = patchVertexShader(shader.vertexShader, c, true);
    shader.fragmentShader = patchFragmentShader(shader.fragmentShader, c);
  };
  material.customProgramCacheKey = () => key;
  let depth: MeshDepthMaterial | null = null;
  let distance: MeshDistanceMaterial | null = null;
  if (c.vertex.offset) {
    const shadow = <M extends MeshDepthMaterial | MeshDistanceMaterial>(m: M, kind: string): M => {
      m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = patchVertexShader(shader.vertexShader, c, false);
      };
      m.customProgramCacheKey = () => `${key}-${kind}`;
      return m;
    };
    depth = shadow(new MeshDepthMaterial({ depthPacking: RGBADepthPacking }), "depth");
    distance = shadow(new MeshDistanceMaterial(), "distance");
  }
  return {
    material,
    depth,
    distance,
    compiled: c,
    properties: { ...overrides },
    setProperties: apply,
    dispose() {
      disposed = true;
      material.dispose();
      depth?.dispose();
      distance?.dispose();
    },
  };
}
