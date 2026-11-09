// The play session (ADR 0161): the editor's edit → starting → playing → edit state machine, and the work
// that waits for Stop. Play itself is `startPlay` (playMode.ts, a launch adapter, ADR 0155); this module
// decides when it may start, what Stop undoes and in which order, and what a script reload or a plugin
// change does in each state (ADR 0030, 0125, 0133). The page's game view and the pre-play script check
// are ports, so tests drive it headless.
import { Material, type Engine } from "../engine";
import { captureScriptTypes, swapScriptTypes, type ScriptSwap } from "../engine/editor";
import { errorStatus } from "./messages";
import { startPlay, type PlaySession } from "./playMode";
import { netConditionsSetting, netPlaySetup } from "./preferences";
import type { EditorProject } from "./projects";
import { applyKept, endLiveInspection, takeKept, type KeptValues } from "./runtimeInspect";
import { syncPackageTypes } from "./scriptCheck";
import { loadedRegistrations } from "./scriptLoader";
import { currentProject, docVersion, openScene, playing, playState, scriptProblems, scriptsVersion, status } from "./state";
import { applyEditorPlugins, reportPluginProblems } from "../plugins/editorPlugins";
import { loadProjectCode, projectPlugins } from "../plugins/thirdPartyEditor";

export interface PlaySessionPorts {
  /** The Editor World's Engine (paused while playing); null with no project open, when Play does nothing. */
  editor(): Engine | null;
  /** The pre-play script check (ADR 0125): resolves false to cancel Play. */
  checkBeforePlay(project: EditorProject): Promise<boolean>;
  /** Where the game shows, and the play bar's tools mounted on it (returns their unmount). Omit to play headless: the caller steps `playing.value.engine`. */
  gameView?(): { container: HTMLElement; mountTools(play: PlaySession): () => void };
}

