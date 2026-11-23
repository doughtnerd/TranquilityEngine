// Which part an Animator plays in a networked World (ADR 0033, 0370 "Networking"; T33). An Animator replicates when its
// node has a `net.Replicated` component (its fields replicate with the node, like any behavior's):
//
// - **server:** a ghost the server World drives; it writes its replicated fields each tick (`server.ts`);
// - **interpolated:** a ghost on a client drawn in the past; it takes the replicated state at the interpolation tick
//   (`client.ts`), and its node's transform comes from replication, so the core's root deltas don't move it;
// - **predicted:** the owning client's `"predicted"` ghost; its root-motion one-shots move it on the prediction
//   timeline (`predicted.ts`), and only its slot plays are reconciled with the server's.
//
// Servers also move their own `"predicted"` ghosts with `animation.PredictedRootMotion`, so both ends sample the same
// root curve for the same ticks; for those (and every client ghost) the core's root delta isn't applied as well (D92).
import type { World } from "../../../../../engine/core/World";
import { Replicated } from "../../../../../engine/net/Replicated";
import { netSession, type NetSession } from "../../../../../engine/net/session";
import { isFollowed } from "../attachments/follow";
import type { AnimatorRuntime } from "../instances";

/** @internal An Animator's part in its World's networking. */
export type NetRole = "none" | "server" | "interpolated" | "predicted";

/** @internal The World's network session, when it is a server or a client. */
export function sessionOf(world: World): NetSession | null {
  const s = netSession(world);
  return s && (s.isServer || s.isClient) ? s : null;
}

/** @internal The node's `Replicated` component, or null. */
export function replicatedOf(rt: AnimatorRuntime): Replicated | null {
  return rt.animator.node.getBehavior(Replicated) ?? null;
}

/** @internal `rt`'s part in its World's networking (`session`: the World's, from `sessionOf`). */
export function roleOf(rt: AnimatorRuntime, session: NetSession | null): NetRole {
  if (!session) return "none";
  const rep = replicatedOf(rt);
  if (!rep) return "none";
  if (session.isServer) return "server";
  if (!rep.isGhost) return "none";
  return rep.isPredictedLocally ? "predicted" : "interpolated";
}

/** @internal Whether `animation.PredictedRootMotion` moves `rt`'s node: a server's `"predicted"` ghost, or the owner's. */
export function movedByPredictedRootMotion(rt: AnimatorRuntime, session: NetSession | null): boolean {
  const mode = rt.animator.rootMotion;
  if (mode !== "transform" && mode !== "characterController") return false;
  const role = roleOf(rt, session);
  return role === "predicted" || (role === "server" && replicatedOf(rt)!.mode === "predicted");
}

/**
 * @internal `rootMotionHooks.suppressed`: the core's root delta doesn't move ghosts on clients (replication or
 * predicted root motion does) nor the server's `"predicted"` ghosts (predicted root motion does, on both ends alike).
 */
export function rootMotionSuppressed(rt: AnimatorRuntime): boolean {
  const session = sessionOf(rt.world);
  const role = roleOf(rt, session);
  return role === "interpolated" || role === "predicted" || (role === "server" && replicatedOf(rt)!.mode === "predicted");
}

/**
 * @internal Server Worlds evaluate only what gameplay reads (ADR 0370): root motion, notifies, and the pose only for
 * skeletons a BoneAttachment follows (hit volumes, sockets). Others run as `rootMotionOnly` while not visible: playheads,
 * graphs, root motion and notifies advance, and no pose (skinning matrices) is produced.
 */
export function gameplayOnly(rt: AnimatorRuntime): boolean {
  if (!netSession(rt.world)?.isServer) return false;
  return !rt.skeleton || !isFollowed(rt.world, rt.skeleton);
}
