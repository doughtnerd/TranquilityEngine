/**
 * PostProcessStack: INTERNAL to the render backend (ADR 0051). three.js and pmndrs types are allowed here and must never
 * reach the public API. It owns an `EffectComposer` (pmndrs `postprocessing`) and, when the camera asks for ambient occlusion,
 * N8AO's pass. Both libraries are loaded with a dynamic import in `create()`, so games without post-processing never
 * download them.
 *
 * Pass order: RenderPass -> [N8AOPostPass] -> EffectPass A (depth of field, bloom, chromatic aberration, colour grading,
 * vignette, tone mapping; one merged fullscreen pass) -> [EffectPass B (SMAA or FXAA; kept after tone mapping so it
 * sees display-referred colour)].
 * The composer renders into a half-float target; tone mapping and sRGB output happen in the last pass, so the backend must keep
 * `renderer.toneMapping` at NoToneMapping while this runs. Only `renderer.toneMappingExposure` is touched here.
 *
 * Overlay mode (ADR 0056): the scene renders on a transparent background and the last pass alpha-blends over the canvas
 * instead of overwriting it. Viewport (ADR 0056): pmndrs' screen pass calls `renderer.setRenderTarget(null)` and draws a
 * fullscreen quad without touching the viewport, and three applies the renderer's viewport/scissor when the target is null
 * (internal targets use their own), so setting the renderer's viewport and scissor around `composer.render` lands the
 * final pass in the rectangle.
 *
 * `configure()` rebuilds passes only when the key changes (which effects are on, the AA pass, the AO quality, the
 * scene or the camera); everything else (intensities, radii, multisampling) updates values in place.
 */
import type { Camera, Scene, WebGLRenderer } from "three";
import { Color, HalfFloatType, NormalBlending, Vector2, Vector4 } from "three";
import type * as PP from "postprocessing";

export type ToneMappingName = "none" | "aces" | "agx" | "neutral";
export type AOQuality = "low" | "medium" | "high" | "ultra";

/** The effects to run: the camera's PostProcessing component, already filtered by the quality tier. Null members are off. */
export interface PostEffects {
  toneMapping: ToneMappingName;
  exposure: number;
  antialias: "off" | "msaa" | "smaa" | "fxaa";
  bloom: { intensity: number; threshold: number; radius: number } | null;
  ambientOcclusion: { intensity: number; radius: number; quality: AOQuality } | null;
  colorGrading: { brightness: number; contrast: number; saturation: number; hue: number } | null; // hue in degrees
  vignette: { darkness: number; offset: number } | null;
  depthOfField: { focusDistance: number; focusRange: number; bokehScale: number } | null;
  chromaticAberration: { amount: number } | null;
}

/**
 * Identifies the pass layout: equal keys mean `configure` can update values in place, different keys mean a rebuild.
 * Deliberately excludes every numeric value and the multisample count (a plain property on the composer).
 */
export function stackKey(effects: PostEffects, overlay = false): string {
  return [
    overlay ? "overlay" : "base",
    effects.toneMapping,
    effects.antialias === "smaa" || effects.antialias === "fxaa" ? effects.antialias : "no-aa-pass",
    effects.bloom ? "bloom" : "-",
    effects.ambientOcclusion ? `ao:${effects.ambientOcclusion.quality}` : "-",
    effects.colorGrading ? "grade" : "-",
    effects.vignette ? "vig" : "-",
    effects.depthOfField ? "dof" : "-",
    effects.chromaticAberration ? "ca" : "-",
  ].join("|");
}

/** The composer's MSAA sample count. N8AO can't read multisampled depth, so ambient occlusion forces 0 (the tier falls back to SMAA). */
export function composerSamples(effects: PostEffects): number {
  return effects.antialias === "msaa" && !effects.ambientOcclusion ? 4 : 0;
}

/** A rectangle on the canvas, in CSS pixels from the bottom-left. */
export interface PostViewport { x: number; y: number; width: number; height: number }

/**
 * The viewport in whole drawing-buffer pixels: the edges are rounded (not the size), so neighbouring rectangles that share
 * an edge in CSS pixels share it in buffer pixels too. Width and height are at least 1.
 */
