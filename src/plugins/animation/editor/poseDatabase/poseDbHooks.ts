// What the pose database views read of the project beside the source file (T55): a clip's length, the skeleton's bone names
// and the baked file's summary. Each is read asynchronously (the clip source and skeleton through the runtime's own loaders,
// the baked file through `Assets`), starts on first ask and answers null until it arrives or when it can't be read.
import { useEffect, useState } from "preact/hooks";
import { Assets, normalizeAssetPath } from "../../../../engine/scene/Assets";
import { readSkeletonInfo } from "../../runtime/assetInfo";
import { loadClipSource, loadSkeletonBytes } from "../../runtime/features/clipSources";
import { readPoseDbSummary, type PoseDbSummary } from "./summaryLogic";

/** `load()` once per `key` (and again when `version` changes); null until it resolves, and when it rejects. */
function useLoaded<T>(key: string, version: unknown, load: () => Promise<T | null>): T | null {
  const [value, setValue] = useState<{ key: string; version: unknown; value: T | null } | null>(null);
  useEffect(() => {
    let live = true;
    void load().then(
      (v) => live && setValue({ key, version, value: v }),
      () => live && setValue({ key, version, value: null }),
    );
    return () => {
      live = false;
    };
  }, [key, version]);
  return value && value.key === key && value.version === version ? value.value : null;
}

/** A clip's length in seconds (0 when it can't be read). */
export function useClipDuration(clip: string, version: unknown): number {
  return useLoaded(clip, version, async () => (await loadClipSource(clip))?.source.duration ?? null) ?? 0;
}

/** The bone names of the skeleton `ref` (null: none named, or it can't be read). */
export function useSkeletonBones(ref: string | null, version: unknown): readonly string[] | null {
  return useLoaded(ref ?? "", version, async () => {
    if (!ref) return null;
    const bytes = await loadSkeletonBytes(ref);
    return (bytes && readSkeletonInfo(bytes)?.names) || null;
  });
}

/** The skeleton a bake would use when the source names none: the first clip's own (a model clip's model). */
export function useClipSkeleton(clip: string | null, version: unknown): string | null {
  return useLoaded(clip ?? "", version, async () => (clip ? ((await loadClipSource(clip))?.ownSkeleton ?? null) : null));
}

/** The summary of the baked file at `path` (null: none there, or it doesn't parse). `version` changes when files do. */
export function useBakedSummary(path: string, version: unknown): PoseDbSummary | null {
  return useLoaded(path, version, async () => {
    const p = normalizeAssetPath(path);
    return Assets.has(p) ? readPoseDbSummary(await Assets.bytes(p)) : null;
  });
}
