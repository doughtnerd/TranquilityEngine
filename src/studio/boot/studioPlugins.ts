// The Studio's plugins (ADR 0327): the audio plugin, both halves, and the 3D physics plugin's runtime half with its Rapier
// backend (ADR 0333: "the Studio's runtime loads the 3D physics plugin for occlusion in test scenes"), through a plugin
// set as every host applies its plugins (ADR 0144). The audio runtime half gives the Studio's Engine the audio system
// and the `myco.audio` service; the physics halves give its World colliders and the `myco.physics3d` service the
// occlusion pass casts its rays through, started when a test scene's obstacles or its base scene's colliders need it
// (Rapier loads then, not at boot). The audio editor half registers the audio asset kinds. Nothing else is activated
// (no renderer, no other plugin's systems or Components), so the Studio never loads the scene editor's plugins.
import { audioEditorPlugin } from "../../plugins/audio/editor";
import { audioRuntimePlugin } from "../../plugins/audio/runtime";
import { editorActivator } from "../../plugins/editorActivator";
import { physicsRuntimePlugin } from "../../plugins/physics/runtime";
import { physicsRapierRuntimePlugin } from "../../plugins/physics-rapier/runtime";
import { createPluginSet } from "../../plugins/pluginSet";
import { runtimeActivator } from "../../plugins/runtimeContext";

const studioPlugins = createPluginSet({ runtime: runtimeActivator, editor: editorActivator });

/** Activate the Studio's plugins; returns the problems, if any (each already worded for the user). */
export function activateStudioPlugins(): string[] {
  const result = studioPlugins.apply({
    plugins: [
      { manifest: physicsRuntimePlugin.manifest, runtime: physicsRuntimePlugin },
      { manifest: physicsRapierRuntimePlugin.manifest, runtime: physicsRapierRuntimePlugin },
      { manifest: audioRuntimePlugin.manifest, runtime: audioRuntimePlugin, editor: audioEditorPlugin },
    ],
    host: { editor: true },
  });
  return result.problems.map((p) => p.message);
}
