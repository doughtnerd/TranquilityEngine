// Play mode (ADR 0022, 0032): run the open scene in a fresh Engine without touching what's being
// edited. Play snapshots the scene document (unsaved edits included), pauses the Editor World and
// builds an Engine from the project's bootstrap (the default one: a single World, unless the
// project says otherwise), with the project's real settings (autoloads and all), in the game view.
// Every start-up World whose config names no scenes plays the open scene (one that says
// `scenes: []` starts empty, as in a build). Stop disposes the
// Engine and resumes the editor exactly as it was.
//
// Multiplayer play (ADR 0033 §9, `netPlay.ts`): given `netPlay`, a project with a client/server
// layout plays with N client Worlds plus T thin clients made from its client World instead, and
// the network conditions given are simulated on its loopback links from the start.
import { Assets, Engine, type AssetSource, type Bootstrap } from "../engine";
import { engineWorld, engineWorldConfig, resumeEditorWorld } from "../engine/editor";
import { createGameView, type GameView } from "./gameView";
import { applyNetConditions, conditionsOff, createThinInput, playBootstrap, withConditions, type NetConditionValues, type NetPlayBootstrap, type NetPlayOptions, type ThinInput, type ThinInputMode } from "./netPlay";
import type { EditorProject } from "./projects";
import { loadedScriptModule } from "./scriptLoader";
import type { OpenScene } from "./state";

export interface PlaySession {
  /** The game's Engine, with the Worlds the project's bootstrap made. */
  readonly engine: Engine;
  /** The scene path being played. */
  readonly path: string;
  /** The multiplayer play bootstrap the Engine was built from; null when it plays the project's own. */
  readonly netPlay: NetPlayBootstrap | null;
  /**
   * Simulate network conditions on every loopback link from now on (links made later in the session
   * too). All zero turns simulation off: links open now get zero, links made later keep their own.
   */
  setConditions(conditions: NetConditionValues): void;
  /** Write the thin clients' synthetic input once (done every frame with a game view; headless tests call it). */
  updateThinInput(): void;
  /** Dispose the game's Engine and resume the Editor World. */
  stop(): void;
}

export interface PlayOptions {
  editor: Engine;
  scene: OpenScene;
  project: EditorProject;
  /** Element for the game view (its Worlds' canvases); omit to run headless (tests). */
  container?: HTMLElement;
  /** Multiplayer play: client and thin-client counts, and what thin clients send. Omit to play the project's bootstrap as it is. */
  netPlay?: NetPlayOptions & { thinInput?: ThinInputMode };
  /** Network conditions to simulate from the start, from the links' first message (all zero: the links keep their own settings). */
  conditions?: NetConditionValues;
}

/** How often conditions are applied again while playing, to reach links made since (a World created at runtime). */
const CONDITIONS_REFRESH_MS = 250;

/**
 * Start playing `scene`. Throws (with the editor resumed) if the Engine or the scene can't start,
 * e.g. a bad bootstrap or a script error in `awake`.
 */
export async function startPlay({ editor, scene, project, container, netPlay: netOptions, conditions: initial }: PlayOptions): Promise<PlaySession> {
  // Worlds load the scene by path; serve the document as it is now under that path, to every
  // World that loads it. A deep copy, so edits made during play don't reach the game even when it
  // reloads the scene.
  const snapshot = structuredClone(scene.doc.toJSON());
  const overlay: AssetSource = { has: (p) => p === scene.path, get: () => structuredClone(snapshot) };
  Assets.addSource(overlay);
  const editorWasRunning = editor.isRunning;
  editor.stop();

  const netPlay = netOptions ? playBootstrap(project.settings.bootstrap, netOptions) : null;
  /** The conditions kept applied; null while the links keep their own settings. */
  let conditions = initial && !conditionsOff(initial) ? initial : null;
  const bootstrap = withConditions(netPlay ? netPlay.bootstrap : project.settings.bootstrap, conditions);
  const settings = bootstrap === project.settings.bootstrap ? project.settings : { ...project.settings, bootstrap };
  let runtime: Engine | null = null;
  let view: GameView | null = null;
  let thin: ThinInput | null = null;
  let stopped = false;
  let frame = 0;
  let refreshed = -Infinity;
  // With a game view: thin clients' input every frame, and conditions again now and then.
  const loop = (now: number) => {
    frame = requestAnimationFrame(loop);
    try {
      thin?.update();
      if (conditions && runtime && now - refreshed >= CONDITIONS_REFRESH_MS) {
        refreshed = now;
        applyNetConditions(runtime, conditions);
      }
    } catch (err) {
      console.error("[myco] Multiplayer play couldn't update:", err);
    }
  };
  const startLoop = () => {
    if (container && frame === 0 && !stopped && (thin || conditions)) frame = requestAnimationFrame(loop);
  };
  const resume = () => {
    if (frame) cancelAnimationFrame(frame);
    runtime?.dispose();
    view?.dispose();
    Assets.removeSource(overlay);
    resumeEditorWorld(editor.world);
    if (editorWasRunning) editor.start();
  };
  try {
    view = container ? createGameView(container) : null;
    runtime = await Engine.create({ container: view?.main, headless: !container, project: settings, loadScript: loadBootstrapScript });
    for (const handle of runtime.worlds()) {
      const named = engineWorldConfig(runtime, handle.name)?.scenes !== undefined;
      if (!named && engineWorld(runtime, handle.name)!.sceneNodes.length === 0) await handle.loadScene(scene.path);
    }
    if (netPlay && netPlay.thin.length > 0) thin = createThinInput(runtime, netPlay.thin, netOptions?.thinInput ?? "random");
    view?.attach(runtime, { thin: netPlay?.thin ?? [] });
    if (container) runtime.start(); // headless (tests): the caller steps the Engine
    startLoop();
  } catch (err) {
    resume();
    throw err;
  }
  const engine = runtime;
  return {
    engine,
    path: scene.path,
    netPlay,
    setConditions(c) {
      if (stopped) return;
      applyNetConditions(engine, c);
      conditions = conditionsOff(c) ? null : c; // off: no refreshing, so links made later keep their own settings
      startLoop();
    },
    updateThinInput() {
      if (!stopped) thin?.update();
    },
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
