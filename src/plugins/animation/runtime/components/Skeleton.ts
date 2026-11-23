/**
 * A skeleton (ADR 0372), on a rig's root node. Bones aren't nodes: the pose lives in the core (ADR 0370), and
 * `SkinnedMeshRenderer`s and `BoneAttachment`s name this node to use it.
 */
import { Component } from "../../../../engine/core/Component";
import { AssetRef, component, field } from "../../../../engine/core/registry";
import { skeletonHooks } from "../features/instances";

@component("engine.Skeleton")
export class Skeleton extends Component {
  /** The skeleton asset: bones, parents, rest pose and inverse bind matrices (`asset:hero.glb#Skeleton`). */
  @field(AssetRef, { kind: "skeleton", animatable: false, description: "The skeleton: bones, parents, rest pose and bind matrices." })
  skeleton = "";
  /** The skeleton profile (`*.skelprofile.json`) mapping bone roles and chains, for retargeting, masks, mirroring and IK. Empty: the import's. */
  @field(AssetRef, { kind: "skelprofile", animatable: false, description: "The skeleton profile mapping bone roles and chains. Empty: the import's." })
  profile = "";
  /**
   * The skeleton or profile that clips made for another rig were authored on, for runtime retargeting (ADR 0372). Empty:
   * clips play on this skeleton directly.
   */
  @field(AssetRef, { kind: ["skeleton", "skelprofile"], animatable: false, description: "Where clips authored for another rig come from, for retargeting. Empty: none." })
  retargetSource = "";

  /** @internal Loads its bones in a scene being edited too, so an editor preview can pose them (ADR 0026, D135). */
  override get _activatesInEditMode(): boolean {
    return true;
  }

  override _onAttach(): void {
    skeletonHooks.attach?.(this);
  }

  override _onActivate(): void {
    skeletonHooks.activate?.(this);
  }

  override _onDeactivate(): void {
    skeletonHooks.deactivate?.(this);
  }

  override _onDetach(): void {
    skeletonHooks.detach?.(this);
  }
}
