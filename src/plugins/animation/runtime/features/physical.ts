// Physical animation (ADR 0370 "anim-physics", 0375; T44): the source a ragdoll plugin connects to through
// `PHYSICAL_ANIMATION` (`../ragdoll.ts`), over the core's physics rows (`physics_attach`, `physics_drive`,
// `physics_read`, `physics_capture`). Drives are computed in `animation.FixedEvaluate` (`stages/apply/physical.ts`).
// T01 keeps the connection (clients connect and disconnect); the source's methods are T44's.
import type { Animator } from "../components/Animator";
import { notBuilt } from "../notBuilt";
import type { PhysicalAnimationClient, PhysicalAnimationSource, RagdollBodyPose, RagdollControl, RagdollDescription, RagdollDrives } from "../ragdoll";

const source: PhysicalAnimationSource = {
  attach(_animator: Animator, _ragdoll: RagdollDescription): boolean {
    return notBuilt("PhysicalAnimationSource.attach", "T44");
  },
  detach(_animator: Animator): void {
    notBuilt("PhysicalAnimationSource.detach", "T44");
  },
  control(_animator: Animator, _control: RagdollControl): void {
    notBuilt("PhysicalAnimationSource.control", "T44");
  },
  drives(_animator: Animator): RagdollDrives | null {
    return notBuilt("PhysicalAnimationSource.drives", "T44");
  },
  setPhysicalPose(_animator: Animator, _bodies: readonly RagdollBodyPose[]): void {
    notBuilt("PhysicalAnimationSource.setPhysicalPose", "T44");
  },
  captureSnapshot(_animator: Animator, _physicalNode: string, _snapshotNode: string): boolean {
    return notBuilt("PhysicalAnimationSource.captureSnapshot", "T44");
  },
};

/** Connected clients by id. */
const clients = new Map<string, PhysicalAnimationClient>();

/** @internal True while a ragdoll plugin is connected (the fixed stage computes drives only then). */
export const hasPhysicalClients = (): boolean => clients.size > 0;

/** @internal `PHYSICAL_ANIMATION.register`: connect `client`; the undo disconnects it. A second client with a taken id throws. */
export function registerPhysicalClient(client: PhysicalAnimationClient): () => void {
  if (clients.has(client.id)) throw new Error(`Animation: a physical-animation client "${client.id}" is already connected.`);
  clients.set(client.id, client);
  try {
    client.connect(source);
  } catch (err) {
    clients.delete(client.id);
    throw err;
  }
  return () => {
    if (clients.get(client.id) !== client) return;
    clients.delete(client.id);
    client.disconnect();
  };
}
