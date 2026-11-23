/**
 * A 2D skeleton (ADR 0371, 0372): drives skinned sprites with bone tracks, as `Skeleton` does in 3D. Its bones come from
 * an image slice's sidecar `skin`; several slices can share one 2D skeleton (a cut-out character).
 */
import { Component } from "../../../../engine/core/Component";
import { AssetRef, component, field } from "../../../../engine/core/registry";
import { skeleton2DHooks } from "../features/sprites2d";

@component("engine.Skeleton2D")
export class Skeleton2D extends Component {
  /** The image slice whose sidecar `skin` declares the bones (`asset:hero.png#torso`). */
  @field(AssetRef, { kind: "sprite", animatable: false, description: "The image slice whose skin declares the bones." })
  bones = "";

  override _onAttach(): void {
    skeleton2DHooks.attach?.(this);
  }

  override _onActivate(): void {
    skeleton2DHooks.activate?.(this);
  }

  override _onDeactivate(): void {
    skeleton2DHooks.deactivate?.(this);
  }

  override _onDetach(): void {
    skeleton2DHooks.detach?.(this);
  }
}
