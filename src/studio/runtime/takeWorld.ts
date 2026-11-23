// The World-side pieces of take replay (ADR 0348 "Replay": "builds a headless World with the listener and emitters"):
// a listener entity in the Studio's audio-only World, made through the public API (`GameObject.create`, an
// `AudioListener`, its `Transform`), placed at the recorded listener pose each frame. Emitters need no entities: replay
// plays them as positioned instances (`Audio.play(path, { position })`) and moves their handles' `position`.
//
// The seed: the take's recorded pick generator state restarts the Studio World's generator (the audio runtime's internal
// `reseedActiveWorld`, `capture/takeSeed.ts`); it answers false only while the Studio has no World.
// The public classes, from the modules `myco` re-exports them from (the `myco` barrel would also start every game plugin).
import { GameObject, Quaternion } from "../../engine";
import { AudioListener } from "../../plugins/audio/runtime";
import { reseedActiveWorld } from "../../plugins/audio/runtime/capture/takeSeed";
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
    seed: (state) => reseedActiveWorld(state),
    dispose() {
      if (node?.isValid) GameObject.destroy(node);
      node = null;
    },
  };
}
