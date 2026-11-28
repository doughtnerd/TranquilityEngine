/**
 * A model mesh with its generated levels (ADR 0459 §1): the generator's arrays turned back into `ModelMesh`es, and a
 * mesh's streams handed to the generator. Both a fresh import (`models.ts`) and a baked file (`bakedModel.ts`) build
 * their levels here, so the two give the same shapes. Internal: not public API.
 *
 * LOD0 becomes the welded, reordered mesh; each further level is a derived `ModelMesh` with LOD0's surfaces, skin and
 * morph targets and a `data` that shares LOD0's vertex arrays with its own `indices` and `groups`. The level objects are
 * made once per model load, so their identity is stable for the model's lifetime.
 */
import type { MeshData, ModelMesh } from "../models";
import type { MeshSkin, MorphTargetData } from "../../animation/import/skeleton";
import type { Bounds6, ModelLodLevel, ModelLods, OccluderStandIn } from "./types";
import type { GeneratedLods, LodGroup, LodSource } from "./generate";
import type { VertexStreams } from "./streams";

/** A mesh's streams and indices as the generator takes them. */
export function lodSourceOf(mesh: ModelMesh): LodSource {
  const d = mesh.data;
  const streams: VertexStreams = {
    positions: d.positions,
    normals: d.normals,
    uvs: d.uvs,
    uvs2: d.uvs2 ?? null,
    colors: d.colors ?? null,
    tangents: mesh.tangents ?? null,
    joints: mesh.skin?.joints ?? null,
    weights: mesh.skin?.weights ?? null,
    influences: mesh.skin?.influences ?? 0,
    morphs: (mesh.morphTargets ?? []).map((t) => ({ positions: t.positions, normals: t.normals, tangents: t.tangents ?? null })),
  };
  return { streams, indices: d.indices, groups: d.groups };
}

/** The levels a mesh keeps beyond its streams: what a baked file stores per mesh. */
export interface StoredLods {
  /** Levels 1… (LOD0 is the mesh's own `data`). */
  readonly levels: readonly { readonly indices: Uint32Array; readonly groups: readonly LodGroup[]; readonly error: number; readonly triangles: number }[];
  /** The hole-trimmed stand-in with its per-triangle errors and neighbours (ADR 0460 §3). */
  readonly occluder: OccluderStandIn | null;
  readonly bounds: Bounds6;
  readonly pixelError: number;
}

/** `mesh` (already holding the welded, reordered streams as LOD0) with its levels attached. */
export function attachLods(mesh: ModelMesh, stored: StoredLods): ModelMesh {
  const lod0 = { ...mesh } as { -readonly [K in keyof ModelMesh]: ModelMesh[K] };
  const derived = (indices: Uint32Array, groups: readonly LodGroup[]): ModelMesh => {
    const { geometry: _geometry, lods: _lods, ...rest } = lod0;
    const data: MeshData = { ...lod0.data, indices, groups };
    return { ...rest, data };
  };
  const levels: ModelLodLevel[] = [{ mesh: lod0, error: 0, triangles: lod0.data.indices.length / 3 }, ...stored.levels.map((l) => ({ mesh: derived(l.indices, l.groups), error: l.error, triangles: l.triangles }))];
  const lods: ModelLods = { levels, occluder: stored.occluder, bounds: stored.bounds, pixelError: stored.pixelError };
  lod0.lods = lods;
  return lod0;
}

/** `mesh` with the generator's output: its streams as LOD0 (skin, morph targets and tangents remapped alike) and the levels. */
export function meshWithLods(mesh: ModelMesh, generated: GeneratedLods, pixelError: number): ModelMesh {
  const s = generated.streams;
  const [lod0, ...rest] = generated.levels;
  const data: MeshData = { positions: s.positions, normals: s.normals, uvs: s.uvs, uvs2: s.uvs2, colors: s.colors, indices: lod0.indices, groups: lod0.groups };
  const skin: MeshSkin | null = mesh.skin && s.joints && s.weights ? { ...mesh.skin, joints: s.joints, weights: s.weights } : null;
  const morphTargets: MorphTargetData[] | undefined = mesh.morphTargets?.map((t, i) => ({ ...t, positions: s.morphs[i].positions, normals: s.morphs[i].normals, ...("tangents" in t ? { tangents: s.morphs[i].tangents } : {}) }));
  const base: ModelMesh = {
    ...mesh,
    data,
    ...(mesh.skin !== undefined ? { skin } : {}),
    ...(morphTargets ? { morphTargets } : {}),
    ...(mesh.tangents !== undefined ? { tangents: s.tangents } : {}),
  };
  return attachLods(base, { levels: rest, occluder: generated.occluder, bounds: generated.bounds, pixelError });
}
