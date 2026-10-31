// Transform gizmo (ADR 0022, 0026): the move/rotate/scale handles on the selected node. Each drag
// is one undo step: a command group of SetField edits to the node's Transform.
import { effect } from "@preact/signals";
import type { Engine } from "../engine";
import { setGizmo, type GizmoHandlers, type GizmoOptions, type LocalPose } from "../engine/editor";
import { SetField, type SceneDocument } from "./document";
import { toSceneJSON } from "./fieldValues";
import { docVersion, openScene, selection, snapping, tool, viewMode, type Tool } from "./state";

type Mode = GizmoOptions["mode"];

const MODES: Record<Exclude<Tool, "select">, Mode> = { move: "translate", rotate: "rotate", scale: "scale" };
const FIELDS: Record<Mode, "position" | "rotation" | "scale"> = { translate: "position", rotate: "rotation", scale: "scale" };
const LABELS: Record<Mode, string> = { translate: "Move", rotate: "Rotate", scale: "Scale" };

/** Gizmo mode for a tool, or null when the tool shows no gizmo. */
export function gizmoMode(t: Tool): Mode | null {
  return t === "select" ? null : MODES[t];
}

/**
 * The edit one gizmo drag step makes: set the Transform field the mode changes. A 2D rotation
 * stays a single angle when the file stores it that way.
 */
export function gizmoEdit(doc: SceneDocument, nodeId: string, mode: Mode, pose: LocalPose): SetField {
  const field = FIELDS[mode];
  const previous = doc.isPrefabInstance(nodeId) ? undefined : doc.fieldValue(nodeId, "engine.Transform", field);
  const value = toSceneJSON("vector3", pose[field], { field, previous });
  return new SetField(nodeId, "engine.Transform", field, value);
}

/** Show the gizmo on the selection and turn its drags into commands. Returns a function that removes it. */
export function installGizmo(engine: Engine): () => void {
  const world = engine.world;
  let drag: { nodeId: string; mode: Mode; last: string } | null = null;

  const handlers: GizmoHandlers = {
    onStart() {
      const scene = openScene.value, nodeId = selection.value, mode = gizmoMode(tool.value);
      if (!scene || !nodeId || !mode) return;
      const name = scene.doc.node(nodeId).name ?? nodeId;
      scene.stack.beginGroup(`${LABELS[mode]} ${name}`);
      drag = { nodeId, mode, last: "" };
    },
    onChange(pose) {
      const scene = openScene.value;
      if (!scene || !drag) return;
      const edit = gizmoEdit(scene.doc, drag.nodeId, drag.mode, pose);
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
    const scene = openScene.value, id = selection.value, mode = gizmoMode(tool.value);
    const node = scene && id && mode && scene.doc.has(id) ? scene.sync.nodeFor(id) : null;
    setGizmo(world, node, { mode: mode ?? "translate", planar: viewMode.value === "2d", snap: snapping.value }, handlers);
  });
  return () => {
    stop();
    setGizmo(world, null, { mode: "translate", planar: false, snap: false }, null);
  };
}
