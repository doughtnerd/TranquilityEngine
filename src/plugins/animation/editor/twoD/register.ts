// Editor registration seam: twoD (T56). Registers flipbooks from slices and the 2D bone editor with weights.
// The editor half's `activate()` (`../index.ts`) calls it once per activation.
// - Flipbooks (ADR 0371, 0373): an image's flipbooks are its sidecar's `flipbooks`, each the sub-asset `image.png#Flip/<name>`
//   (an `animclip`; the image kind declares its sub-assets, `editor/imageSubAssets.ts`). Made from selected slices by the
//   Assets panel's "Create Flipbook" action (this file) or the Sprite Editor's Flipbooks tab, and edited in both that tab
//   and a Flipbooks card of the image's Import Settings (`FlipbooksCard.tsx`, `FlipbookEditor.tsx`).
// - The 2D bone editor is the Sprite Editor's Bones tab (`BoneEditor.tsx`): its edits are steps of the editor's own history
//   and its Apply writes `skin` into the sidecar.
import { editor, type AssetActionTarget, type EditorPluginContext } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";
import { createFlipbook, type Flipbooks } from "./flipbookLogic";

/** The image the targets are slices of (every target a slice of the same image), or null. */
export function imageOfSlices(targets: readonly AssetActionTarget[]): string | null {
  const image = targets[0]?.path;
  return image !== undefined && targets.every((t) => t.slice !== undefined && t.path === image) ? image : null;
}

/** @internal */
export function registerTwoD(context: EditorPluginContext, _on: AnimationEditorIntegrations): void {
  // The Assets panel: slices selected in the project become a flipbook of their image (frames ordered by name and number).
  context.registerAssetAction({
    id: "myco.animation.flipbook-from-slices",
    label: "Create Flipbook from Slices",
    writes: true,
    appliesTo: (_project, targets) => imageOfSlices(targets) !== null,
    run: async (project, targets) => {
      const image = imageOfSlices(targets);
      if (image === null) return [];
      const { settings } = editor.assets.importSettings(project, image);
      const result = createFlipbook(settings.flipbooks, settings.sprites.map((s) => s.name), targets.map((t) => t.slice!));
      if ("refused" in result) {
        editor.messages.error(`Can't create a flipbook: ${result.refused}`);
        return [];
      }
      const flipbooks: Flipbooks = result.next.flipbooks;
      await editor.assets.writeImportSettings(project, image, { ...settings, flipbooks: { ...flipbooks } });
      editor.messages.info(`Created flipbook ${result.next.name} of ${editor.assets.fileName(image)}: ${image}#Flip/${result.next.name}`);
      return [image]; // selected, so the Inspector shows its Flipbooks card
    },
  });
  context.registerImportSettingsSection({ id: "myco.animation.flipbooks", kind: "image", title: "Flipbooks", view: () => import("./FlipbooksCard").then((m) => m.FlipbooksCard) });
  context.registerSpriteEditorTool({ id: "myco.animation.flipbooks", label: "Flipbooks", view: () => import("./FlipbooksCard").then((m) => m.FlipbooksTool) });
  context.registerSpriteEditorTool({ id: "myco.animation.bones", label: "Bones", view: () => import("./BoneEditor").then((m) => m.BoneEditor) });
}
