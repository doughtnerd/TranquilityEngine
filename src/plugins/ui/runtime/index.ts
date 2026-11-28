// The UI plugin's runtime half (ADR 0069, 0076, 0140): claims the UI Components (canvases, elements,
// UIView), and registers the lazy UI render feature. The classes, `UICore` and the Babylon
// GUI drawing stay in core: the adapter reads them from `render/babylon/` (ADR 0075), and the editor's
// overlays and input routing use the core. `myco` exports its public parts (`./public.ts`).
// Runtime code: never imports from `src/editor/` or Babylon (the feature's code loads on demand).
import type { RenderFeatureSpec } from "../../../engine/render/renderFeatures";
import { isUIComponent, UIAudio, UIButton, UICanvas, UIForm, UIImage, UIInputField, UILabel, UIMeter, UIOption, UIPanel, UIProgress, UIRadio, UISelect, UISlider, UISvg, UIText, UITextArea, UIToggle, UIVideo } from "../../../engine/ui/components";
import { UIControlMapper } from "./UIControlMapper";
import { UIView } from "./UIView";
import type { RuntimePlugin } from "../../runtimeContext";
import type { World } from "../../../engine/core/World";
import type { WorldServiceDef } from "../../../engine/core/worldServices";
import { forgetUIPreferences, loadUIPreferences } from "../../../engine/ui/preferences";
import { uiManifest } from "../manifest";

export * from "./public";

/**
 * Screen and world UI canvases and their elements; loaded the first time a World
 * has one (ADR 0083), holding the first frame meanwhile (ADR 0120). The only `overlay` feature.
 */
const UI_SPEC: RenderFeatureSpec = {
  name: "ui",
  phase: "overlay",
  types: [UICanvas],
  owns: (c) => isUIComponent(c),
  lazy: true,
  holdsFirstFrame: true,
  // A warm set's world-space UI (ADR 0080): warmed by `loadWarm` until the feature loads (ADR 0154).
  warms: (content) => content.worldUI,
};

/** Internal (ADR 0431): the player's saved UI preferences (namespace `settings`, key `myco.ui`), read before a runtime World's first scene. */
const UI_PREFERENCES_SERVICE: WorldServiceDef<null, World> = {
  id: "myco.uiPreferences",
  load: async () => null,
  create: (world) => world,
  dispose: (world) => forgetUIPreferences(world),
  neededBy: { scene: () => true },
  runsIn: (world) => world.kind === "runtime",
  prepareScene: (world) => loadUIPreferences(world),
};

export const uiRuntimePlugin: RuntimePlugin = {
  manifest: uiManifest,
  activate(context) {
    context.registerComponents([UICanvas, UIPanel, UIText, UIImage, UIButton, UIInputField, UITextArea, UIToggle, UIRadio, UISlider, UISelect, UIOption, UIProgress, UIMeter, UILabel, UIForm, UISvg, UIVideo, UIAudio, UIControlMapper, UIView]);
    context.registerRenderFeature({
      spec: UI_SPEC,
      load: () => import("./uiFeature").then((m) => m.loadUIFeature()),
      loadWarm: () => import("./uiWarm").then((m) => m.createUIWarm),
    });
    context.registerWorldService(UI_PREFERENCES_SERVICE);
  },
};
