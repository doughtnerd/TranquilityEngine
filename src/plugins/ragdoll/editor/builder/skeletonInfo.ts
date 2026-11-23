// The skeleton files the ragdoll builder reads (T55): a Skeleton's bone names and rest pose, loaded on first ask through the
// animation plugin's public module and cached; a signal bumps when one arrives, so views reading `skeletonInfoIfLoaded` draw
// again. A reference that can't be read answers null.
import { signal } from "@preact/signals";
import { loadSkeletonBytes, readSkeletonInfo, type SkeletonInfo } from "../../../animation/runtime";

const cache = new Map<string, SkeletonInfo | null | "loading">();
const version = signal(0);

/** The skeleton `ref` if it has loaded, else null (its load starts here). Reads a signal. */
export function skeletonInfoIfLoaded(ref: string): SkeletonInfo | null {
  version.value;
  if (!ref) return null;
  const have = cache.get(ref);
  if (have === undefined) {
    cache.set(ref, "loading");
    void loadSkeletonBytes(ref).then(
      (bytes) => cache.set(ref, bytes ? readSkeletonInfo(bytes) : null),
      () => cache.set(ref, null),
    ).then(() => void version.value++);
  }
  return have === undefined || have === "loading" ? null : have;
}
