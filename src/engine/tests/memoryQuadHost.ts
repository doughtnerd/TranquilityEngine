// Test helper (not a production module): an in-memory `QuadBatchHost` for renderer-neutral render features (tile
// layers, 2D lines and decals, skinned sprites, light volumes; ADR 0136, 0445). Each batch keeps what it was last given
// and works out its `place` as the Babylon backend does, with `drawPlace` (`render/sortOrder.ts`) on the project's
// sorting layers, so tests assert places, not the arguments a feature passed.
import { World } from "../core/World";
import type { QuadBatch, QuadBatchHost, QuadBlend, QuadMask } from "../render/quadBatches";
import { drawPlace, isYSorted, type DrawSort, type YSortSettings } from "../render/sortOrder";

/** A batch of the in-memory host: what it was last given, and its place. */
export interface MemoryQuadBatch extends QuadBatch {
  readonly name: string;
  texture: string;
  /** The arrays of the last `setQuads` or `setTriangles` (as passed, not copied). */
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  colors: Float32Array | null;
  /** Quads of the last `setQuads` (0 after `setTriangles`). */
  quads: number;
  /** How many times `setQuads` or `setTriangles` was called. */
  sets: number;
  /** The column-major matrix last set outside a camera listener. */
  matrix: number[];
  /** ADR 0444: the matrix each camera of the last `render` drew it with (its own `matrix` unless a listener set one). */
  drawnWith: number[][];
  /** The sorting layer and order in layer of the last `setOrder` (the layer lights it). */
  sortingLayer: string;
  orderInLayer: number;
  material: string | null;
  blend: QuadBlend;
  tint: [string, number];
  mask: QuadMask | null;
  visible: boolean;
  disposed: boolean;
}

export interface MemoryQuadHostOptions {
  /** The sorting layers places are worked out on; default the current World's `settings.render`. */
  render?: () => YSortSettings;
  /** A texture's authored size; default [64, 32]. */
  size?: readonly [number, number];
  /** Textures start loading and answer null until `load()` (default: loaded at once). */
  loading?: boolean;
}

/** An in-memory quad-batch host and what it holds. */
export function memoryQuadHost(options: MemoryQuadHostOptions = {}) {
  const render = options.render ?? (() => World.require().settings.render);
  const size = options.size ?? [64, 32];
  const batches: MemoryQuadBatch[] = [];
  /** Sorting layers a batch was given that the project doesn't list, once each (as the renderer warns). */
  const unknownLayers: string[] = [];
  let loaded = !options.loading;
  const pending: (() => void)[] = [];
  const listeners = new Set<(camera: readonly [number, number, number]) => void>();
  let inCamera = false;

  const host: QuadBatchHost = {
    createBatch(name) {
      let place = 0;
      let cameraMatrix: number[] | null = null;
      const setGeometry = (texture: string, positions: Float32Array, uvs: Float32Array, indices: Uint32Array, colors: Float32Array | null | undefined, quads: boolean) => {
        Object.assign(b, { texture, positions, uvs, indices, colors: colors ?? null, quads: quads ? indices.length / 6 : 0 });
        b.sets++;
      };
      const b: MemoryQuadBatch & { cameraMatrix(): number[] | null; dropCameraMatrix(): void } = {
        name, texture: "", positions: new Float32Array(0), uvs: new Float32Array(0), indices: new Uint32Array(0), colors: null, quads: 0, sets: 0,
        matrix: [], drawnWith: [], sortingLayer: "", orderInLayer: 0, material: null, blend: "alpha", tint: ["#ffffff", 1], mask: null, visible: false, disposed: false,
        get place() {
          return place;
        },
        setQuads: (texture, positions, uvs, indices, colors) => setGeometry(texture, positions, uvs, indices, colors, true),
        setTriangles: (texture, positions, uvs, indices, colors) => setGeometry(texture, positions, uvs, indices, colors, false),
        setMatrix(m, offset = 0) {
          const matrix = Array.from(m).slice(offset, offset + 16);
          if (inCamera) cameraMatrix = matrix;
          else b.matrix = matrix;
        },
        setOrder(sortingLayer: string, orderInLayer: number, sort?: DrawSort) {
          b.sortingLayer = sortingLayer;
          b.orderInLayer = orderInLayer;
          place = drawPlace(render(), sortingLayer, orderInLayer, sort ?? {}, (l) => void (unknownLayers.includes(l) || unknownLayers.push(l)));
        },
        setMaterial(m) { b.material = m; },
        setTint(c, a) { b.tint = [c, a]; },
        setMask(m) { b.mask = m; },
        setBlend(m) { b.blend = m; },
        setVisible(v) { b.visible = v; },
        dispose() { b.disposed = true; },
        cameraMatrix: () => cameraMatrix,
        dropCameraMatrix: () => void (cameraMatrix = null),
      };
      batches.push(b);
      return b;
    },
    textureSize: (_path, onLoad) => (loaded ? size : (pending.push(onLoad), null)),
    onCameraRender(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    ySorted: (layer) => isYSorted(render(), layer),
  };

  type Held = MemoryQuadBatch & { cameraMatrix(): number[] | null; dropCameraMatrix(): void };
  return {
    host,
    batches,
    unknownLayers,
    /** The batches not disposed. */
    live: () => batches.filter((b) => !b.disposed),
    /** Draw a frame with these cameras (world positions), as the backend does: listeners before each, then back to each batch's own matrix. */
    render(cameras: [number, number, number][]): void {
      for (const b of batches) b.drawnWith = [];
      for (const camera of cameras) {
        inCamera = true;
        for (const listener of listeners) listener(camera);
        inCamera = false;
        for (const b of batches as Held[]) b.drawnWith.push(b.cameraMatrix() ?? b.matrix);
      }
      for (const b of batches as Held[]) b.dropCameraMatrix();
    },
    listeners,
    /** Textures finish loading: `textureSize` answers, and the waiting callbacks run. */
    load(): void {
      loaded = true;
      for (const f of pending.splice(0)) f();
    },
  };
}
