// The edit gate (ADR 0247): the one answer to "can this be edited now, and what does the status bar say if not?"
// for a scene document, the open scene's Svelte UI and the project's files. `whyNotEdit` gives one worded reason
// (no scene, no project, a read-only project through `readOnly.ts`, play mode); `editableNow` also reports it to the status bar;
// `editStep` / `beginEditStep` open the undo step once the gate passes (ADR 0231). Menus, tooltips, operations and
// the editor SDK's `editor.scene.edit` all go through it, so they agree.
import { untracked } from "@preact/signals";
import type { EditorProject } from "./projects";
import { readOnlyMessage } from "./readOnly";
import { currentProject, openScene, playState, status, type OpenScene } from "./state";
import { beginUndoStep, undoStep, type UndoStep } from "./undoStep";

/** What an edit changes. */
export type EditTarget =
  /** A scene document: `scene`, or the open one when absent. */
  | { readonly kind: "scene"; readonly scene?: OpenScene | null }
  /** The open scene's UI (ADR 0423 wave C): the views' `.svelte` files in the project, written through the scene's undo stack. */
  | { readonly kind: "ui" }
  /** The project's files (`project`, or the current one). `removes`: the edit deletes or moves files, which the running game may be reading. */
  | { readonly kind: "project-files"; readonly project?: EditorProject | null; readonly removes?: boolean };

/** What each target's edit is called when the caller doesn't say. */
const DEFAULT_TO_DO: Record<EditTarget["kind"], string> = { scene: "edit the scene", ui: "edit the UI", "project-files": "change its files" };

const sceneOf = (target: EditTarget): OpenScene | null => (target.kind === "scene" && target.scene !== undefined ? target.scene : openScene.value);
const projectOf = (target: EditTarget): EditorProject | null => (target.kind === "project-files" && target.project !== undefined ? target.project : currentProject.value);
const playing = () => playState.value !== "edit";

/**
 * Why `target` can't be edited now, or null when it can. `toDo` is the edit as a verb phrase ("paste nodes",
 * "delete files"), used in the read-only and play reasons. Reads the signals, so a component calling it re-renders
 * when the scene, the project or play mode changes.
 */
export function whyNotEdit(target: EditTarget, toDo: string = DEFAULT_TO_DO[target.kind]): string | null {
  switch (target.kind) {
    case "scene":
      if (!sceneOf(target)) return "open a scene first";
      return playing() ? `stop playing to ${toDo}` : null;
    case "ui": {
      const project = currentProject.value;
      if (!openScene.value || !project) return "open a scene first";
      if (!project.canSave) return readOnlyMessage(project, toDo);
      return playing() ? `stop playing to ${toDo}` : null;
    }
    case "project-files": {
      const project = projectOf(target);
      if (!project) return "open a project first";
      if (!project.canSave) return readOnlyMessage(project, toDo);
      return target.removes && playing() ? `stop playing to ${toDo}` : null;
    }
  }
}

/** A reason as a status line or tooltip: "Stop playing to paste nodes." (one full stop, also after a reason that has one). */
export const statusSentence = (reason: string): string => `${reason.charAt(0).toUpperCase()}${reason.slice(1)}${reason.endsWith(".") ? "" : "."}`;

/**
 * The scene (UI: the open scene) `target` names if it can be edited now; otherwise null, with the reason
 * in the status bar.
 */
export function editableNow(target: Exclude<EditTarget, { kind: "project-files" }>, toDo?: string): OpenScene | null;
/** The project if its files can be edited now; otherwise null, with the reason in the status bar. */
export function editableNow(target: Extract<EditTarget, { kind: "project-files" }>, toDo?: string): EditorProject | null;
export function editableNow(target: EditTarget, toDo: string = DEFAULT_TO_DO[target.kind]): OpenScene | EditorProject | null {
  const reason = untracked(() => whyNotEdit(target, toDo));
  if (reason) {
    status.value = { kind: "info", text: statusSentence(reason) };
    return null;
  }
  return target.kind === "project-files" ? projectOf(target) : sceneOf(target);
}

/**
 * Run `fn` on the target's scene as one undo step named `label` (closed even when `fn` throws), if the gate passes;
 * otherwise report why and return undefined.
 */
export function editStep<T>(target: Exclude<EditTarget, { kind: "project-files" }>, label: string, fn: (scene: OpenScene) => T, toDo?: string): T | undefined {
  const scene = editableNow(target, toDo);
  return scene ? undoStep(scene.stack, label, () => fn(scene)) : undefined;
}

/**
 * Open a long-running undo step named `label` on the target's scene (a drag, an edit waiting on writes; ADR 0231) if
 * the gate passes; the caller ends or cancels it. Otherwise report why and return null.
 */
export function beginEditStep(target: Exclude<EditTarget, { kind: "project-files" }>, label: string, toDo?: string): UndoStep | null {
  const scene = editableNow(target, toDo);
  return scene ? beginUndoStep(scene.stack, label) : null;
}
