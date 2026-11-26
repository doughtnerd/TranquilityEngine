// The UI plugin's runtime half (ADR 0069, 0076, 0140): claims the UI Components (canvases, elements,
// UIDocument), and registers the lazy UI render feature. The classes, `UICore` and the Babylon
// GUI drawing stay in core: the adapter reads them from `render/babylon/` (ADR 0075), and the editor's
// overlays and input routing use the core. `myco` (`src/myco.ts`) exports the public parts from here.
// Runtime code: never imports from `src/editor/` or Babylon (the feature's code loads on demand).
import type { RenderFeatureSpec } from "../../../engine/render/renderFeatures";
import { isUIComponent, UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText } from "../../../engine/ui/components";
import { UIDocument } from "../../../engine/ui/UIDocument";
import { UIControlMapper } from "../../../engine/ui/controlMapper";
import type { RuntimePlugin } from "../../runtimeContext";
import { uiManifest } from "../manifest";

export { UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText, type UIAlign, type UICanvasMode, type UIDisplay, type UIFlexDirection, type UIImageFit, type UIJustify, type UILength, type UINavigationMode, type UIPositionType, type UITextAlign, type UIWordBreak } from "../../../engine/ui/components";
export { UIActions, UI_CONTEXT_PRIORITY } from "../../../engine/ui/navigation";
export { UIControlMapper, type UIControlMapperCell, type UIControlMapperDevice, type UIControlMapperRow, type UIControlMapperSetting, type UIControlMapperSettingKind, type UIControlMapperText } from "../../../engine/ui/controlMapper";
export { UIClassList, UIDocument, UIDocumentElement, UIEvents, type UIEvent, type UIEventHandler, type UIEventType, type UIListOptions, type UITag } from "../../../engine/ui/UIDocument";

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

export const uiRuntimePlugin: RuntimePlugin = {
  manifest: uiManifest,
  activate(context) {
    context.registerComponents([UICanvas, UIPanel, UIText, UIImage, UIButton, UIInputField, UIDocument, UIControlMapper]);
    context.registerRenderFeature({
      spec: UI_SPEC,
      load: () => import("./uiFeature").then((m) => m.loadUIFeature()),
      loadWarm: () => import("./uiWarm").then((m) => m.createUIWarm),
    });
  },
};
