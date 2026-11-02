// Play mode (ADR 0022, 0032): run the open scene in a fresh Engine without touching what's being
// edited. Play snapshots the scene document (unsaved edits included), pauses the Editor World and
// builds an Engine from the project's bootstrap (the default one: a single World, unless the
// project says otherwise), with the project's real settings (autoloads and all), in the game view.
// Every start-up World whose config names no scenes plays the open scene (one that says
// `scenes: []` starts empty, as in a build). Stop disposes the
// Engine and resumes the editor exactly as it was.
import { Assets, Engine, type AssetSource, type Bootstrap } from "../engine";
import { engineWorld, engineWorldConfig, resumeEditorWorld } from "../engine/editor";
import { createGameView, type GameView } from "./gameView";
import type { EditorProject } from "./projects";
import { loadedScriptModule } from "./scriptLoader";
import type { OpenScene } from "./state";

export interface PlaySession {
  /** The game's Engine, with the Worlds the project's bootstrap made. */
  readonly engine: Engine;
  /** The scene path being played. */
  readonly path: string;
  /** Dispose the game's Engine and resume the Editor World. */
  stop(): void;
}

export interface PlayOptions {
  editor: Engine;
  scene: OpenScene;
  project: EditorProject;
  /** Element for the game view (its Worlds' canvases); omit to run headless (tests). */
  container?: HTMLElement;
}

/**
 * Start playing `scene`. Throws (with the editor resumed) if the Engine or the scene can't start,
 * e.g. a bad bootstrap or a script error in `awake`.
 */
export async function startPlay({ editor, scene, project, container }: PlayOptions): Promise<PlaySession> {
  // Worlds load the scene by path; serve the document as it is now under that path, to every
  // World that loads it. A deep copy, so edits made during play don't reach the game even when it
  // reloads the scene.
  const snapshot = structuredClone(scene.doc.toJSON());
  const overlay: AssetSource = { has: (p) => p === scene.path, get: () => structuredClone(snapshot) };
  Assets.addSource(overlay);
  const editorWasRunning = editor.isRunning;
  editor.stop();

  let runtime: Engine | null = null;
  let view: GameView | null = null;
  const resume = () => {
    runtime?.dispose();
    view?.dispose();
    Assets.removeSource(overlay);
    resumeEditorWorld(editor.world);
    if (editorWasRunning) editor.start();
  };
  try {
    view = container ? createGameView(container) : null;
    runtime = await Engine.create({ container: view?.main, headless: !container, project: project.settings, loadScript: loadBootstrapScript });
    for (const handle of runtime.worlds()) {
      const named = engineWorldConfig(runtime, handle.name)?.scenes !== undefined;
      if (!named && engineWorld(runtime, handle.name)!.sceneNodes.length === 0) await handle.loadScene(scene.path);
    }
    view?.attach(runtime);
    if (container) runtime.start(); // headless (tests): the caller steps the Engine
  } catch (err) {
    resume();
    throw err;
  }
  let stopped = false;
  return {
    engine: runtime,
    path: scene.path,
    stop() {
      if (stopped) return;
      stopped = true;
      resume();
    },
  };
}

/** A code bootstrap (`"bootstrap": "scripts/Bootstrap.ts"`, ADR 0032): the `bootstrap` export of the project script, as the editor loaded it. */
async function loadBootstrapScript(path: string): Promise<Bootstrap> {
  return (await loadedScriptModule(path)).bootstrap as Bootstrap;
}
