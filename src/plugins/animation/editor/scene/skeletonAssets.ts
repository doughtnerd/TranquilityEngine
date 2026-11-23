// Skeleton assets as the editor reads them (ADR 0371, 0373; T18): a Skeleton's bone names, parents and rest pose for the
// Hierarchy's bone rows, the bone Inspector and the bone gizmo, read on the host with the runtime's own reader
// (`runtime/assetInfo.ts`) without a World or the core. Loads start on first ask and bump a signal, so views reading
// `skeletonInfoIfLoaded` render again when one arrives. A reference that isn't a `myco.skel@1` file answers null: model
// sub-assets (`model.glb#Skeleton`) are read once the importer (T14) makes them files the asset sources serve.
import { signal } from "@preact/signals";
import { Assets, fetchAssetBytes, normalizeAssetPath } from "../../../../engine/scene/Assets";
import { readSkeletonInfo, type SkeletonInfo } from "../../runtime/assetInfo";

interface Entry {
  readonly url: string;
  info: SkeletonInfo | null;
  readonly loading: Promise<SkeletonInfo | null>;
}

const cache = new Map<string, Entry>();
const version = signal(0);

/** The entry for `ref`, its load started on first ask; null when the asset sources don't have it. */
function entryFor(reference: string): Entry | null {
  const ref = normalizeAssetPath(reference); // fields hold project paths, scene files `asset:` references
  let url: string;
  try {
    if (!ref || !Assets.has(ref)) return null;
    url = Assets.url(ref);
  } catch {
    return null;
  }
  const have = cache.get(ref);
  if (have && have.url === url) return have;
  const loading = fetchAssetBytes(url).then(readSkeletonInfo, () => null);
  const entry: Entry = { url, info: null, loading };
  cache.set(ref, entry);
  void loading.then((info) => {
    if (cache.get(ref) !== entry || !info) return;
    entry.info = info;
    version.value++;
  });
  return entry;
}

/**
 * The skeleton asset `ref` (`asset:rigs/hero.skel`, or a project path) if it has loaded, else null (its load starts here;
 * null too for a missing file or one that isn't a skeleton). Reads a signal, so a view re-renders when it loads.
 */
export function skeletonInfoIfLoaded(ref: string): SkeletonInfo | null {
  version.value;
  return entryFor(ref)?.info ?? null;
}

/** The skeleton asset `ref`, waiting for it to load; null when it can't (missing, not a skeleton). */
export function loadSkeletonInfo(ref: string): Promise<SkeletonInfo | null> {
  return entryFor(ref)?.loading ?? Promise.resolve(null);
}
