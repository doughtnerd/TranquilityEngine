/**
 * A node that follows a bone (ADR 0372): for weapons, props and hit volumes. After transform propagation it takes the
 * bone's model-space transform times the skeleton node's world matrix, plus the offset (ADR 0370's frame order, step 7).
 * Fields only: there is nothing to call.
 */
import { Component } from "../../../../engine/core/Component";
import { Quaternion, Vector3 } from "../../../../engine/core/math";
import { component, field } from "../../../../engine/core/registry";
import { GameObject } from "../../../../engine/scene/GameObject";
import { boneAttachmentHooks } from "../features/instances";
import type { BoneAttachmentFollow } from "../types";

@component("engine.BoneAttachment")
export class BoneAttachment extends Component {
  /** The node with the `Skeleton`. Null: the nearest ancestor with one. */
  @field(GameObject, { animatable: false, description: "The node whose Skeleton has the bone. Empty: the nearest ancestor with one." })
  skeleton: GameObject | null = null;
  /** The bone's name in the skeleton. */
  @field(String, { description: "The bone to follow." })
  bone = "";
  /** Position offset in the bone's space. */
  @field(Vector3, { description: "Position offset in the bone's space." })
  offsetPosition = new Vector3(0, 0, 0);
  /** Rotation offset in the bone's space. */
  @field(Quaternion, { description: "Rotation offset in the bone's space." })
  offsetRotation = Quaternion.identity;
  /** What it copies from the bone: position, rotation or both. */
  @field(String, { choices: ["position", "rotation", "both"], description: "What it copies from the bone." })
  follow: BoneAttachmentFollow = "both";

  override _onAttach(): void {
    boneAttachmentHooks.attach?.(this);
  }

  override _onActivate(): void {
    boneAttachmentHooks.activate?.(this);
  }

  override _onDeactivate(): void {
    boneAttachmentHooks.deactivate?.(this);
  }

  override _onDetach(): void {
    boneAttachmentHooks.detach?.(this);
  }
}
