// The story harness over the editor surface (ADR 0235, amending 0219). A story that renders an editor component which
// reads the editor (a panel, an Inspector, a plugin's section) declares the editor it needs in `parameters.editor`, and
// the meta's `beforeEach: withEditor` builds it before the story renders, as the editor's boot and a project opening do:
//
// - the core asset kinds and the built-in panels registered (`main.tsx`, `corePanels.ts`);
// - the first-party plugins applied through the editor's own plugin set (`applyEditorPlugins`), with the project's
//   `plugins.disabled`, as the session does when a project opens;
// - a writable project over `MemoryFileSystem`, opened with `openFolderProject` and made the editor's project;
// - with `scene`, an Editor World (a headless editor Engine) with that scene open in a tab of the editor's own scene
//   tabs (`createSceneTabs`, as the session makes them; no edit history, and closing never asks).
//
// The story then reaches state only through the editor SDK surface (`editor.project`, `editor.assets`, `editor.scene`,
// `editor.viewport`), never the shell's signals. What the surface leaves to the shell's own UI (the play bar), the
// harness does as that UI does: `startPlaying` runs a real play session of the open scene (`startPlay`, as Play does),
// and `setPlayState` sets play mode alone, for a panel that reads only `editor.scene.playState`. The cleanup returned
// puts everything back, so the next story starts from no project, no scene, edit mode and nothing selected.
//
// Harness code, never imported by the editor build: it sits beside the stories that use it, like `testing.ts` beside
// the unit tests.
import type { ComponentChildren } from "preact";
import { useMemo } from "preact/hooks";
import { Engine, GameObject } from "../../engine";
import { applyEditorPlugins } from "../../plugins/editorPlugins";
import { registerCoreAssetKinds } from "../assetKinds.builtin";
import { selectedAssets } from "../assetSelection";
import { resetLayout } from "../layout/store";
import { MemoryFileSystem } from "../memoryFs";
import { OrbitCamera } from "../OrbitCamera";
import { startPlay, type PlaySession } from "../playMode";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "../projects";
import { createSceneTabs } from "../sceneTabs";
import { currentProject, openScene, playing, playState, sceneCamera, select, status } from "../state";
import { PanelInstanceContext, type PanelInstance } from "../ui/panel/Panel";
import { panelView } from "../ui/panels";
import { registerBuiltinPanels } from "../ui/panels.builtin";

/** What `parameters.editor` holds: the editor a story renders in. */
export interface EditorStoryParameters {
  /**
   * The project's files, by project-relative path: text, bytes, or a value written as JSON. `project.json` is `{}`
   * unless given; its `plugins.disabled` turns first-party plugins off as in the editor.
   */
  readonly files?: Readonly<Record<string, string | Uint8Array | object>>;
  /** The project folder's path on disk (its name is the project's name). */
  readonly root?: string;
  /** A scene or prefab file to open in a tab of a headless Editor World. */
  readonly scene?: string;
}

/** The project folder stories open unless they name another. */
export const STORY_ROOT = "C:\\Games\\story";

/** What a story's `beforeEach` receives, as far as the harness reads it. */
interface StoryContextLike {
  readonly parameters: { readonly editor?: EditorStoryParameters };
}

/** The editor Engine of the open scene and the play session, while a story runs. */
let engine: Engine | null = null;
let session: PlaySession | null = null;
let tabs: ReturnType<typeof createSceneTabs> | null = null;

/**
 * The meta's (or a story's) `beforeEach`: builds the editor `parameters.editor` describes and returns the cleanup.
 * Put it on a meta whose stories render editor components; a story overrides `parameters.editor` to vary the files.
 */
