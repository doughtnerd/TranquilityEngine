// Scene tabs (ADR 0026): opening a scene or prefab in a tab of its own, switching between tabs,
// closing them, and what each tab carries while open: its view (selection and scene camera), its
// edit history on disk (ADR 0027) with the offer to restore unsaved changes, and plugins' scene-open
// migrations (ADR 0146). This module is the only writer of `openScene` and `openScenes`.
//
// The session (session.ts) owns the project and play lifecycles and hands this module its seams:
// the Editor World tabs build into, where histories are kept, and the confirm dialog.
import { batch, type ReadonlySignal } from "@preact/signals";
import { Assets, Camera, DEG2RAD, GameObject, type Engine } from "../engine";
import type { World } from "../engine/core/World";
import { CommandStack, SceneDocument, WorldSync, type SceneFile } from "./document";
import { persistHistory, sceneHistory, type HistoryLocation, type HistoryOutcome, type PersistedHistory } from "./historyPersistence";
import { errorStatus } from "./messages";
import type { ViewMode } from "./OrbitCamera";
import type { EditorPlatform } from "./projectPlace";
import type { EditorProject } from "./projects";
import { sceneOpenMigrations } from "./sdk/contributions";
import { docVersion, openScene, openScenes, sceneCamera, selectedKeys, setViewMode, status, viewMode, type OpenScene } from "./state";
import { select } from "./inspectorTarget";
import { editorTextFiles } from "./textFiles";
import type { ConfirmOptions } from "./ui/ConfirmDialog";

// --- which tabs a "close" command closes (pure) ------------------------------------------------

export type CloseMode = "this" | "others" | "all" | "right" | "left" | "saved";

/** The tabs `mode` closes (the context menu on a tab, Ctrl/Cmd+W), given the open tabs in order, the tab it was invoked on, and which have unsaved changes. */
export function tabsToClose<T>(tabs: readonly T[], target: T, mode: CloseMode, isDirty: (tab: T) => boolean): T[] {
  const at = tabs.indexOf(target);
  switch (mode) {
    case "this":
      return at < 0 ? [] : [target];
    case "others":
      return tabs.filter((t) => t !== target);
    case "all":
      return [...tabs];
    case "right":
      return at < 0 ? [] : tabs.slice(at + 1);
    case "left":
      return at < 0 ? [] : tabs.slice(0, at);
    case "saved":
      return tabs.filter((t) => !isDirty(t));
  }
}

// --- the tab lifecycle -------------------------------------------------------------------------

/** What the scene tabs need from their host (the editor session, or a test). */
export interface SceneTabSeams {
  /** The Editor World a tab's nodes are built into; null while there is none (opening does nothing). */
  world(): World | null;
  /** Where edit histories are kept (ADR 0027). Without it tabs keep no history. */
  history?: {
    /** The open project, or null (no history then). Read untracked. */
    project(): EditorProject | null;
    /** Where histories are kept; open tabs follow a change. */
    readonly location: ReadonlySignal<HistoryLocation>;
    platform(): Promise<EditorPlatform>;
  };
  /** Ask the user (closing tabs with unsaved changes, restoring unsaved changes). */
  confirm(options: ConfirmOptions): Promise<{ readonly ok: boolean }>;
  /** Called before the active tab changes: the session stops play mode. */
  beforeSwitch?(): void;
}

export interface SceneTabs {
  /**
   * Open a scene or prefab in a tab of its own, or switch to its tab if it's open already. Other
   * tabs keep their unsaved changes. If it can't be opened, the previous tab comes back and the
   * status bar says why. The tab opens once its saved history is read (ADR 0316: no edit can race the load); the
   * restore offer and migrations follow in the background (`settled`).
   */
  open(path: string): Promise<void>;
  /** Switch to the open tab `scene` (unsaved changes in the others stay). */
  activate(scene: OpenScene): void;
  /**
   * Close tabs, asking once about all the ones with unsaved changes (cancelling closes none; the
   * changes stay in each one's edit history). Closing the active tab switches to its neighbour.
   * Returns how many closed.
   */
  close(scenes: readonly OpenScene[]): Promise<number>;
  /** Close every tab without asking (the project is closing) and stop saving their histories. */
  closeAll(): Promise<void>;
  /** Resolves once background work is done: opened tabs' history, restore offer and migrations, closed tabs' last history writes. */
  settled(): Promise<void>;
}

