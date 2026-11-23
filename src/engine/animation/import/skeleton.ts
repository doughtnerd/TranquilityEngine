/**
 * The imported skeleton model (ADR 0371 "Assets": `model.glb#Skeleton`): what the import hands the compile pipeline
 * (T19, which writes `myco.skel@1`) and the ECS integration (T17). Bones are **parents first** (a parent's index is
 * below its children's, as `myco.skel@1` and the core's `local_to_model` require); a file whose joints aren't in that
 * order is reordered by `orderParentsFirst`, and every index into it remapped.
 *
 * - `rest`: each bone's local pose in the engine's left-handed model space (`space.ts`), with the import `scale` in
 *   translations;
 * - `inverseBinds`: 12 floats per bone, the core's row-major 3×4 bone matrix layout (D10), mapping a baked vertex
 *   (model space) into the bone's space at bind time; a mesh whose bind differs from the skeleton's for some bone
 *   carries its own (`MeshSkin.inverseBinds`);
 * - `roles`: the skeleton profile role of each bone, or null, from the model sidecar's `boneMap` (written, or guessed on
 *   import by the core's `guess_bone_map`).
 *
 * Pure. Internal: not public API.
 */
import type { NodePose } from "../../scene/models";

/** @internal One bone. */
export interface ImportedBone {
  /** Unique within the skeleton. */
  readonly name: string;
  /** The parent bone's index (always below this bone's), or -1 for a root. */
  readonly parent: number;
  /** The rest (bind-time node) pose, local to the parent bone, engine space. */
  readonly rest: NodePose;
}

/** @internal An imported skeleton (see the module comment). */
export interface ImportedSkeleton {
  readonly bones: readonly ImportedBone[];
  /** 12 floats per bone (row-major 3×4, D10). */
  readonly inverseBinds: Float32Array;
  /** A profile role name per bone, or null. */
  readonly roles: readonly (string | null)[];
  /** The skeleton profile the roles belong to (a `*.skelprofile.json` reference), or null for the built-in Humanoid. */
  readonly profile: string | null;
}

/**
 * @internal A mesh's skin (ADR 0371), the shape T16's skinning reads (`render/skinning/skinData.ts` `MeshSkin`, which
 * this matches field for field): per vertex, `influences` joint indices into the **skeleton's** bones and their weights.
 */
export interface MeshSkin {
  /** Influences per vertex: 4 or 8. */
  readonly influences: 4 | 8;
  /** Per vertex × influences: a skeleton bone index. */
  readonly joints: Uint16Array;
  /** Per vertex × influences, each vertex's summing to 1, largest first. */
  readonly weights: Float32Array;
  /**
   * Extension beyond T16's type: 12 floats per skeleton bone (row-major 3×4), present only when this mesh's bind
   * differs from the skeleton's `inverseBinds` for some bone it uses (a mesh bound at another pose); null otherwise.
   */
  readonly inverseBinds?: Float32Array | null;
}

/** @internal One morph target (ADR 0371), T16's `MorphTargetData` shape: deltas from the base shape, in the baked mesh's space. */
export interface MorphTargetData {
  /** Unique within the mesh (a morph track's `field`). */
  readonly name: string;
  /** x, y, z per vertex, or null. */
  readonly positions: Float32Array | null;
  /** x, y, z per vertex, or null. */
  readonly normals: Float32Array | null;
  /** Extension beyond T16's type: x, y, z per vertex (glTF `TANGENT` targets), or null. */
  readonly tangents?: Float32Array | null;
}


/**
 * @internal The order putting every parent before its children (`order[newIndex] = oldIndex`), keeping the file's order
 * where it already does, and the old-to-new remap. A cycle (which no valid file has) is broken by treating the bone met
 * again as a root.
 */
export function orderParentsFirst(parents: readonly number[]): { order: number[]; remap: number[]; reordered: boolean } {
  const n = parents.length;
  const remap = new Array<number>(n).fill(-1);
  const order: number[] = [];
  const visiting = new Set<number>();
  const place = (i: number) => {
    if (remap[i] >= 0) return;
    if (visiting.has(i)) return; // a cycle: the caller's parent becomes -1 below
    visiting.add(i);
    const p = parents[i];
    if (p >= 0 && p < n) place(p);
    remap[i] = order.length;
    order.push(i);
  };
  for (let i = 0; i < n; i++) place(i);
  return { order, remap, reordered: order.some((o, i) => o !== i) };
}

/**
 * @internal Bones given in any order (each `parent` an index into `bones` or -1) as a skeleton's parents-first list, and
 * the old-to-new remap; `inverseBinds` (12 floats per bone in the given order) are moved with them.
 */
export function parentsFirstSkeleton(bones: readonly ImportedBone[], inverseBinds: Float32Array): { bones: ImportedBone[]; inverseBinds: Float32Array; remap: number[] } {
  const { order, remap } = orderParentsFirst(bones.map((b) => b.parent));
  const out = order.map((old): ImportedBone => {
    const b = bones[old];
    const parent = b.parent >= 0 && b.parent < bones.length ? remap[b.parent] : -1;
    return { ...b, parent: parent < remap[old] ? parent : -1 };
  });
  const binds = new Float32Array(order.length * 12);
  order.forEach((old, i) => binds.set(inverseBinds.subarray(old * 12, old * 12 + 12), i * 12));
  return { bones: out, inverseBinds: binds, remap };
}

/** @internal Each bone's role from a bone map (role → bone name); roles naming a bone the skeleton lacks are listed in `missing`. */
export function rolesFromBoneMap(bones: readonly ImportedBone[], boneMap: Readonly<Record<string, string>>): { roles: (string | null)[]; missing: string[] } {
  const roles = bones.map((): string | null => null);
  const missing: string[] = [];
  const index = new Map(bones.map((b, i) => [b.name, i]));
  for (const [role, bone] of Object.entries(boneMap)) {
    const i = index.get(bone);
    if (i === undefined) missing.push(role);
    else if (roles[i] === null) roles[i] = role;
  }
  return { roles, missing };
}
