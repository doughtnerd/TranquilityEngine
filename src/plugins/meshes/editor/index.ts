// The Meshes and models plugin's editor half (ADR 0140): the `model` asset kind (OBJ, FBX, glTF):
// its label, icon and rendered preview, the MeshRenderer fields that take it, and what adding one to a
// scene makes (the model's node tree, once its meshes have loaded), and its import settings (scale,
// up axis, normals, pivots, material slots), which the shell's import Inspector shows (ADR 0040, 0143);
// and the choices of MeshRenderer's `variant` field (ADR 0118, 0152).
// Both the model kind and the `.mtl` kind name the files they use in their own formats (ADR 0148).
import { loadModel } from "../../../engine/scene/models";
import { materialLibraryReferences, modelReferences } from "./modelReferences";
import { disabledCamerasNote, modelNodeEntries } from "./modelNodes";
import { LargePreview, type EditorPlugin } from "../../../editor/sdk";
import { meshesManifest } from "../manifest";
import type { ComponentInfo } from "../../../engine/editor";

/** A file with a swatch: an .obj's material library. */
const MTL_ICON = "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6v5h-6z";
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
        note: (_path, entries) => disabledCamerasNote(entries),
      },
      importSettings: {
        preview: async () => LargePreview,
        view: () => import("./ModelImportSettings").then((m) => m.ModelImportSettings),
      },
      references: modelReferences,
    });
    // MeshRenderer.variant (ADR 0118, 0152): a dropdown of the model's material variants, hidden when it has none.
    context.registerFieldChoices({
      id: "mesh-renderer-variant",
      type: "engine.MeshRenderer",
      field: "variant",
      none: { label: "Default", value: "" },
      key: meshOf,
      async choices(info) {
        const mesh = meshOf(info);
        if (!mesh || mesh.startsWith("builtin:")) return [];
        const { variants = [] } = await loadModel(mesh);
        return variants.map((name) => ({ label: name, value: name }));
      },
    });
    // An .obj's material library: not a model, but it names the model's textures (ADR 0148).
    context.registerAssetKind({ id: "mtl", extensions: [".mtl"], label: "Material Library", icon: MTL_ICON, references: materialLibraryReferences });
  },
};

/** The model a MeshRenderer draws (an asset reference, a `builtin:` mesh, or ""). */
const meshOf = (info: ComponentInfo) => String(info.fields.find((f) => f.name === "mesh")?.value ?? "");