/** What a tab remembers while another is active: its selection and the scene view's camera. */
interface TabView {
  selection: readonly string[];
  camera: { mode: ViewMode; focus: number[]; distance: number; yaw: number; pitch: number } | null;
}
const tabViews = new WeakMap<OpenScene, TabView>();
/** Each open tab's edit history on disk (ADR 0027, 0316), kept saving while the tab is open. */
const histories = new Map<OpenScene, PersistedHistory>();

/** Background work in flight: opened tabs' history, restore offer and migrations, closed tabs' last history writes. */
const running = new Set<Promise<void>>();
function track(work: Promise<void>): void {
  const done = work.catch((err: unknown) => console.warn("[editor] scene tab work failed:", err));
  running.add(done);
  void done.finally(() => running.delete(done));
}

/** Whether `scene` is still an open tab: async work started for it (history, prompts, migrations) stops once it isn't. */
const isOpen = (scene: OpenScene) => openScenes.peek().includes(scene);

/** The one place `openScene` and `openScenes` are written. */
function show(tabs: readonly OpenScene[], active: OpenScene | null): void {
  batch(() => {
    openScenes.value = tabs;
    openScene.value = active;
  });
}

/** A scene file read into a document and its command stack, not yet built into a World. */
interface ReadScene {
  doc: SceneDocument;
  stack: CommandStack;
}

/** Read `path` into a document and its command stack. Throws if it can't. */
function read(path: string): ReadScene {
  const doc = new SceneDocument(Assets.json<SceneFile>(path), path);
  const stack = new CommandStack(doc);
  stack.files = editorTextFiles; // UI edits (Svelte sources, ADR 0419 wave C) write their files in the same history
  return { doc, stack };
}

/** Build a read scene's nodes in `world`. Throws (leaving nothing behind) if it can't. */
function build(world: World, path: string, { doc, stack }: ReadScene): OpenScene {
  const sync = new WorldSync(world, doc);
  try {
    sync.build();
  } catch (err) {
    sync.dispose();
    throw err;
  }
  sync.attach(stack);
  stack.subscribe(() => docVersion.value++);
  return { path, doc, stack, sync };
}

/** Make a freshly loaded `scene` the active tab of `tabs`, and frame it in the scene view. */
function enter(tabs: readonly OpenScene[], scene: OpenScene, world: World): void {
  show(tabs, scene);
  select([]);
  docVersion.value++;
  frameSceneCamera(world);
}

/** Put the active tab aside: remember its view, and take its nodes out of the Editor World. */
function putAside(scene: OpenScene): void {
  const orbit = sceneCamera.peek();
  tabViews.set(scene, {
    selection: selectedKeys.peek(),
    camera: orbit ? { mode: viewMode.peek(), focus: orbit.focusPoint.toArray(), distance: orbit.distance, yaw: orbit.yaw, pitch: orbit.pitch } : null,
  });
  scene.sync.dispose();
}

/** Make `scene` the active tab of `tabs` (the previous one already put aside): rebuild its nodes and view. */
function bringBack(tabs: readonly OpenScene[], scene: OpenScene): void {
  try {
    scene.sync.build();
  } catch (err) {
    status.value = errorStatus(`Couldn't show ${scene.path}`, err);
  }
  show(tabs, scene);
  const view = tabViews.get(scene);
  select((view?.selection ?? []).filter((k) => scene.doc.has(k.split("/")[0])));
  const orbit = sceneCamera.peek();
  if (view?.camera && orbit) {
    setViewMode(view.camera.mode);
    orbit.yaw = view.camera.yaw;
    orbit.pitch = view.camera.pitch;
    orbit.focus(view.camera.focus, view.camera.distance);
  }
  docVersion.value++;
}

/** Drop what an open tab carries (its view, its history) as it closes. */
function forget(scene: OpenScene): void {
  tabViews.delete(scene);
  const h = histories.get(scene);
  histories.delete(scene);
  if (h) track(h.stop());
}

