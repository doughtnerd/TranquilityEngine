// The editor SDK's scene surface (ADR 0147): the open scene, its tabs, the node selection,
// whether the editor is playing and the play session's Worlds (ADR 0232), read through getters over
// the shell's signals (state.ts), so they track like the signals do. `peek…` reads without tracking.
// A component field is written with `writeField` (ADR 0257: the edit gate, overrides on prefab instances,
// unchanged values skipped; in a scene document or a live World) and dragged with `beginFieldDrag`; `edit` and
// `beginEdit` make several writes one undo step (ADR 0231). All of them refuse through the edit gate when the scene
// can't be edited now (no scene, play mode; ADR 0247), which `whyNotEdit` tells beforehand. New nodes come from contributions (Hierarchy create
// entries, asset kinds' node templates), which the shell's node insertion places and gives ids (ADR 0246).
import { computed } from "@preact/signals";
import type { World } from "../../engine/core/World";
import type { GameObject } from "../../engine/scene/GameObject";
import { beginFieldDrag, writeComponentField, type ComponentPlace, type DocumentComponent, type FieldDrag, type LiveComponent } from "../componentField";
import type { NodePath } from "../document";
import { beginEditStep, editStep, whyNotEdit } from "../editGate";
import type { UndoStep } from "../undoStep";
import { openScene, openScenes, playing, playState, selectedKeys, selectedNodes, selectedPath, selectedWorldNode, selection, type OpenScene } from "../state";
import { select } from "../inspectorTarget";

export type { OpenScene, UndoStep, ComponentPlace, DocumentComponent, LiveComponent, FieldDrag };

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
   * Why `target` (the open scene when absent) can't be edited now, or null when it can: no scene, or play mode (the
   * edit gate, ADR 0247). Tracks. `edit` and `beginEdit` refuse for the same reasons; read this to know beforehand
   * (a tool that only works while it can edit).
   */
  whyNotEdit(target?: OpenScene | null): string | null;
  /**
   * One undo step named `label` on `target` (the open scene when absent) of every command `fn` executes on its
   * `stack`; the step closes even when `fn` throws. False, with the reason in the status bar, when the scene can't
   * be edited now (`whyNotEdit`: no scene, or playing).
   */
  edit(label: string, fn: (scene: OpenScene) => void, target?: OpenScene | null): boolean;
  /**
   * Open a long-running undo step named `label` on `target` (the open scene when absent), for edits spread over
   * several events: a pointer gesture on an Inspector control, an edit that waits on file writes. `end()` records
   * everything executed meanwhile as one step; `cancel()` puts it back. Null, with the reason in the status bar,
   * when the scene can't be edited now (`whyNotEdit`). Viewport tools use `ViewportToolContext.gesture` instead,
   * which the host closes for them.
   */
  beginEdit(label: string, target?: OpenScene | null): UndoStep | null;
  /**
   * Set one field of a component (ADR 0257): `place` is a node path in a scene document (`{ scene, path, type,
   * index }`) or a node of a live World (`{ node, type, index }`); `value` is scene-file JSON (numbers, strings, arrays,
   * `asset:` paths). A document write goes through the edit gate (refused during play, with the reason in the status
   * bar), is an override inside a prefab instance and joins the open undo step (`edit`, `beginEdit`, a drag), else it
   * is a step of its own. A value already stored is skipped. Returns why it couldn't, or null.
   */
  writeField(place: ComponentPlace, field: string, value: unknown): string | null;
  /**
   * Start a drag on a component's fields named `label`: in a document, one undo step through the edit gate (null when
   * refused); on a live node, `cancel()` writes `fields` back as they were. Inspector controls use `useFieldDrag`;
   * viewport tools use `ViewportToolContext.gesture`.
   */
  beginFieldDrag(place: ComponentPlace, label: string, fields?: readonly string[]): FieldDrag | null;
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
  whyNotEdit: (target) => whyNotEdit({ kind: "scene", scene: target }),
  edit(label, fn, target) {
    let ran = false;
    editStep({ kind: "scene", scene: target }, label, (s) => ((ran = true), fn(s)));
    return ran;
  },
  beginEdit: (label, target) => beginEditStep({ kind: "scene", scene: target }, label),
  writeField: writeComponentField,
  beginFieldDrag,
};
