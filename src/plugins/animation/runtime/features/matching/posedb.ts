// Pose databases at run time (ADR 0371, 0372; T42t, D79). A graph's pose-database node names a source,
// `*.posedb.json` (`myco.posedb-source@1`), which the editor's bake (T55, `posedb_bake` in the editor module; the
// runtime module has no bake) turns into `*.posedb.bin` (`myco.posedb@1`) **beside it**, as exports compile clips
// beside their sources. At run time the baked file is loaded (`posedb_load`) and each of its clips is bound
// (`posedb_bind`) to that clip loaded for the graph's skeleton (`../clipSources.ts`: the build's compiled clip, the
// editor's, else its raw form). A source with no baked file beside it plays as nothing, with one warning; a reference
// to a `*.posedb.bin` loads as it is.
import { Assets, normalizeAssetPath } from "../../../../../engine/scene/Assets";
import type { AnimationWorldCore } from "../../core/AnimationWorldCore";
import { resolveClip, type AnimatorSkeleton } from "../clipSources";

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** The most clips a database lists (`CLIPS` entries; `posedb_clip` answers "" past the last). */
const MAX_CLIPS = 4096;

/** The baked file a pose-database reference loads: the `*.posedb.bin` beside a source, or the reference itself. */
function bakedPoseDatabasePath(ref: string): string {
  const path = normalizeAssetPath(normalizeAssetPath(ref));
  return /\.posedb\.json$/i.test(path) ? path.replace(/\.posedb\.json$/i, ".posedb.bin") : path;
}

/**
 * @internal One reference to the pose database `ref` loaded into `ns` with its clips bound for `skeleton` (null: no
 * bones); every handle taken goes to `held`. Resolves to the database's handle, or 0 (one warning) when there is no
 * baked file or the core refused it.
 */
export async function acquirePoseDatabase(ns: AnimationWorldCore, ref: string, skeleton: AnimatorSkeleton | null, held: number[]): Promise<number> {
  const path = bakedPoseDatabasePath(ref);
  if (!Assets.has(path)) {
    warnOnce(`posedb:${path}`, `[myco] animation: the pose database "${ref}" has no baked file ("${path}"); bake it in the editor's Pose Database tool. Its node plays nothing.`);
    return 0;
  }
  const db = await ns.acquireFile(path, "posedb");
  if (!db) {
    warnOnce(`posedb-refused:${path}`, `[myco] animation: the core refused the pose database "${path}" (status ${ns.core.lastStatus()}).`);
    return 0;
  }
  held.push(db);
  const refs: string[] = [];
  for (let i = 0; i < MAX_CLIPS; i++) {
    const clip = ns.core.poseDbClip(db, i);
    if (!clip) break;
    refs.push(clip);
  }
  await Promise.all(
    refs.map(async (clipRef, i) => {
      const resolved = await resolveClip(normalizeAssetPath(clipRef), skeleton);
      if (!ns.open) return;
      const handle = !resolved ? 0 : "path" in resolved ? await ns.acquireFile(resolved.path, "clip") : ns.acquire(resolved.key, "clip", { kind: "clip", bytes: resolved.bytes });
      if (!handle) {
        warnOnce(`posedb-clip:${path}:${clipRef}`, `[myco] animation: the pose database "${path}" lists the clip "${clipRef}", which couldn't be loaded; its frames are never picked.`);
        return;
      }
      held.push(handle);
      ns.core.bindPoseDb(db, i, handle);
    }),
  );
  return db;
}