/** Match the scene view to the scene's own camera: 2D for orthographic scenes, centred on it. */
function frameSceneCamera(world: World): void {
  const orbit = sceneCamera.value;
  if (!orbit) return;
  const camera = GameObject.findObjectsOfType(Camera).find((c) => world.inEditMode(c.node.entity));
  if (!camera) return;
  const p = camera.transform!.worldPosition;
  if (camera.projection === "orthographic") {
    setViewMode("2d");
    orbit.focus([p.x, p.y, 0], (camera.orthographicSize * 1.15) / Math.tan((orbit.fieldOfView * DEG2RAD) / 2));
  } else {
    orbit.focus([p.x, p.y, p.z]);
  }
}

export function createSceneTabs(seams: SceneTabSeams): SceneTabs {
  function activate(scene: OpenScene): void {
    const current = openScene.peek();
    if (current === scene || !isOpen(scene)) return;
    seams.beforeSwitch?.();
    if (current) putAside(current);
    bringBack(openScenes.peek(), scene);
  }

  /** Close one tab with no questions. */
  function closeNow(scene: OpenScene): boolean {
    if (!isOpen(scene)) return false;
    const list = openScenes.peek();
    const at = list.indexOf(scene);
    const rest = list.filter((s) => s !== scene);
    forget(scene);
    if (openScene.peek() !== scene) {
      show(rest, openScene.peek()); // an inactive tab has no nodes in the World
      return true;
    }
    seams.beforeSwitch?.();
    scene.sync.dispose();
    const next = rest[Math.min(at, rest.length - 1)];
    if (next) bringBack(rest, next);
    else {
      show(rest, null);
      select([]);
      docVersion.value++;
    }
    return true;
  }

  /**
   * What the tab's saved history held, once it's open (ADR 0027). If the editor closed with unsaved changes,
   * offer them back; declining keeps them in the history (redo, History panel).
   */
  async function offerHistory(scene: OpenScene, outcome: HistoryOutcome): Promise<void> {
    if (outcome.kind === "set aside" && outcome.why === "changed") {
      status.value = { kind: "info", text: `${scene.path} changed outside the editor, so its saved edit history no longer applies; starting a new one.` };
    }
    if (outcome.kind !== "adopted" || outcome.ahead === null) return;
    const r = scene.stack.allStates.find((x) => x.seq === outcome.ahead);
    if (!r) return;
    const answer = await seams.confirm({
      title: "Restore unsaved changes?",
      message: `${scene.path} had unsaved changes when the editor last closed (the last was "${r.label}", ${new Date(r.time).toLocaleString()}).`,
      confirmLabel: "Restore",
      cancelLabel: "Keep saved version",
      danger: false,
    });
    if (!isOpen(scene)) return;
    if (answer.ok) {
      scene.stack.jumpTo(r.seq);
      status.value = { kind: "info", text: `Restored the unsaved changes to ${scene.path}.` };
    } else {
      status.value = { kind: "info", text: "Kept the saved version. The unsaved changes are still in the edit history (redo, or the History panel)." };
    }
  }

  /** Plugins' work on a tab that just opened (ADR 0146), one at a time, while it stays open. */
  async function migrate(scene: OpenScene): Promise<void> {
    for (const m of sceneOpenMigrations.list()) {
      if (!isOpen(scene)) return;
      try {
        await m.migrate(scene);
      } catch (err) {
        status.value = errorStatus(`Couldn't ${m.failure} ${scene.path}`, err);
      }
    }
  }

  async function afterOpen(scene: OpenScene, outcome: HistoryOutcome): Promise<void> {
    await offerHistory(scene, outcome);
    await migrate(scene);
  }

  /** Scenes being read (their history loading), by path, so opening one twice makes one tab. */
  const opening = new Map<string, Promise<void>>();
  /** Bumped by `closeAll`: a scene still loading its history when the project closes doesn't open. */
  let epoch = 0;

  /** Start keeping `stack`'s history, or null without a project. */
  function startHistory(path: string, stack: CommandStack): PersistedHistory | null {
    const h = seams.history, project = h?.project();
    if (!h || !project) return null;
    return persistHistory({
      project,
      kind: "scene",
      tree: sceneHistory(stack, path),
      path: () => path,
      location: h.location,
      platform: h.platform,
      saveFailed: (err) => (status.value = errorStatus(`Couldn't save the edit history for ${path}`, err)),
    });
  }

  async function openNew(path: string): Promise<void> {
    const world = seams.world();
    if (!world) return;
    let file: ReadScene;
    try {
      file = read(path);
    } catch (err) {
      status.value = errorStatus(`Couldn't open ${path}`, err);
      return;
    }
    // The saved history first, so the tab is never editable before it's adopted or set aside.
    const started = epoch;
    const history = startHistory(path, file.stack);
    const outcome: HistoryOutcome = history ? await history.loaded : { kind: "new" };
    if (epoch !== started || seams.world() !== world) {
      if (history) track(history.stop());
      return;
    }
    seams.beforeSwitch?.();
    const previous = openScene.peek();
    if (previous) putAside(previous);
    let scene: OpenScene;
    try {
      scene = build(world, path, file);
    } catch (err) {
      if (history) track(history.stop());
      status.value = errorStatus(`Couldn't open ${path}`, err);
      if (previous) bringBack(openScenes.peek(), previous);
      return;
    }
    if (history) {
      histories.set(scene, history);
      scene.stack.subscribe(() => history.save());
    }
    status.value = null;
    enter([...openScenes.peek(), scene], scene, world);
    track(afterOpen(scene, outcome));
  }

  return {
    async open(path) {
      if (openScene.peek()?.path === path) return;
      const tab = openScenes.peek().find((s) => s.path === path);
      if (tab) return activate(tab);
      const pending = opening.get(path);
      if (pending) return pending;
      const work = openNew(path).finally(() => opening.delete(path));
      opening.set(path, work);
      return work;
    },

    activate,

    async close(scenes) {
      const open = scenes.filter(isOpen);
      const dirty = open.filter((s) => s.stack.dirty);
      if (dirty.length > 0) {
        const names = dirty.map((s) => s.path);
        const answer = await seams.confirm(
          dirty.length === 1
            ? {
                title: `Close ${names[0].split("/").pop()}?`,
                message: `${names[0]} has unsaved changes. Closing it without saving discards them; they stay in its edit history and are offered back when you open it again.`,
                confirmLabel: "Close without saving",
                cancelLabel: "Cancel",
              }
            : {
                title: `Close ${open.length} scenes?`,
                message: `${dirty.length} scenes have unsaved changes. Closing them without saving discards the changes; they stay in each scene's edit history and are offered back when it opens again.`,
                items: names,
                confirmLabel: "Close without saving",
                cancelLabel: "Cancel",
              },
        );
        if (!answer.ok) return 0;
      }
      let closed = 0;
      for (const scene of open) if (closeNow(scene)) closed++;
      return closed;
    },

    async closeAll() {
      epoch++;
      openScene.peek()?.sync.dispose(); // the others were put aside already
      show([], null);
      select([]);
      const detaching = [...histories.values()].map((h) => h.stop());
      histories.clear();
      await Promise.all(detaching);
    },

    async settled() {
      while (running.size > 0) await Promise.all(running);
    },
  };
}

/**
 * Open a scene file in place of the active tab, with no history (headless tools and tests: one
 * scene in `engine`'s Editor World), and frame it in the scene view. Throws if it can't load,
 * leaving no active tab.
 */
export function openSceneFile(engine: Engine, path: string): void {
  const world = engine.world;
  const tabs = openScenes.peek();
  const previous = openScene.peek();
  if (previous) {
    forget(previous);
    previous.sync.dispose();
  }
  const rest = tabs.filter((s) => s !== previous);
  let scene: OpenScene;
  try {
    scene = build(world, path, read(path));
  } catch (err) {
    show(rest, null);
    docVersion.value++;
    throw err;
  }
  const at = previous ? tabs.indexOf(previous) : -1;
  enter(at < 0 ? [...rest, scene] : tabs.map((s) => (s === previous ? scene : s)), scene, world);
}
