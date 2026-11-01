// Transform gizmo (ADR 0022, 0026): the move/rotate/scale handles on the selected node. Each drag
// is one undo step: a command group of SetField edits to the node's Transform.
import { effect } from "@preact/signals";
import type { Engine } from "../engine";
import { setGizmo, type GizmoHandlers, type GizmoOptions, type LocalPose } from "../engine/editor";
import { SetField, type NodePath, type SceneDocument } from "./document";
import { toSceneJSON } from "./fieldValues";
import { docVersion, editingCollider, openScene, selectedPath, selectedWorldNode, snapping, tool, viewMode, type Tool } from "./state";

type Mode = GizmoOptions["mode"];

const MODES: Record<Exclude<Tool, "select">, Mode> = { move: "translate", rotate: "rotate", scale: "scale" };
const FIELDS: Record<Mode, "position" | "rotation" | "scale"> = { translate: "position", rotate: "rotation", scale: "scale" };
const LABELS: Record<Mode, string> = { translate: "Move", rotate: "Rotate", scale: "Scale" };

/** Gizmo mode for a tool, or null when the tool shows no gizmo. */
export function gizmoMode(t: Tool): Mode | null {
  return t === "select" ? null : MODES[t];
}

/**
 * The edit one gizmo drag step makes: set the Transform field the mode changes, on a scene node
 * or (as an override) a prefab instance or a node inside one. A 2D rotation stays a single angle
 * when the file stores it that way.
 */
export function gizmoEdit(doc: SceneDocument, node: string | NodePath, mode: Mode, pose: LocalPose): SetField {
  const [id, ...target] = typeof node === "string" ? [node] : node;
  const field = FIELDS[mode];
  const previous = doc.isPrefabInstance(id) ? doc.overrideValue(id, target, "engine.Transform", field) : doc.fieldValue(id, "engine.Transform", field);
  const value = toSceneJSON("vector3", pose[field], { field, previous });
  return new SetField(id, "engine.Transform", field, value, { target });
}

/** Show the gizmo on the selection and turn its drags into commands. Returns a function that removes it. */
export function installGizmo(engine: Engine): () => void {
  const world = engine.world;
  let drag: { path: NodePath; mode: Mode; last: string } | null = null;

  const handlers: GizmoHandlers = {
    onStart() {
      const scene = openScene.value, path = selectedPath(), mode = gizmoMode(tool.value);
      if (!scene || !path || !mode) return;
      const name = selectedWorldNode()?.name ?? path[path.length - 1];
      scene.stack.beginGroup(`${LABELS[mode]} ${name}`);
      drag = { path, mode, last: "" };
    },
    onChange(pose) {
      const scene = openScene.value;
      if (!scene || !drag) return;
      const edit = gizmoEdit(scene.doc, drag.path, drag.mode, pose);
      const key = JSON.stringify(edit.value);
      if (key === drag.last) return; // the pointer moved but the value didn't (e.g. snapping)
      drag.last = key;
      scene.stack.execute(edit);
    },
    onEnd() {
      if (!drag) return;
      drag = null;
      openScene.value?.stack.endGroup();
    },
  };

  const stop = effect(() => {
    docVersion.value; // nodes are rebuilt by structural edits; re-target the gizmo
    openScene.value;
    // While a collider's handles are showing ("Edit Collider"), the transform gizmo steps aside.
    const mode = editingCollider.value ? null : gizmoMode(tool.value);
    const node = mode ? selectedWorldNode() : null;
    setGizmo(world, node, { mode: mode ?? "translate", planar: viewMode.value === "2d", snap: snapping.value }, handlers);
  });
  return () => {
    stop();
    setGizmo(world, null, { mode: "translate", planar: false, snap: false }, null);
  };
}
