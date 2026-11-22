// The Studio's plugins (ADR 0327): only the audio plugin, both halves, through a plugin set as every host applies its
// plugins (ADR 0144). The runtime half gives the Studio's Engine the audio system and the `myco.audio` service (no
// other plugin's systems, Components or render features); the editor half registers the audio asset kinds. Nothing
// else is activated, so the Studio never loads the scene editor's plugins.
import { audioEditorPlugin } from "../../plugins/audio/editor";
import { audioRuntimePlugin } from "../../plugins/audio/runtime";
import { editorActivator } from "../../plugins/editorActivator";
import { createPluginSet } from "../../plugins/pluginSet";
import { runtimeActivator } from "../../plugins/runtimeContext";

const studioPlugins = createPluginSet({ runtime: runtimeActivator, editor: editorActivator });

/** Activate the audio plugin's halves; returns the problems, if any (each already worded for the user). */
export function activateStudioPlugins(): string[] {
  const result = studioPlugins.apply({ plugins: [{ manifest: audioRuntimePlugin.manifest, runtime: audioRuntimePlugin, editor: audioEditorPlugin }], host: { editor: true } });
  return result.problems.map((p) => p.message);
}
