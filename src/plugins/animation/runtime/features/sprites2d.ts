// 2D bones (ADR 0371, 0372; T21): what a Skeleton2D's lifecycle does. It is a skeleton like `Skeleton` (`instances.ts`
// `skeletonHooksFor`), so the Animator on its node or above binds to it, makes a core instance for it and plays bone
// tracks on it as in 3D. Its bones come from the image slice its `bones` field names: the slice's sidecar `skin.bones`
// (`sprites2d/skins.ts`) written on the host as a `myco.skel@1` skeleton in the slice's units (`skeleton2d.ts`) and
// loaded under a key naming the slice and what it was made from (so an edited sidecar loads anew on the next
// activation). Slices that share the skeleton bind to its bones by name when drawn (`sprites2d/skinnedSprites.ts`).
import { skeleton2DBytes } from "../../../../engine/animation/sprites/skeleton2d";
import { readSkeletonInfo } from "../assetInfo";
import type { Skeleton2D } from "../components/Skeleton2D";
import type { LifecycleHooks } from "../lifecycle";
import { skeletonHooksFor } from "./instances";
import { sliceSkin } from "./sprites2d/skins";

const warned = new Set<string>();

/** @internal A Skeleton2D's lifecycle: its skeleton made from the named slice's skin while used. */
export const skeleton2DHooks: LifecycleHooks<Skeleton2D> = skeletonHooksFor<Skeleton2D>({
  key: (c) => c.bones,
  acquire: async (ns, ref, c) => {
    const s = sliceSkin(ref, c.node.world.settings.render.pixelsPerUnit);
    if (!s || !s.skin.bones.length) {
      const why = `${c.node.name}: Skeleton2D's "${ref}" has no skin bones (the slice's "skin" in its image's .meta.json)`;
      if (!warned.has(why)) {
        warned.add(why);
        console.warn(`[myco] ${why}.`);
      }
      return { handle: 0, info: null };
    }
    const bytes = skeleton2DBytes(s.skin.bones, s.frame, ref);
    const key = `skeleton2d:${ref}:${s.frame.pivot.join(",")}:${s.frame.pixelsPerUnit}:${JSON.stringify(s.skin.bones)}`;
    return { handle: ns.acquire(key, "skeleton", { kind: "skeleton", bytes }), info: readSkeletonInfo(bytes) };
  },
});
