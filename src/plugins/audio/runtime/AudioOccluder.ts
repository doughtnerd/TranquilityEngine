/**
 * A wall for sound (ADR 0162 M3, api-and-models §1.5, R15). An `AudioOccluder` gives the colliders of its node, and of
 * descendants without an occluder of their own, an acoustic material: a ray the audio occlusion pass casts between a
 * source and the listener that hits one of them is muffled by the material (plus this wall's trims). It exists in the
 * editor World and in play and needs no physics to exist; without a 3D physics service it simply has nothing to act on.
 * A door is an occluder on the door's collider with a script moving `openness` (R15).
 */
import { Component } from "../../../engine/core/Component";
import { component, field } from "../../../engine/core/registry";
import type { GameObject } from "../../../engine/scene/GameObject";

@component("engine.AudioOccluder")
export class AudioOccluder extends Component {
  @field(String, { choices: (s) => ["", ...s.audio.occlusion.materials.map((m) => m.name)], description: "Material from Project Settings > Audio. Empty is the project's default material." }) material = "";
  @field(Number, { description: "Extra transmission loss for this wall, dB (negative muffles more), added to the material's." }) transmissionTrimDb = 0;
  @field(Number, { description: "Multiplies the material's low-pass cutoff (below 1 duller)." }) cutoffScale = 1;
  @field(Number, { description: "0 closed, 1 open: blends the wall's effect away. Script it for a door (R15)." }) openness = 0;
}

/**
 * @internal The occluder that applies to a collider on `node`: the nearest enabled one on the node or an ancestor
 * (the `Collider.attachedRigidbody` pattern), or null. A disabled occluder is skipped and the search goes on up.
 * No allocation.
 */
export function nearestOccluder(node: GameObject): AudioOccluder | null {
  for (let n: GameObject | null = node; n; n = n.parent) {
    const o = n.getBehavior(AudioOccluder);
    if (o && o.isActiveAndEnabled) return o;
  }
  return null;
}
