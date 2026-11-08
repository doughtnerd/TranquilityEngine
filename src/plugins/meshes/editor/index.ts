// The Meshes and models plugin's editor half (ADR 0140): the `model` asset kind (OBJ, FBX, glTF):
// its label, icon and rendered preview, the MeshRenderer fields that take it, and what adding one to a
// scene makes (the model's node tree, once its meshes have loaded). Its import settings stay in the
// editor shell's import Inspector, shared with images and audio (ADR 0040), which keys on the id `model`.
import { loadModel } from "../../../engine/scene/models";
import { modelNodeEntries } from "../../../editor/assetBrowser";
import type { EditorPlugin } from "../../../editor/sdk";
import { meshesManifest } from "../manifest";

/** A cube in three-quarter view, stroked in a 24×24 box. */
const MODEL_ICON = "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5";

export const meshesEditorPlugin: EditorPlugin = {
  manifest: meshesManifest,
  activate(context) {
    context.registerAssetKind({
      id: "model",
      extensions: [".obj", ".fbx", ".gltf", ".glb"],
      label: "Model",
      icon: MODEL_ICON,
      referencedAs: ["model", "mesh"],
      preview: "model",
      addToScene: {
        prepare: (path) => loadModel(path).then(() => undefined),
        nodes: (doc, path, position) => modelNodeEntries(doc, path, position),
      },
    });
  },
};