export interface PlayController {
  /** Check the scripts, then play the open scene (ADR 0022, 0032). Ignored unless editing; a failed start returns to edit with the error in the status bar. */
  start(): Promise<void>;
  /**
   * Leave play mode and run the work deferred to Stop, in order: kept values (one undo step), plugin
   * settings, script reload. `discardQueued` drops the queued plugin and script work (a project switch or
   * close). Resolves once the queued work is done.
   */
  stop(options?: { discardQueued?: boolean }): Promise<void>;
  /** Start in edit, stop while playing. */
  toggle(): void;
  /**
   * Reload the project's scripts (ADR 0030): in edit, load them again and rebuild the open scene from its
   * document; while playing, swap the running game to the new types (ADR 0125) and rebuild the Editor World
   * on Stop; while starting, reload on Stop. `outside`: a change on disk, skipped when the files match what's loaded.
   */
  reloadScripts(options?: { outside?: boolean }): Promise<void>;
  /** The open project's `plugins.disabled` changed (ADR 0133): apply it live in edit, otherwise on Stop. */
  reapplyPlugins(): void;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const problemList = (problems: readonly { path: string; message: string }[]) => problems.map((p) => `${p.path}: ${p.message}`);

export function createPlaySession(ports: PlaySessionPorts): PlayController {
  let play: PlaySession | null = null;
  /** True while Play waits for the scripts' type check. */
  let checking = false;
  /** Removes the play bar's tools from the game view. */
  let unmountTools: () => void = () => {};
  /** Work deferred to Stop. */
  const queued = { scripts: false, plugins: false };

  /** Apply `plugins.disabled` live; true if the third-party plugins' code needs a script reload (ADR 0139). */
  function applyPlugins(project: EditorProject): boolean {
    queued.plugins = false;
    reportPluginProblems(applyEditorPlugins(project.settings.plugins?.disabled, { layout: "live" }).problems);
    openScene.value?.sync.build();
    docVersion.value++; // panels, outlines, asset kinds and the Inspector pick up the change
    return projectPlugins.value.found.length > 0;
  }

  function reapplyPlugins(): void {
    const project = currentProject.value;
    if (!project) return;
    if (playState.value !== "edit") {
      queued.plugins = true;
      status.value = { kind: "info", text: "Plugin settings changed. They apply when you stop playing." };
      return;
    }
    if (applyPlugins(project)) void reloadScripts();
  }

  async function reloadScripts(options: { outside?: boolean } = {}): Promise<void> {
    const project = currentProject.value;
    if (!project) return;
    if (options.outside) {
      // A change on disk: skip it when the files match what's loaded (e.g. the editor's own save).
      const before = project.scripts;
      try {
        await project.rereadScripts();
      } catch {
        return;
      }
      const after = project.scripts;
      if (after.size === before.size && [...after].every(([path, text]) => before.get(path) === text)) return;
    }
    if (playState.value === "playing" && play) return reloadIntoGame(project, play);
    if (playState.value !== "edit") {
      queued.scripts = true;
      status.value = { kind: "info", text: "Scripts changed. They'll reload when you stop playing." };
      return;
    }
    queued.scripts = false;
    try {
      await project.rereadScripts();
    } catch (err) {
      status.value = errorStatus(`Couldn't read the scripts`, err);
      return;
    }
    const result = await loadProjectCode(project); // third-party plugins' halves re-activate from the new code (ADR 0139)
    scriptProblems.value = result.problems;
    scriptsVersion.value++;
    syncPackageTypes(project);
    const scene = openScene.value;
    if (scene) {
      scene.sync.build();
      docVersion.value++; // panels, outlines and the gizmo pick up the rebuilt nodes
    }
    const problems = problemList(result.problems);
    status.value =
      problems.length > 0
        ? { kind: "error", text: `Reloaded scripts; ${problems.join("; ")}`, detail: problems.join("\n") }
        : options.outside
          ? { kind: "info", text: "Scripts changed on disk; reloaded them." }
          : result.loaded.length === 0
            ? { kind: "info", text: "Reloaded scripts: there are none under scripts/ now." }
            : { kind: "info", text: `Reloaded ${plural(result.loaded.length, "script")}.` };
  }

  /** Load the scripts again, then swap every World of the running game to the new types, keeping each component's properties (ADR 0125). */
  async function reloadIntoGame(project: EditorProject, game: PlaySession): Promise<void> {
    try {
      await project.rereadScripts();
    } catch (err) {
      status.value = errorStatus(`Couldn't read the scripts`, err);
      return;
    }
    const before = captureScriptTypes(loadedRegistrations());
    const result = await loadProjectCode(project, { runtime: false }); // plugins' editor halves re-activate; runtime halves wait for Stop (ADR 0139)
    scriptProblems.value = result.problems;
    scriptsVersion.value++;
    queued.scripts = true; // the Editor World rebuilds from its document on Stop
    if (play !== game) return; // stopped meanwhile: Stop's reload covers it
    let swap: ScriptSwap;
    try {
      swap = swapScriptTypes(game.engine, before);
      game.redraw();
    } catch (err) {
      status.value = errorStatus("Couldn't reload the scripts into the running game", err);
      return;
    }
    const problems = problemList(result.problems);
    const kept = swap.kept.length ? `; ${swap.kept.join(", ")} keep${swap.kept.length === 1 ? "s" : ""} running the old code until Stop` : "";
    status.value = problems.length
      ? { kind: "error", text: `Reloaded scripts into the game (${plural(swap.swapped, "component")} swapped); ${problems.join("; ")}${kept}`, detail: problems.join("\n") }
      : { kind: "info", text: `Reloaded scripts into the running game: ${plural(swap.swapped, "component")} swapped, state kept${kept}.` };
  }

  async function start(): Promise<void> {
    const editor = ports.editor(), scene = openScene.value, project = currentProject.value;
    if (!editor || !scene || !project || playState.value !== "edit" || checking) return;
    // Type-check the scripts first (ADR 0125); with errors the user picks Play anyway or not.
    checking = true;
    let go: boolean;
    try {
      go = await ports.checkBeforePlay(project);
    } finally {
      checking = false;
    }
    if (!go || ports.editor() !== editor || openScene.value !== scene || currentProject.value !== project || playState.value !== "edit") return;
    playState.value = "starting";
    const setup = netPlaySetup.value;
    const view = ports.gameView?.();
    try {
      play = await startPlay({
        editor,
        scene,
        project,
        container: view?.container,
        netPlay: setup.enabled ? { clients: setup.clients, thin: setup.thin, thinInput: setup.thinInput, clientScenes: setup.clientScenes ?? "server" } : undefined,
        conditions: netConditionsSetting.value,
      });
    } catch (err) {
      playState.value = "edit";
      status.value = errorStatus(`Couldn't play ${scene.path}`, err);
      return;
    }
    playing.value = play;
    playState.value = "playing";
    unmountTools = view ? view.mountTools(play) : () => {}; // the play bar's Gizmos and Stats
    setPlayEngineHook(play.engine);
    const net = play.netPlay;
    const how = net
      ? ` with ${plural(net.clients.length, "client")}${net.thin.length ? ` and ${plural(net.thin.length, "thin client")}` : ""}${net.server ? ` on the ${net.server} World` : ""}`
      : setup.enabled
        ? " as the project sets it up (multiplayer play needs a client World linked to a server World, or a server template)"
        : "";
    status.value = { kind: "info", text: `Playing ${scene.path}${how}. Edits made now don't affect the running game. Stop (Ctrl+P) to return.` };
  }

  async function stop(options: { discardQueued?: boolean } = {}): Promise<void> {
    if (!play) return;
    const keptValues = takeKept(); // "Keep values" from the live Inspector (runtimeInspect.ts)
    endLiveInspection();
    unmountTools();
    unmountTools = () => {};
    play.stop();
    play = null;
    Material._resetShared(); // scripts' changes to shared Materials are play-mode state, never the asset's (ADR 0107)
    playing.value = null;
    setPlayEngineHook(null);
    playState.value = "edit";
    status.value = null;
    if (keptValues.length > 0) {
      // Scripts swapped during play replaced their types: rebuild the Editor World's nodes first, or the
      // kept values of the replaced components would find no component to land on.
      if (queued.scripts) openScene.value?.sync.build();
      writeKeptValues(keptValues);
    }
    if (options.discardQueued) {
      queued.scripts = queued.plugins = false;
      return;
    }
    const project = currentProject.value;
    const reload = queued.scripts || (queued.plugins && project !== null && applyPlugins(project));
    queued.plugins = false;
    if (reload) await reloadScripts();
  }

  return {
    start,
    stop,
    toggle() {
      if (playState.value === "edit") void start();
      else if (playState.value === "playing") void stop();
    },
    reloadScripts,
    reapplyPlugins,
  };
}

/** Write values kept during play into the open scene as one undo step, and say what happened. */
function writeKeptValues(list: KeptValues[]): void {
  const scene = openScene.value;
  if (!scene) return;
  try {
    const { written, skipped } = applyKept(scene, list);
    const text = `Kept play-mode changes: ${plural(written, "field")} written to ${scene.path} (Undo reverts them)${skipped.length ? `; ${skipped.length} skipped: ${skipped.join(" ")}` : "."}`;
    status.value = { kind: skipped.length && !written ? "error" : "info", text, detail: skipped.length ? skipped.join("\n") : undefined };
  } catch (err) {
    status.value = errorStatus("Couldn't keep the play-mode changes", err);
  }
}

/** Debug and end-to-end test hook: `window.playEngine`, the running game's Engine. */
function setPlayEngineHook(engine: Engine | null): void {
  if (typeof window !== "undefined") Object.assign(window, { playEngine: engine });
}
