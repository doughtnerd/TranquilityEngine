// The editor SDK's scene surface (ADR 0147): the open scene, its tabs, the node selection,
// whether the editor is playing and the play session's Worlds (ADR 0232), read through getters over
// the shell's signals (state.ts), so they track like the signals do. `peek…` reads without tracking.
// Editing a scene goes through its `stack` with the document commands (`SetField`, ADR 0026); `edit`
// and `beginEdit` make several commands one undo step (ADR 0231).
import { computed } from "@preact/signals";
import type { World } from "../../engine/core/World";
import type { GameObject } from "../../engine/scene/GameObject";
import { idBase, uniqueId } from "../assetNodes";
import type { NodePath, SceneDocument } from "../document";
import { beginUndoStep, undoStep, type UndoStep } from "../undoStep";
import { openScene, openScenes, playing, playState, select, selectedKeys, selectedNodes, selectedPath, selectedWorldNode, selection, type OpenScene } from "../state";

export type { OpenScene, UndoStep };

/** Play mode: "edit", "starting" while the Runtime World boots, or "playing". */
export type PlayState = "edit" | "starting" | "playing";

export interface SelectionSurface {
  /** Every selected node's key (ids joined with "/" inside prefab instances), active node last. Tracks. */
  readonly keys: readonly string[];
  /** The active (last selected) node's key, or null. Tracks. */
  readonly active: string | null;
  /** `active` without tracking. */
  peekActive(): string | null;
  /** `keys` without tracking. */
  peekKeys(): readonly string[];
  /** The active node as a document path (`[id]`, or `[instanceId, innerId…]`), or null. Tracks. */
  path(): NodePath | null;
  /** The Editor World node showing the active node, if it still exists. Tracks. */
  node(): GameObject | null;
  /** Every selected node that still exists, with its path and World node, active last. Tracks. */
  nodes(): { key: string; path: NodePath; node: GameObject }[];
  /** Select `keys`; `active`, if among them, becomes the active node. An empty list clears the selection. */
  set(keys: Iterable<string>, active?: string | null): void;
}

export interface SceneSurface {
  /** The active scene tab (its document, undo stack and Editor World view), or null. Tracks. */
  readonly open: OpenScene | null;
  /** `open` without tracking. */
  peekOpen(): OpenScene | null;
  /** Every open scene tab, in tab order (the active one among them). Tracks. */
  readonly tabs: readonly OpenScene[];
  /** "edit", "starting" or "playing". Tracks. */
  readonly playState: PlayState;
  /** `playState` without tracking. */
  peekPlayState(): PlayState;
  /**
   * The play session's Worlds, in creation (and step) order; empty while editing (ADR 0232). Tracks: a
   * new list when a session starts or ends, so an `effect` reading it adds and removes per-World
   * debug overlays (`addEditorOverlay`). Read-only: draw over them and read their state; the session
   * owns them (stepping, pausing and stopping go through the play bar). Internal tier, like a
   * viewport tool's `world` (ADR 0138): a World is engine internals.
   */
  readonly playWorlds: readonly World[];
  /** `playWorlds` without tracking. */
  peekPlayWorlds(): readonly World[];
  readonly selection: SelectionSurface;
  /**
   * One undo step named `label` on `target` (the open scene when absent) of every command `fn` executes on its
   * `stack`; the step closes even when `fn` throws. False with no scene.
   */
  edit(label: string, fn: (scene: OpenScene) => void, target?: OpenScene | null): boolean;
  /**
   * Open a long-running undo step named `label` on `target` (the open scene when absent), for edits spread over
   * several events: a pointer gesture on an Inspector control, an edit that waits on file writes. `end()` records
   * everything executed meanwhile as one step; `cancel()` puts it back. Null with no scene. Viewport tools use
   * `ViewportToolContext.gesture` instead, which the host closes for them.
   */
  beginEdit(label: string, target?: OpenScene | null): UndoStep | null;
  /** An id not used in `doc`: `base`, else "<base>-2"… */
  uniqueId(doc: SceneDocument, base: string): string;
  /** A node id made from a file name: `pipe-pair.prefab.json` → `pipe-pair`, `flappyBird.png` → `flappy-bird`. */
  idBase(path: string): string;
}

const NO_WORLDS: readonly World[] = Object.freeze([]);

/** The session's live Worlds, recomputed when the session changes. */
const playWorlds = computed<readonly World[]>(() => {
  const session = playing.value;
  if (!session) return NO_WORLDS;
  return Object.freeze(session.engine.worlds().flatMap((h) => session.engine._world(h.name) ?? []));
});

export const scene: SceneSurface = {
  get open() {
    return openScene.value;
  },
  peekOpen: () => openScene.peek(),
  get tabs() {
    return openScenes.value;
  },
  get playState() {
    return playState.value;
  },
  peekPlayState: () => playState.peek(),
  get playWorlds() {
    return playWorlds.value;
  },
  peekPlayWorlds: () => playWorlds.peek(),
  selection: {
    get keys() {
      return selectedKeys.value;
    },
    get active() {
      return selection.value;
    },
    peekActive: () => selection.peek(),
    peekKeys: () => selectedKeys.peek(),
    path: selectedPath,
    node: selectedWorldNode,
    nodes: selectedNodes,
    set: select,
  },
  edit(label, fn, target) {
    const s = target === undefined ? openScene.peek() : target;
    if (!s) return false;
    undoStep(s.stack, label, () => fn(s));
    return true;
  },
  beginEdit(label, target) {
    const s = target === undefined ? openScene.peek() : target;
    return s ? beginUndoStep(s.stack, label) : null;
  },
  uniqueId,
  idBase,
};
