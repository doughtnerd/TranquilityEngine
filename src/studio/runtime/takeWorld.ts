// The World-side pieces of take replay (ADR 0334 "Replay": "builds a headless World with the listener and emitters"):
// a listener entity in the Studio's audio-only World, made through the public API (`GameObject.create`, an
// `AudioListener`, its `Transform`), placed at the recorded listener pose each frame. Emitters need no entities: replay
// plays them as positioned instances (`Audio.play(path, { position })`) and moves their handles' `position`.
//
// The seed: the public API has no way to restart a running World's pick generator from a seed (the playlist runtime reads
// `audio.seed` from the project's settings when it changes), so `seed` answers false and replay says picks may differ.
// The public classes, from the modules `myco` re-exports them from (the `myco` barrel would also start every game plugin).
import { GameObject, Quaternion } from "../../engine";
import { AudioListener } from "../../plugins/audio/runtime";
import type { ReplayPose, ReplayWorld } from "./takeReplay";

export function studioReplayWorld(): ReplayWorld {
  let node: GameObject | null = null;
  let failed = false;
  const ears = (): GameObject | null => {
    if (node?.isValid) return node;
    if (failed) return null;
    try {
      node = GameObject.create("Take listener");
      node.addComponent(AudioListener);
      return node;
    } catch {
      failed = true; // no World (the runtime isn't up): the engine's default listener stays
      return null;
    }
  };
  return {
    listener(pose: ReplayPose) {
      const n = ears();
      const t = n?.transform;
      if (!t) return;
      t.position = [pose.position.x, pose.position.y, pose.position.z];
      if (pose.forward) t.rotation = Quaternion.lookRotationSafe([pose.forward.x, pose.forward.y, pose.forward.z]);
    },
    seed: () => false,
    dispose() {
      if (node?.isValid) GameObject.destroy(node);
      node = null;
    },
  };
}
