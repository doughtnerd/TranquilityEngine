/**
 * Dynamic meshes (ADR 0396): the renderer core's renderer-neutral way for a plugin's render feature to draw 3D,
 * depth-tested meshes whose vertices it rewrites (line and trail ribbons), with a material asset or a texture. A
 * mesh can carry ribbon data, and then the backend turns each vertex to face the camera drawing it, so one buffer
 * serves every view (split screen, the editor's scene view and its game inset). The backend implements it
 * (`BabylonDynamicMeshes`); the feature decides the geometry. Types only: no backend code here (ADR 0010).
 */

/**
 * Per-vertex data a camera-facing ribbon needs: each vertex's position is its centre-line point, and the backend
 * moves it by `normalize(cross(tangent, toEye)) × halfWidth × side + tangent × halfWidth × along`.
 */
export interface RibbonData {
  /** 4 floats per vertex: the centre line's direction there (xyz, in the mesh's space) and the side (-1 or +1, 0 on the centre line). */
  readonly tangents: Float32Array;
  /** 2 floats per vertex: the half width, and how far along the tangent to move in half widths (caps and round joins). */
  readonly extents: Float32Array;
}

/** A dynamic mesh's geometry. */
export interface DynamicGeometry {
  /** xyz per vertex, in the mesh's space. */
  readonly positions: Float32Array;
  /** uv per vertex (v up). */
  readonly uvs: Float32Array;
  /** RGBA per vertex, 0..1 sRGB and alpha (multiplying the material's colour), or null for white. */
  readonly colors: Float32Array | null;
  /** Three per triangle. */
  readonly indices: Uint32Array;
  /** xyz per vertex: the normals, for a mesh without ribbon data. */
  readonly normals?: Float32Array | null;
  /** Ribbon data: the backend turns each vertex to the camera (normals then face it too). */
  readonly ribbon?: RibbonData | null;
}

/** @internal What a render feature borrows from the renderer to draw dynamic meshes (ADR 0396). */
export interface DynamicMeshHost {
  /** A new, empty, hidden mesh. `name` is for debugging. */
  createMesh(name: string): DynamicMesh;
}

/** @internal One dynamic mesh: one draw. */
export interface DynamicMesh {
  /**
   * Replace the geometry. With the same vertex count, the same `indices` array and the same kinds of data, the
   * buffers are updated in place (a line that moves every frame doesn't reallocate).
   */
  setGeometry(geometry: DynamicGeometry): void;
  /** Its material: a material asset or shader graph, or "" for the built-in line material showing `texture` ("" for none). */
  setLook(material: string, texture: string): void;
  /** The column-major 4×4 mesh-to-world matrix at `offset` (identity for world-space geometry). */
  setMatrix(m: ArrayLike<number>, offset?: number): void;
  /** Whether it casts shadows (the renderer collects it with the casters) and receives them. */
  setShadows(cast: boolean, receive: boolean): void;
  setVisible(visible: boolean): void;
  /** Whether its material and texture have loaded. */
  loaded(): boolean;
  dispose(): void;
}
