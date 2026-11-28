// The Lights 2D plugin's editor half (ADR 0399, 0413): the scene view's light and caster tool with its Edit Shape
// toggle, the Light2D Inspector section (fields by type, notes), the Project panel's 2D Lighting category (blend styles,
// with renames reaching the Light2Ds that name them), sorting layer renames reaching lights' and casters' targets, and
// the Hierarchy's 2D light and shadow caster entries; the Sprite Editor's Secondary Textures and Outline tabs and the
// image Import Settings' Secondary Textures card (ADR 0414).
import type { EditorPlugin } from "../../../editor/sdk";
import { lights2dManifest } from "../manifest";
import { lights2dTool } from "./lights2dTool";
import { blendStyleNames, lighting2DSettings, lights2DSortingLayers, shadowLayerNames } from "./lights2dSettingsModel";

/** The Create menu's 2D lights: a light of each type, as Unity's Light 2D menu has them. */
const LIGHTS: { id: string; label: string; data: Record<string, unknown> }[] = [
  { id: "light2d-global", label: "Global Light 2D", data: { type: "global", intensity: 0.5 } },
  { id: "light2d-point", label: "Point Light 2D", data: { type: "point" } },
  { id: "light2d-spot", label: "Spot Light 2D", data: { type: "point", innerAngle: 60, outerAngle: 90, outerRadius: 5 } },
  { id: "light2d-freeform", label: "Freeform Light 2D", data: { type: "freeform" } },
  { id: "light2d-sprite", label: "Sprite Light 2D", data: { type: "sprite" } },
];

export const lights2dEditorPlugin: EditorPlugin = {
  manifest: lights2dManifest,
  activate(context) {
    context.registerViewportTool(lights2dTool);
    context.registerInspectorSection("engine.Light2D", () => import("./Light2DSection").then((m) => m.Light2DSection), { single: true });
    context.registerProjectSettingsSection({
      id: "lighting2D",
      title: "2D Lighting",
      after: "Rendering",
      keys: [lighting2DSettings.key],
      names: [blendStyleNames, shadowLayerNames],
      view: () => import("./Lights2DSettingsSection").then((m) => m.Lights2DSettingsSection),
    });
    context.registerNameReferences(lights2DSortingLayers);
    // An image's normal and mask maps and its slices' outlines (ADR 0414).
    context.registerSpriteEditorTool({ id: "myco.lights2d.secondary", label: "Secondary Textures", view: () => import("./SpriteLightingTools").then((m) => m.SecondaryTexturesTool) });
    context.registerSpriteEditorTool({ id: "myco.lights2d.outline", label: "Outline", view: () => import("./SpriteLightingTools").then((m) => m.OutlineTool) });
    context.registerImportSettingsSection({ id: "myco.lights2d.secondary", kind: "image", title: "Secondary Textures", view: () => import("./SpriteLightingTools").then((m) => m.SecondaryTexturesCard) });
    for (const l of LIGHTS) {
      context.registerHierarchyCreateEntry({
        id: l.id,
        label: l.label,
        name: l.label,
        category: "2D Lights", // the Create menus' submenus (ADR 0383)
        components: (position) => [
          { type: "engine.Transform", data: { position } },
          { type: "engine.Light2D", data: l.data },
        ],
      });
    }
    context.registerHierarchyCreateEntry({
      id: "shadow-caster-2d",
      label: "Shadow Caster 2D",
      name: "Shadow Caster 2D",
      category: "2D Lights",
      components: (position) => [
        { type: "engine.Transform", data: { position } },
        { type: "engine.ShadowCaster2D", data: { shape: "custom", path: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] } },
      ],
    });
  },
};
