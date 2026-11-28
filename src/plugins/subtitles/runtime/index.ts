// The Subtitles plugin's runtime half (ADR 0357 §5): the `SubtitleDisplay` component, the `Subtitles` player settings
// and the World service that loads the saved settings before a runtime World's first scene. `myco`
// exports its public parts (`./public.ts`). Built only on public API (the audio and UI plugins' exports, `Locale`,
// `Storage`); runtime code: never imports from `src/editor/`.
import type { World } from "../../../engine/core/World";
import type { WorldServiceDef } from "../../../engine/core/worldServices";
import type { RuntimePlugin } from "../../runtimeContext";
import { subtitlesManifest } from "../manifest";
import { SubtitleDisplay } from "./SubtitleDisplay";
import { forgetSubtitleSettings, loadSubtitleSettings } from "./Subtitles";

export * from "./public";
export { type SubtitleSize, type SubtitleSpeakerLook } from "./Subtitles";

/** Internal: the saved player settings (namespace `settings`, key `myco.subtitles`), read before a World's first scene. */
const SUBTITLES_SERVICE: WorldServiceDef<null, World> = {
  id: "myco.subtitles",
  load: async () => null,
  create: (world) => world,
  dispose: (world) => forgetSubtitleSettings(world),
  neededBy: { scene: () => true },
  runsIn: (world) => world.kind === "runtime",
  prepareScene: (world) => loadSubtitleSettings(world),
};

export const subtitlesRuntimePlugin: RuntimePlugin = {
  manifest: subtitlesManifest,
  activate(context) {
    context.registerComponents([SubtitleDisplay]);
    context.registerWorldService(SUBTITLES_SERVICE);
  },
};
