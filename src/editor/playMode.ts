// Play mode (ADR 0022): run the open scene in a fresh Runtime World without touching what's being
// edited. Play snapshots the scene document (unsaved edits included), pauses the Editor World and
// boots a Runtime World with the project's real settings (autoloads and all) in the game view.
// Stop disposes the Runtime World and resumes the editor exactly as it was.
import { Assets, Engine, SceneManager, type AssetSource } from "../engine";
import { resumeEditorWorld } from "../engine/editor";
import type { EditorProject } from "./projects";
import type { OpenScene } from "./state";

export interface PlaySession {
  /** The Runtime World's engine. */
  readonly engine: Engine;
  /** The scene path being played. */
  readonly path: string;
  /** Dispose the Runtime World and resume the Editor World. */
  stop(): void;
}

export interface PlayOptions {
  editor: Engine;
  scene: OpenScene;
  project: EditorProject;
  /** Element for the game's canvas; omit to run headless (tests). */
  container?: HTMLElement;
}

/**
 * Start playing `scene`. Throws (with the editor resumed) if the scene can't load, e.g. a script
 * error in `awake`.
 */
export async function startPlay({ editor, scene, project, container }: PlayOptions): Promise<PlaySession> {
  // The Runtime World loads the scene by path; serve the document as it is now under that path.
  // A deep copy, so edits made during play don't reach the game even when it reloads the scene.
  const snapshot = structuredClone(scene.doc.toJSON());
  const overlay: AssetSource = { has: (p) => p === scene.path, get: () => structuredClone(snapshot) };
  Assets.addSource(overlay);
  const editorWasRunning = editor.isRunning;
  editor.stop();

  let runtime: Engine | null = null;
  const resume = () => {
    runtime?.dispose();
    Assets.removeSource(overlay);
    resumeEditorWorld(editor.world);
    if (editorWasRunning) editor.start();
  };
  try {
    runtime = await Engine.create({ container, headless: !container, project: project.settings });
    await SceneManager.load(scene.path);
    if (container) runtime.start(); // headless (tests): the caller steps the Runtime World
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
