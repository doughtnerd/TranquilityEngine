/**
 * A camera's pass plan (ADR 0274): the passes its part of the frame runs, in order, the textures they
 * need, and a layout key built only from those passes. Pure and renderer-neutral, so the rule for what
 * rebuilds the frame graph lives here once; the Babylon frame graph (`render/babylon/frameGraph.ts`)
 * builds from the plan and rebuilds only when a camera's plan key changes. Every other effect value
 * (tone mapping, exposure, grading, the vignette, the LUT, each effect's strength) is a uniform or a
 * task property, updated each frame without a rebuild.
 */
import { AO_SETTINGS, type PostEffects } from "./postEffects";

/** One kind of pass in a camera's part of the frame. */
export type PassKind = "clear" | "geometry" | "lights2d" | "render" | "ao" | "dof" | "bloom" | "ca" | "finish" | "fxaa";

export interface CameraPassPlan {
  /**
   * The passes in order. The geometry pass (view depth, and normals for ambient occlusion) runs before
   * the render pass, so what the render pass draws last (particles) can sample the opaque scene's depth
   * (ADR 0109). The finish pass grades, vignettes, applies the LUT and tone maps (all uniforms).
   */
  readonly passes: readonly PassKind[];
  /** The geometry pass's textures, or null without one: view depth (with its own depth buffer), and normals when ambient occlusion reads them. */
  readonly geometry: { readonly normals: boolean } | null;
  /** Whether the camera's colour and depth may be multisampled: not when ambient occlusion's geometry pass would need to share a multisampled depth. */
  readonly multisample: boolean;
  /** Ambient occlusion's share of the camera's resolution (a build-time choice), or null without it. */
  readonly aoRatio: number | null;
  /** The finish pass writes an 8-bit texture for the FXAA pass after it, rather than the camera's output. */
  readonly finishToLdr: boolean;
  /**
   * The 2D light textures (ADR 0399), or null without 2D lights: per layer batch, how many blend styles it uses and
   * whether it has the directional textures; their scale of the camera's size; how many shadow textures (4 lights each).
   */
  readonly lights2D: Light2DLayout | null;
  /** Equal keys mean the frame graph built for one plan serves the other; built from the members above only. */
  readonly key: string;
}

/**
 * The 2D light textures' layout (ADR 0399): only what decides which textures exist. Lights' number, colours, positions
 * and shapes are draw data, so changing them never rebuilds the frame graph.
 */
export interface Light2DLayout {
  readonly batches: readonly { readonly styles: number; readonly directional: boolean }[];
  /** The textures' size as a share of the camera's (the tier's `textureScale`). */
  readonly scale: number;
  readonly shadowTextures: number;
  /** Light textures are 8-bit (half float isn't renderable): values are stored at a quarter (`range` 4). */
  readonly lowPrecision: boolean;
}

/**
 * The pass plan for a camera's effects on this tier (null: none) when `depth` says something asked for
 * the scene depth (ADR 0109). Babylon's frame graph has no SMAA: FXAA stands in for it, so the two plan
 * the same pass.
 */
export function planCameraPasses(effects: PostEffects | null, depth = false, lights2D: Light2DLayout | null = null): CameraPassPlan {
  const ao = effects?.ambientOcclusion ?? null;
  const geometry = depth || !!ao || !!effects?.depthOfField;
  const fxaa = effects?.antialias === "fxaa" || effects?.antialias === "smaa";
  const passes: PassKind[] = ["clear"];
  if (geometry) passes.push("geometry");
  const lit = lights2D && lights2D.batches.length > 0 ? lights2D : null;
  if (lit) passes.push("lights2d");
  passes.push("render");
  if (ao) passes.push("ao");
  if (effects?.depthOfField) passes.push("dof");
  if (effects?.bloom) passes.push("bloom");
  if (effects?.chromaticAberration) passes.push("ca");
  passes.push("finish");
  if (fxaa) passes.push("fxaa");
  const plan = {
    passes,
    geometry: geometry ? { normals: !!ao } : null,
    multisample: !ao,
    aoRatio: ao ? AO_SETTINGS[ao.quality].ratio : null,
    finishToLdr: fxaa,
    lights2D: lit,
  };
  return { ...plan, key: layoutKey(plan) };
}

/** Each pass with the texture choices it was built with: the multisample count itself is the frame's, not the camera's. */
function layoutKey(p: Omit<CameraPassPlan, "key">): string {
  return p.passes
    .map((pass) => {
      switch (pass) {
        case "geometry":
          return p.geometry?.normals ? "geometry(depth,normals)" : "geometry(depth)";
        case "render":
          return p.multisample ? "render(msaa)" : "render";
        case "ao":
          return `ao@${p.aoRatio}`;
        case "lights2d":
          return `lights2d(${p.lights2D!.batches.map((b) => `${b.styles}${b.directional ? "d" : ""}`).join(",")}@${p.lights2D!.scale}${p.lights2D!.lowPrecision ? "/8" : ""}+${p.lights2D!.shadowTextures}s)`;
        case "finish":
          return p.finishToLdr ? "finish>ldr" : "finish";
        default:
          return pass;
      }
    })
    .join(" ");
}
