// Internal to the render backend (ADR 0054): three.js types are allowed here and must never
// reach the public API (ADR 0010).
import { CubeCamera, HalfFloatType, NoToneMapping, PMREMGenerator, WebGLCubeRenderTarget } from "three";
import type { Object3D, Scene, Texture, Vector3, WebGLRenderer } from "three";

export { pickProbe, PROBE_RESOLUTION, type ProbeBox, type ProbeQuality } from "./probeBoxes";
import type { ProbeBox } from "./probeBoxes";

/** Renders the scene around a point into a cubemap and prefilters it for use as a material `envMap`. */
export class ProbeCapture {
  private readonly target: WebGLCubeRenderTarget;
  private readonly cubeCamera: CubeCamera;
  private readonly pmrem: PMREMGenerator;
  private prefiltered: Texture | null = null;
  private result: { dispose(): void } | null = null;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly _resolution: number,
  ) {
    this.target = new WebGLCubeRenderTarget(_resolution, { type: HalfFloatType });
    this.cubeCamera = new CubeCamera(0.1, 1000, this.target);
    this.pmrem = new PMREMGenerator(renderer);
  }

  get resolution(): number {
    return this._resolution;
  }

  /** The latest prefiltered map, or null before the first capture. */
  get texture(): Texture | null {
    return this.prefiltered;
  }

  /** Capture `scene` from `position` with `hide` invisible, and return the prefiltered map. */
  capture(scene: Scene, position: Vector3, hide: readonly Object3D[]): Texture {
    const visible = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;
    const renderer = this.renderer;
    const previousTarget = renderer.getRenderTarget();
    const previousToneMapping = renderer.toneMapping;
    renderer.toneMapping = NoToneMapping;
    try {
      // The cube camera isn't in the scene, so place and update its matrices by hand.
      this.cubeCamera.position.copy(position);
      this.cubeCamera.updateMatrixWorld(true);
      this.cubeCamera.update(renderer, scene);
    } finally {
      renderer.toneMapping = previousToneMapping;
      renderer.setRenderTarget(previousTarget);
      hide.forEach((o, i) => (o.visible = visible[i]!));
    }
    this.result?.dispose();
    const rt = this.pmrem.fromCubemap(this.target.texture);
    this.result = rt;
    this.prefiltered = rt.texture;
    return rt.texture;
  }

  dispose(): void {
    this.result?.dispose();
    this.result = null;
    this.prefiltered = null;
    this.target.dispose();
    this.pmrem.dispose();
  }
}
