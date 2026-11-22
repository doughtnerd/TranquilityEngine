// The real `RuntimeStarter` (ADR 0327): an Engine with one empty World and only the audio plugin's runtime active
// (`studioPlugins.ts`), started so the audio system runs every frame. No scene loads and nothing is drawn that anyone
// sees: the audio runtime plays only for a World with a view (`AudioSource.worldPlays`), so the World gets one in a
// hidden 1×1 element instead of the page. (A truly headless audio-only World needs an engine option; see the
// Studio's build notes.) Public engine API only: `Engine.create`, `engine.start`, `engine.dispose`.
import { Engine, type ProjectSettingsInput } from "../../engine";
import type { RuntimeStarter } from "./studioAudioHost";

/** The World the Studio's runtime plays in. */
export const STUDIO_WORLD = "Studio";

export const engineRuntime: RuntimeStarter = {
  async start(settings: ProjectSettingsInput) {
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.dataset.studioRuntime = "";
    Object.assign(host.style, { position: "fixed", left: "-10px", top: "-10px", width: "1px", height: "1px", overflow: "hidden", opacity: "0", pointerEvents: "none" });
    document.body.append(host);
    try {
      const engine = await Engine.create({
        kind: "runtime",
        container: host,
        project: settings,
        quality: "keep",
        bootstrap: (e) => void e.createWorld({ name: STUDIO_WORLD, input: false }),
      });
      engine.start();
      return {
        stop() {
          engine.dispose();
          host.remove();
        },
      };
    } catch (err) {
      host.remove();
      throw err;
    }
  },
};
