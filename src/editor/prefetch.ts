// Background loading for the editor (ADR 0082). The code a project needs to open, and the code of
// the panels and dialogs the editor loads on demand (ADR 0083), is fetched while the editor waits:
// in the desktop app, while the hidden editor window waits for the Projects window to hand it a
// project; in the browser, while the start screen shows. A project opening also starts the engine's
// chunks at once, so they load while its scripts compile instead of after.
import { whenIdle } from "./ui/lazy";

let engine: Promise<void> | null = null;

/**
 * Load the engine's lazily loaded chunks a project's first frame needs: the Babylon renderer, the
 * editor's gizmos, particles and the UI document parsers. Physics, navigation
 * and the script compiler load when a project uses them. Never throws (a real load reports it).
 */
export function prefetchEngine(): Promise<void> {
  engine ??= Promise.allSettled([
    import("../engine/render/babylon/BabylonRenderer"),
    import("../engine/render/babylon/editorTools"),
    import("../engine/render/babylon/particles"),
    import("../engine/ui/document/parsers"),
  ]).then(() => {});
  return engine;
}

/** Once the editor is idle: the engine's chunks, then the script compiler and the physics engines a project is likely to need. */
export function prefetchWhenIdle(): void {
  whenIdle(() => {
    void prefetchEngine().then(() =>
      whenIdle(() => {
        void Promise.allSettled([import("typescript"), import("../plugins/physics2d/runtime/Physics2DWorld"), import("../plugins/physics3d/runtime/Physics3DWorld")]);
      }),
    );
  });
}
