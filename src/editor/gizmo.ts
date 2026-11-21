// Transform gizmo (ADR 0022, 0026): the move/rotate/scale handles on the selection. Each drag is
// one undo step (ADR 0231's `UndoStep`) of SetField edits to the nodes' Transforms, and Escape during
// the drag puts the nodes back, as it does for the viewport tools' gestures. With several nodes
// selected the gizmo sits at their centre (or on the active node's origin, with the pivot toggle)
// and acts on the topmost ones (a child of a selected node moves with it); turning or scaling
// around that point moves them too. Space, pivot and snap steps come from the scene tools.
import { effect } from "@preact/signals";
import type { Engine } from "../engine";
import { type GizmoHandlers, type GizmoOptions, type LocalPose, viewport } from "../engine/editor";
import { SetField, type NodePath, type SceneDocument } from "./document";
import { FIELD_KINDS, noNodeRefs } from "./fields/kinds";
import { topmostKeys } from "./selectionModel";
import { cleanSnap, gizmoPivot, gizmoSpace, snapActive, snapSettings } from "./sceneTools";
import { isEditable } from "./editable";
import { activeViewportTool, docVersion, openScene, selectedNodes, tool, viewMode, type Tool } from "./state";
import { writeComponentField } from "./componentField";
import { beginEditStep } from "./editGate";
import type { UndoStep } from "./undoStep";

type Mode = GizmoOptions["mode"];

const MODES: Record<Exclude<Tool, "select">, Mode> = { move: "translate", rotate: "rotate", scale: "scale" };
const FIELDS: Record<Mode, "position" | "rotation" | "scale"> = { translate: "position", rotate: "rotation", scale: "scale" };
const LABELS: Record<Mode, string> = { translate: "Move", rotate: "Rotate", scale: "Scale" };

/** Gizmo mode for a tool, or null when the tool shows no gizmo. */
function gizmoMode(t: Tool): Mode | null {
  return t === "select" ? null : MODES[t];
}

/**
 * The edit one gizmo drag step makes: set the Transform field the mode changes, on a scene node
 * or (as an override) a prefab instance or a node inside one. A rotation is written as a quaternion
 * (ADR 0163).
 */
export function gizmoEdit(doc: SceneDocument, node: string | NodePath, mode: Mode, pose: LocalPose, field: "position" | "rotation" | "scale" = FIELDS[mode]): SetField {
  const [id, ...target] = typeof node === "string" ? [node] : node;
  return new SetField(id, "engine.Transform", field, poseValue(pose, field), { target });
}

/** A pose's Transform field in scene-file form (a rotation as a quaternion). */
const poseValue = (pose: LocalPose, field: "position" | "rotation" | "scale"): unknown => FIELD_KINDS[field === "rotation" ? "quaternion" : "vector3"].toJSON(pose[field], noNodeRefs);

/**
 * The gizmo's settings for the targets (`keys`, in order) from the scene tools: snapping (Ctrl or
 * "always snap") with the chosen steps, world or local space, and centre or pivot placement on the
 * active node (`active`; when it isn't a target, e.g. a child of another selected node, the last target).
 */
function gizmoOptions(mode: Mode, keys: readonly string[], active: string | null): GizmoOptions {
  const snap = cleanSnap(snapSettings.value);
  const at = active === null ? -1 : keys.indexOf(active);
  return {
    mode,
    planar: viewMode.value === "2d",
    snap: snapActive.value,
    snapSteps: { move: snap.move, rotate: snap.rotate, scale: snap.scale },
    space: gizmoSpace.value,
    pivot: gizmoPivot.value,
    activeIndex: at >= 0 ? at : keys.length - 1,
  };
}

/** Show the gizmo on the selection and turn its drags into commands. Returns a function that removes it. */
export function installGizmo(engine: Engine): () => void {
  const world = engine.world;
  /** The nodes the gizmo is on (set by the effect below), and the drag in progress. */
  let targets: { path: NodePath; name: string }[] = [];
  let drag: { targets: typeof targets; mode: Mode; step: UndoStep } | null = null;

  const handlers: GizmoHandlers = {
    onStart() {
      const scene = openScene.value, mode = gizmoMode(tool.value);
      if (!scene || !mode || targets.length === 0) return;
      // Through the edit gate: during play the scene is read-only (ADR 0257).
      const step = beginEditStep({ kind: "scene", scene }, `${LABELS[mode]} ${targets.length === 1 ? targets[0].name : `${targets.length} nodes`}`);
      if (step) drag = { targets, mode, step };
    },
    onChange(poses) {
      const scene = openScene.value;
      if (!scene || !drag?.step.open) return;
      // Several nodes turn or scale around their centre, so their positions change too.
      const fields = new Set([FIELDS[drag.mode], ...(drag.targets.length > 1 ? (["position"] as const) : [])]);
      drag.targets.forEach((t, i) => {
        // The component field write skips a value already stored (the pointer moved but the value didn't, e.g. snapping).
        for (const field of fields) writeComponentField({ scene, path: t.path, type: "engine.Transform" }, field, poseValue(poses[i], field));
      });
    },
    onEnd() {
      const d = drag;
      drag = null;
      d?.step.end();
    },
  };

  /** Put the nodes on the gizmo where they were when the drag began, and let go of the handle. */
  const cancelDrag = () => {
    const d = drag;
    if (!d) return;
    drag = null;
    d.step.cancel();
    viewport(world).setGizmo([], { mode: d.mode, planar: false, snap: false }, null); // releases the handle
    place();
  };
  const onKey = (event: Event) => {
    const e = event as KeyboardEvent;
    if (e.key !== "Escape" || !drag || isEditable(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cancelDrag();
  };
  const keys: EventTarget | null = typeof window === "undefined" ? null : window;
  keys?.addEventListener("keydown", onKey, true);

  /** Put the gizmo on the selection's topmost nodes, with the mode and options the tools choose. */
  const place = () => {
    docVersion.value; // nodes are rebuilt by structural edits; re-target the gizmo
    const scene = openScene.value;
    // While a viewport tool is active (ADR 0138: editing a collider, painting tiles, ADR 0142), the transform gizmo steps aside.
    const mode = activeViewportTool.value ? null : gizmoMode(tool.value);
    const selected = mode && scene ? selectedNodes() : [];
    const top = scene ? new Set(topmostKeys(scene.doc, selected.map((s) => s.key))) : new Set<string>();
    const chosen = selected.filter((s) => top.has(s.key));
    targets = chosen.map((s) => ({ path: s.path, name: s.node.name }));
    viewport(world).setGizmo(chosen.map((s) => s.node), gizmoOptions(mode ?? "translate", chosen.map((s) => s.key), selected.at(-1)?.key ?? null), handlers);
  };
  const stop = effect(place);
  return () => {
    stop();
    keys?.removeEventListener("keydown", onKey, true);
    handlers.onEnd(); // a drag cut short by removal keeps what it did
    viewport(world).setGizmo([], { mode: "translate", planar: false, snap: false }, null);
  };
}
