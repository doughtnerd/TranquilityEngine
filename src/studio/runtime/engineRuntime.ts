// The real `RuntimeStarter` (ADR 0327): an audio-only Engine with one empty World and only the audio plugin's runtime
// active (`studioPlugins.ts`), started so the audio system runs every frame. No scene loads and nothing is drawn: the
// Engine's `audioOnly` option makes its World play sound with no view (listened to and mixed as the World with the
// view is). `Engine.create`, `engine.start`, `engine.dispose`, and the internal `audioOnly` option.
import { Engine, type ProjectSettingsInput } from "../../engine";
import type { RuntimeStarter } from "./studioAudioHost";

/** The World the Studio's runtime plays in. */
export const STUDIO_WORLD = "Studio";

export const engineRuntime: RuntimeStarter = {
  async start(settings: ProjectSettingsInput) {
    const engine = await Engine.create({
      kind: "runtime",
      audioOnly: true,
      project: settings,
      quality: "keep",
      bootstrap: (e) => void e.createWorld({ name: STUDIO_WORLD, input: false, renders: false }),
    });
    engine.start();
    return { stop: () => engine.dispose() };
  },
};
