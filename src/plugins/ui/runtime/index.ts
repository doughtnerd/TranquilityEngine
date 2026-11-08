// The UI plugin's runtime half (ADR 0069, 0076, 0140): claims the UI Components (canvases, elements,
// UIDocument) and Text, and registers the lazy UI render feature. The classes, `UICore` and the Babylon
// GUI drawing stay in core: the adapter reads them from `render/babylon/` (ADR 0075), and the editor's
// overlays and input routing use the core. `myco` (`src/myco.ts`) exports the public parts from here.
// Runtime code: never imports from `src/editor/` or Babylon (the feature's code loads on demand).
import { Text } from "../../../engine/render/components";
import type { RenderFeatureSpec } from "../../../engine/render/renderFeatures";
import { isUIComponent, UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText } from "../../../engine/ui/components";
import { UIDocument } from "../../../engine/ui/UIDocument";
import type { RuntimePlugin } from "../../runtimeContext";
import { uiManifest } from "../manifest";

export { Text, type Anchor } from "../../../engine/render/components";
export { UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText, type UIAlign, type UICanvasMode, type UIDisplay, type UIFlexDirection, type UIImageFit, type UIJustify, type UILength, type UIPositionType, type UITextAlign, type UIWordBreak } from "../../../engine/ui/components";
export { UIClassList, UIDocument, UIDocumentElement, UIEvents, type UIEvent, type UIEventHandler, type UIEventType, type UIListOptions, type UITag } from "../../../engine/ui/UIDocument";

/**
 * @internal Screen and world UI canvases and their elements, and `Text`; loaded the first time a World
 * has one (ADR 0083), holding the first frame meanwhile (ADR 0120). The only `overlay` feature.
 */
export const UI_SPEC: RenderFeatureSpec = {
  name: "ui",
  phase: "overlay",
  types: [UICanvas, Text],
  owns: (c) => isUIComponent(c) || c instanceof Text,
  lazy: true,
  holdsFirstFrame: true,
};

export const uiRuntimePlugin: RuntimePlugin = {
  manifest: uiManifest,
  activate(context) {
    context.registerComponents([UICanvas, UIPanel, UIText, UIImage, UIButton, UIInputField, UIDocument, Text]);
    context.registerRenderFeature({ spec: UI_SPEC, load: () => import("./uiFeature").then((m) => m.loadUIFeature()) });
  },
};
