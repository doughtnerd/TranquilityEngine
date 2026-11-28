// The triangles a frame really drew (RenderStats.triangles), counted where Babylon draws.
// `scene.getActiveIndices()` only covers the scene's own active meshes of one render: it misses shadow passes
// and any other view, so the counter wraps the engine's two draw entry points once and adds up every draw of the
// frame, whichever pass issued it: indices (or vertices) / 3 x instances. A frame starts with `beginFrame`, like
// Babylon's own draw-call counter, so between frames the total is the last frame's.

/** The draw entry points of a Babylon engine the counter wraps (WebGL2, WebGPU and the null engine all have them). */
export interface DrawingEngine {
  drawElementsType(fillMode: number, indexStart: number, indexCount: number, instancesCount?: number): void;
  drawArraysType(fillMode: number, verticesStart: number, verticesCount: number, instancesCount?: number): void;
}

// Babylon's Constants.MATERIAL_*: the fill / draw modes that make triangles.
const TRIANGLES = 0;
const TRIANGLE_STRIP = 7;
const TRIANGLE_FAN = 8;

/** Triangles drawn since the last `beginFrame`. */
export class DrawCounter {
  /** This frame's triangles so far. */
  private total = 0;
  /** The last finished frame's (the frame before the latest `beginFrame`). */
  private last = 0;

  /**
   * Triangles the last finished frame drew. Not the frame in progress: a slow frame can yield partway (pipelines
   * compiling), and a reading taken then would see a partial count, while Babylon's draw-call counter reports the last
   * whole frame too.
   */
  get triangles(): number {
    return this.last;
  }

  /** Start a frame: the frame before it is finished, and the running total restarts at 0. */
  beginFrame(): void {
    this.last = this.total;
    this.total = 0;
  }

  /** Add one draw of `count` indices (or vertices) in `fillMode`, `instances` times (0 or undefined: not instanced, one). */
  add(fillMode: number, count: number, instances: number | undefined): void {
    let tris: number;
    if (fillMode === TRIANGLES) tris = Math.floor(count / 3);
    else if (fillMode === TRIANGLE_STRIP || fillMode === TRIANGLE_FAN) tris = Math.max(0, count - 2);
    else return; // lines and points
    this.total += tris * (instances || 1);
  }

  /** Count every draw `engine` makes from now on (once per engine), and still make it. */
  attach(engine: DrawingEngine): void {
    const elements = engine.drawElementsType.bind(engine);
    const arrays = engine.drawArraysType.bind(engine);
    engine.drawElementsType = (fillMode, indexStart, indexCount, instancesCount) => {
      this.add(fillMode, indexCount, instancesCount);
      elements(fillMode, indexStart, indexCount, instancesCount);
    };
    engine.drawArraysType = (fillMode, verticesStart, verticesCount, instancesCount) => {
      this.add(fillMode, verticesCount, instancesCount);
      arrays(fillMode, verticesStart, verticesCount, instancesCount);
    };
  }
}