export async function withEditor({ parameters }: StoryContextLike): Promise<() => Promise<void>> {
  const options = parameters.editor ?? {};
  const undo = [registerCoreAssetKinds(), registerBuiltinPanels()];
  const fs = new MemoryFileSystem();
  const root = options.root ?? STORY_ROOT;
  const files = { "project.json": "{}", ...options.files };
  for (const [path, data] of Object.entries(files)) fs.files.set(joinPath(root, path), typeof data === "string" || ArrayBuffer.isView(data) ? (data as string | Uint8Array) : JSON.stringify(data, null, 2));
  const project = await openFolderProject(fs, root);
  const applied = applyEditorPlugins(project.settings.plugins?.disabled);
  if (applied.problems.length > 0) throw new Error(applied.problems.map((p) => p.message).join("\n"));
  resetLayout();
  useProjectAssets(project);
  currentProject.value = project;
  if (options.scene) {
    engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
    sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
    const world = engine.world;
    const opened = createSceneTabs({ world: () => world, confirm: async () => ({ ok: true }), beforeSwitch: stopPlaying });
    tabs = opened;
    await opened.open(options.scene);
    await opened.settled();
    if (openScene.peek()?.path !== options.scene) throw new Error(`Couldn't open ${options.scene}: ${status.peek()?.text ?? "unknown"}`);
  }
  return async () => {
    stopPlaying();
    setPlayState("edit");
    select([]);
    selectedAssets.value = [];
    await tabs?.closeAll();
    tabs = null;
    sceneCamera.value = null;
    engine?.dispose();
    engine = null;
    currentProject.value = null;
    status.value = null;
    for (const u of undo.reverse()) u();
  };
}

/** The project the harness opened: `editor.project.current`, typed for a story that needs it non-null. */
export function storyProject(): EditorProject {
  const p = currentProject.peek();
  if (!p) throw new Error("No project: give the meta `beforeEach: withEditor`.");
  return p;
}

/** The text of a project file as written to the story's in-memory folder (what a save wrote). */
export async function fileText(path: string): Promise<string> {
  const project = storyProject();
  return project.fileSystem!.readText(joinPath(project.root!, path));
}

/** A project file's JSON as written to the folder. */
export async function fileJson<T = Record<string, unknown>>(path: string): Promise<T> {
  return JSON.parse(await fileText(path)) as T;
}

/**
 * Play the open scene as the play bar's Play does: a real session (`startPlay`) built from the project's bootstrap,
 * headless (no game view), its Worlds listed on `editor.scene.playWorlds`. Resolves with the session's Engine.
 */
export async function startPlaying(): Promise<Engine> {
  const scene = openScene.peek();
  if (!engine || !scene) throw new Error("Nothing to play: give `parameters.editor.scene`.");
  playState.value = "starting";
  session = await startPlay({ editor: engine, scene, project: storyProject() });
  playing.value = session;
  playState.value = "playing";
  return session.engine;
}

/** Stop the session `startPlaying` began, as the play bar's Stop does (nothing when none runs). */
export function stopPlaying(): void {
  if (!session) return;
  session.stop();
  session = null;
  playing.value = null;
  playState.value = "edit";
}

/**
 * Set play mode alone, with no session (`editor.scene.playWorlds` stays empty): for a component that reads only
 * `editor.scene.playState`, such as a panel that shows "Not playing" or routes edits to the play mixer.
 */
export function setPlayState(state: "edit" | "starting" | "playing"): void {
  playState.value = state;
}

let instances = 0;

/**
 * A registered panel (a built-in one or a plugin's `registerPanel`) rendered as the dock layout renders it
 * (`panelView`), in a panel instance of its own, so its per-instance view state starts fresh in each story.
 */
export function PanelStory(props: { id: string; height?: number }): ComponentChildren {
  const instance = useMemo<PanelInstance>(() => ({ id: `story:${props.id}:${++instances}`, type: props.id, title: props.id, close() {} }), [props.id]);
  return (
    <div class="dock-panel" style={{ height: `${props.height ?? 560}px`, display: "flex", flexDirection: "column" }}>
      <PanelInstanceContext.Provider value={instance}>{panelView(props.id)}</PanelInstanceContext.Provider>
    </div>
  );
}
