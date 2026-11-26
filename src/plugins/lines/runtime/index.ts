// The Lines plugin's runtime half (ADR 0396): `LineRenderer` and `TrailRenderer`, the trail sampling system and the
// lazy `lines` render feature. The ribbons are built here, renderer-neutral (`ribbon.ts`), and drawn through the
// renderer core's dynamic meshes and quad batches, so no line code is in the backend. `myco` (`src/myco.ts`) exports
// this module's public parts.
// Runtime code: never imports from `src/editor/` or the plugin's `editor/` folder; never imports Babylon (the
// feature's code loads on demand).
import type { RenderFeatureSpec } from "../../../engine/render/renderFeatures";
import type { RuntimePlugin } from "../../runtimeContext";
import { linesManifest } from "../manifest";
import { LineRenderer } from "./LineRenderer";
import { TrailRenderer } from "./TrailRenderer";
import { TRAIL_SYSTEM } from "./trails";

export { LineRenderer } from "./LineRenderer";
export { TrailRenderer } from "./TrailRenderer";
export type { RibbonAlignment, RibbonMode, RibbonTextureMode } from "./RibbonRenderer";

/**
 * In `content` after the meshes, so lines that cast shadows are collected with the casters; loaded the first time a
 * World has a line or trail, and holding its first frame meanwhile, so a level's lines show from frame one (ADR 0120).
 */
const LINES_SPEC: RenderFeatureSpec = { name: "lines", phase: "content", types: [LineRenderer, TrailRenderer], lazy: true, holdsFirstFrame: true, after: ["meshes"] };

export const linesRuntimePlugin: RuntimePlugin = {
  manifest: linesManifest,
  activate(context) {
    context.registerComponents([LineRenderer, TrailRenderer]);
    context.registerEngineSystems([TRAIL_SYSTEM]);
    context.registerRenderFeature({ spec: LINES_SPEC, load: () => import("./linesRenderer").then((m) => m.createLinesFeature) });
  },
};
