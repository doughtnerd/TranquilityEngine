// The Sprites plugin's runtime half (ADR 0140): claims SpriteRenderer and registers the sprites render
// feature. The component class and its Babylon adapter (`BabylonSprites`) stay in core: the adapter
// must stay under `render/babylon/` (ADR 0075) and reads the class, and core never imports plugins
// (ADR 0135). `myco` (`src/myco.ts`) exports the public parts from here.
// Runtime code: never imports from `src/editor/` or Babylon (the feature's code loads on demand).
import { SpriteRenderer } from "../../../engine/render/components";
import type { RenderFeatureSpec } from "../../../engine/render/renderFeatures";
import type { RuntimePlugin } from "../../runtimeContext";
import { spritesManifest } from "../manifest";

export { SpriteRenderer } from "../../../engine/render/components";

/** @internal The first feature of the `content` phase (tilemaps and meshes name it in their `after`). */
export const SPRITES_SPEC: RenderFeatureSpec = { name: "sprites", phase: "content", types: [SpriteRenderer], lazy: false };

export const spritesRuntimePlugin: RuntimePlugin = {
  manifest: spritesManifest,
  activate(context) {
    context.registerComponents([SpriteRenderer]);
    context.registerRenderFeature({ spec: SPRITES_SPEC, load: () => import("./spritesFeature").then((m) => m.createSpritesFeature) });
  },
};
