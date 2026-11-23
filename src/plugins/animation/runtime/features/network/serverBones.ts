// Server Worlds compute bone matrices only for the bones gameplay reads (ADR 0370 "Networking"; T70, closing T33's
// note): a skeleton a BoneAttachment follows (a hit volume, a socket) keeps its pose on the server (`ghosts.ts`'s
// `gameplayOnly`), and of that pose only the followed bones and their ancestors get model-space and skinning matrices
// (the core's eval mask, `AnimationCore.setEvalMask`); the other rows are never written there. Clients and offline
// Worlds compute every bone. Sampling and the graph still run for the whole skeleton (the mask only skips the matrix
// pass); a decode that skips unmasked bones is a later optimisation.
//
// The mask is a core mask asset (one weight per bone: 1 for a followed bone), acquired per (skeleton, bone set) and
// re-set when the followed set or the instance changes.
import { netSession } from "../../../../../engine/net/session";
import { followedBones } from "../attachments/follow";
import type { AnimatorRuntime } from "../instances";

interface Applied {
  readonly instance: number;
  readonly key: string;
  readonly handle: number;
}

const applied = new WeakMap<AnimatorRuntime, Applied>();

/** @internal Before `rt`'s evaluate: its eval mask is the followed bones on a server, every bone elsewhere. */
export function syncServerBones(rt: AnimatorRuntime): void {
  const ns = rt.ns;
  if (!ns?.open || !rt.instance) return;
  const s = rt.skeleton;
  const info = s?.info ?? null;
  const bones = s && info && netSession(rt.world)?.isServer ? followedBones(rt.world, s) : [];
  const key = bones.length && info ? `${s!.path}\u0000${info.bones}\u0000${bones.join(",")}` : "";
  const was = applied.get(rt);
  if (was ? was.instance === rt.instance && was.key === key : key === "") return;
  if (was?.handle) ns.release(was.handle);
  let handle = 0;
  if (key && info) {
    const weights = new Float32Array(info.bones);
    for (const b of bones) weights[b] = 1;
    handle = ns.acquire(`evalMask:${key}`, "mask", { kind: "mask", weights });
  }
  ns.core.setEvalMask(rt.instance, handle);
  applied.set(rt, { instance: rt.instance, key, handle });
}