export function viewportPixels(viewport: PostViewport, pixelRatio: number): PostViewport {
  const x0 = Math.round(viewport.x * pixelRatio);
  const y0 = Math.round(viewport.y * pixelRatio);
  const x1 = Math.round((viewport.x + viewport.width) * pixelRatio);
  const y1 = Math.round((viewport.y + viewport.height) * pixelRatio);
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

/** The structural part of the key plus the objects the passes are bound to. */
function fullKey(effects: PostEffects, scene: Scene, camera: Camera, overlay: boolean): string {
  return `${stackKey(effects, overlay)}#${scene.uuid}#${camera.uuid}`;
}

// n8ao ships no type declarations: the little we use of it.
interface N8AOConfiguration { aoRadius: number; intensity: number; gammaCorrection: boolean; halfRes: boolean }
interface N8AOPostPassLike extends PP.Pass {
  configuration: N8AOConfiguration;
  setQualityMode(mode: "Performance" | "Low" | "Medium" | "High" | "Ultra"): void;
}
interface N8AOModule { N8AOPostPass: new (scene: Scene, camera: Camera, width?: number, height?: number) => N8AOPostPassLike }

const AO_MODE = { low: "Low", medium: "Medium", high: "High", ultra: "Ultra" } as const;

/** The live effect objects of the current build, kept so `update` can set their values. */
interface Built {
  key: string;
  render: PP.RenderPass;
  ao: N8AOPostPassLike | null;
  main: PP.EffectPass | null;
  aa: PP.EffectPass | null;
  /** Overlay only: a plain copy to the screen, when no effect or AA pass is last. */
  copy: PP.CopyPass | null;
  bloom?: PP.BloomEffect;
  grade?: { hs: PP.HueSaturationEffect; bc: PP.BrightnessContrastEffect };
  vignette?: PP.VignetteEffect;
  dof?: PP.DepthOfFieldEffect;
  ca?: PP.ChromaticAberrationEffect;
}

export class PostProcessStack {
  private readonly composer: PP.EffectComposer;
  private built: Built | null = null;
  private width = 1;
  private height = 1;

  private constructor(
    private readonly renderer: WebGLRenderer,
    private readonly pp: typeof PP,
    private readonly n8ao: N8AOModule,
  ) {
    this.composer = new pp.EffectComposer(renderer, { frameBufferType: HalfFloatType, multisampling: 0 });
  }

  /** Load the libraries (dynamic import, so games without post-processing never download them) and make a stack for `renderer`. */
  static async create(renderer: WebGLRenderer): Promise<PostProcessStack> {
    // @ts-ignore n8ao has no type declarations
    const [pp, n8ao] = await Promise.all([import("postprocessing"), import("n8ao")]);
    return new PostProcessStack(renderer, pp, n8ao as unknown as N8AOModule);
  }

  /** Use these effects for `scene` seen by `camera`. Rebuilds the passes only when the structure changes; otherwise updates values in place. */
  configure(effects: PostEffects, scene: Scene, camera: Camera, options?: { overlay?: boolean }): void {
    const overlay = options?.overlay === true;
    const key = fullKey(effects, scene, camera, overlay);
    if (!this.built || this.built.key !== key) this.build(key, effects, scene, camera, overlay);
    this.update(effects);
  }

  /** CSS-pixel size; uses the renderer's pixel ratio. */
  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    // The composer sizes its buffers from the size and the renderer's pixel ratio; `false` leaves the canvas style to the backend.
    this.composer.setSize(this.width, this.height, false);
  }

  /**
   * Render to the canvas (clears it first, unless this is an overlay). With a `viewport` (CSS pixels from the canvas's
   * bottom-left) only that rectangle is drawn; the caller sizes the stack to the viewport with `setSize`.
   */
  render(deltaSeconds: number, viewport?: PostViewport): void {
    if (!this.built) return;
    if (!viewport) {
      this.composer.render(deltaSeconds);
      return;
    }
    const r = this.renderer;
    const ratio = r.getPixelRatio();
    const px = viewportPixels(viewport, ratio);
    const prevViewport = r.getViewport(new Vector4());
    const prevScissor = r.getScissor(new Vector4());
    const prevScissorTest = r.getScissorTest();
    // The renderer multiplies by the pixel ratio and rounds; dividing the whole-pixel values first round-trips them.
    r.setViewport(px.x / ratio, px.y / ratio, px.width / ratio, px.height / ratio);
    r.setScissor(px.x / ratio, px.y / ratio, px.width / ratio, px.height / ratio);
    r.setScissorTest(true);
    try {
      this.composer.render(deltaSeconds);
    } finally {
      r.setViewport(prevViewport);
      r.setScissor(prevScissor);
      r.setScissorTest(prevScissorTest);
    }
  }

  dispose(): void {
    this.teardown();
    this.composer.dispose();
  }

  // ---------------------------------------------------------------------------------------------------------------

  private teardown(): void {
    const b = this.built;
    this.built = null;
    this.composer.removeAllPasses();
    if (!b) return;
    // EffectPass.dispose() disposes its effects too.
    for (const pass of [b.render, b.ao, b.main, b.aa, b.copy]) pass?.dispose();
  }

  private build(key: string, e: PostEffects, scene: Scene, camera: Camera, overlay: boolean): void {
    this.teardown();
    const pp = this.pp;
    const b: Built = { key, render: new pp.RenderPass(scene, camera), ao: null, main: null, aa: null, copy: null };
    if (overlay) {
      // Transparent background: ignore the scene's and clear to alpha 0 (the stack never clears the canvas itself).
      b.render.ignoreBackground = true;
      b.render.clearPass.overrideClearColor = new Color(0, 0, 0);
      b.render.clearPass.overrideClearAlpha = 0;
    }
    this.composer.setMainScene(scene);
    this.composer.setMainCamera(camera);
    this.composer.addPass(b.render);

    if (e.ambientOcclusion) {
      const ao = new this.n8ao.N8AOPostPass(scene, camera, this.width, this.height);
      ao.configuration.gammaCorrection = false; // the final pass does the sRGB conversion
      ao.setQualityMode(AO_MODE[e.ambientOcclusion.quality]); // sets the preset's sample counts
      // Always full resolution: N8AO 2.0.1's half-resolution target hands three r187 an array where it
      // expects one texture (WebGLTextures.setupRenderTarget reads texture.mipmaps) and throws. The
      // quality presets scale the cost instead. Revisit with the next N8AO release.
      ao.configuration.halfRes = false;
      b.ao = ao;
      this.composer.addPass(ao);
    }

    const effects: PP.Effect[] = [];
    if (e.depthOfField) effects.push((b.dof = new pp.DepthOfFieldEffect(camera, {})));
    if (e.bloom) effects.push((b.bloom = new pp.BloomEffect({ mipmapBlur: true })));
    if (e.chromaticAberration) {
      effects.push((b.ca = new pp.ChromaticAberrationEffect({ offset: new Vector2(), radialModulation: false, modulationOffset: 0 })));
    }
    if (e.colorGrading) {
      const hs = new pp.HueSaturationEffect({});
      const bc = new pp.BrightnessContrastEffect({});
      b.grade = { hs, bc };
      effects.push(hs, bc);
    }
    if (e.vignette) effects.push((b.vignette = new pp.VignetteEffect({})));
    if (e.toneMapping !== "none") {
      const mode = { aces: pp.ToneMappingMode.ACES_FILMIC, agx: pp.ToneMappingMode.AGX, neutral: pp.ToneMappingMode.NEUTRAL }[e.toneMapping];
      effects.push(new pp.ToneMappingEffect({ mode }));
    }
    // With nothing to merge, the render (or AO) pass is the last one and the composer converts to sRGB itself.
    if (effects.length > 0) {
      b.main = new pp.EffectPass(camera, ...effects);
      this.composer.addPass(b.main);
    }

    if (e.antialias === "smaa") b.aa = new pp.EffectPass(camera, new pp.SMAAEffect({}));
    else if (e.antialias === "fxaa") b.aa = new pp.EffectPass(camera, new pp.FXAAEffect({}));
    if (b.aa) this.composer.addPass(b.aa);

    if (overlay) {
      // A lone RenderPass would render straight to the canvas and clear it; always finish with a blended screen pass.
      if (!b.aa && !b.main) {
        b.copy = new pp.CopyPass();
        this.composer.addPass(b.copy);
      }
      // pmndrs' fullscreen materials default to NoBlending; blend the (straight-alpha) result over the canvas instead.
      const last = b.aa ?? b.main ?? b.copy;
      if (last) {
        last.fullscreenMaterial.transparent = true;
        last.fullscreenMaterial.blending = NormalBlending;
      }
    }

    this.built = b;
  }

  /** Push the numeric values into the live effects (cheap; runs on every configure). */
  private update(e: PostEffects): void {
    const b = this.built;
    if (!b) return;
    this.composer.multisampling = composerSamples(e);
    // pmndrs' tone mapping reads the renderer's exposure (the renderer's own toneMapping stays off).
    this.renderer.toneMappingExposure = e.exposure;

    if (b.ao && e.ambientOcclusion) {
      b.ao.configuration.aoRadius = e.ambientOcclusion.radius;
      b.ao.configuration.intensity = e.ambientOcclusion.intensity;
    }
    if (b.bloom && e.bloom) {
      b.bloom.intensity = e.bloom.intensity;
      b.bloom.luminanceMaterial.threshold = e.bloom.threshold;
      b.bloom.mipmapBlurPass.radius = e.bloom.radius;
    }
    if (b.dof && e.depthOfField) {
      b.dof.circleOfConfusionMaterial.worldFocusDistance = e.depthOfField.focusDistance;
      b.dof.circleOfConfusionMaterial.worldFocusRange = e.depthOfField.focusRange;
      b.dof.bokehScale = e.depthOfField.bokehScale;
    }
    if (b.ca && e.chromaticAberration) b.ca.offset.set(e.chromaticAberration.amount, e.chromaticAberration.amount);
    if (b.grade && e.colorGrading) {
      b.grade.hs.hue = (e.colorGrading.hue * Math.PI) / 180;
      b.grade.hs.saturation = e.colorGrading.saturation;
      b.grade.bc.brightness = e.colorGrading.brightness;
      b.grade.bc.contrast = e.colorGrading.contrast;
    }
    if (b.vignette && e.vignette) {
      b.vignette.darkness = e.vignette.darkness;
      b.vignette.offset = e.vignette.offset;
    }
  }
}
