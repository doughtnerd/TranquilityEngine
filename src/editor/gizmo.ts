// Transform gizmo (ADR 0022, 0026): the move/rotate/scale handles on the selection. Each drag is
// one undo step: a command group of SetField edits to the nodes' Transforms. With several nodes
// selected the gizmo sits at their centre (or on the active node's origin, with the pivot toggle)
// and acts on the topmost ones (a child of a selected node moves with it); turning or scaling
// around that point moves them too. Space, pivot and snap steps come from the scene tools.
import { effect } from "@preact/signals";
import type { Engine } from "../engine";
import { type GizmoHandlers, type GizmoOptions, type LocalPose, viewport } from "../engine/editor";
import { SetField, type NodePath, type SceneDocument } from "./document";
import { toSceneJSON } from "./fieldValues";
import { topmostKeys } from "./selectionModel";
import { cleanSnap, gizmoPivot, gizmoSpace, snapActive, snapSettings } from "./sceneTools";
import { activeViewportTool, docVersion, openScene, selectedNodes, tool, viewMode, type Tool } from "./state";

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
export function gizmoEdit(doc: SceneDocument, node: string | NodePath, mode: Mode, pose: LocalPose, field: "position" | "rotation" | "scale" = FIELDS[mode]): SetField {
  const [id, ...target] = typeof node === "string" ? [node] : node;
  const previous = doc.isPrefabInstance(id) ? doc.overrideValue(id, target, "engine.Transform", field) : doc.fieldValue(id, "engine.Transform", field);
  const value = toSceneJSON("vector3", pose[field], { field, previous });
  return new SetField(id, "engine.Transform", field, value, { target });
}

/**
 * The gizmo's settings for the targets (`keys`, in order) from the scene tools: snapping (Ctrl or
 * "always snap") with the chosen steps, world or local space, and centre or pivot placement on the
 * active node (`active`; when it isn't a target, e.g. a child of another selected node, the last target).
 */
export function gizmoOptions(mode: Mode, keys: readonly string[], active: string | null): GizmoOptions {
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
  let drag: { targets: typeof targets; mode: Mode; last: Map<string, string> } | null = null;

  const handlers: GizmoHandlers = {
    onStart() {
      const scene = openScene.value, mode = gizmoMode(tool.value);
      if (!scene || !mode || targets.length === 0) return;
      scene.stack.beginGroup(`${LABELS[mode]} ${targets.length === 1 ? targets[0].name : `${targets.length} nodes`}`);
      drag = { targets, mode, last: new Map() };
    },
    onChange(poses) {
      const scene = openScene.value;
      if (!scene || !drag) return;
      // Several nodes turn or scale around their centre, so their positions change too.
      const fields = new Set([FIELDS[drag.mode], ...(drag.targets.length > 1 ? (["position"] as const) : [])]);
      drag.targets.forEach((t, i) => {
        for (const field of fields) {
          const edit = gizmoEdit(scene.doc, t.path, drag!.mode, poses[i], field);
          const key = `${t.path.join("/")}:${field}`, json = JSON.stringify(edit.value);
          if (drag!.last.get(key) === json) continue; // the pointer moved but the value didn't (e.g. snapping)
          drag!.last.set(key, json);
          scene.stack.execute(edit);
        }
      });
    },
    onEnd() {
      if (!drag) return;
      drag = null;
      openScene.value?.stack.endGroup();
    },
  };

  const stop = effect(() => {
    docVersion.value; // nodes are rebuilt by structural edits; re-target the gizmo
    const scene = openScene.value;
    // While a viewport tool is active (ADR 0138: editing a collider, painting tiles, ADR 0142), the transform gizmo steps aside.
    const mode = activeViewportTool.value ? null : gizmoMode(tool.value);
    const selected = mode && scene ? selectedNodes() : [];
    const top = scene ? new Set(topmostKeys(scene.doc, selected.map((s) => s.key))) : new Set<string>();
    const chosen = selected.filter((s) => top.has(s.key));
    targets = chosen.map((s) => ({ path: s.path, name: s.node.name }));
    viewport(world).setGizmo(chosen.map((s) => s.node), gizmoOptions(mode ?? "translate", chosen.map((s) => s.key), selected.at(-1)?.key ?? null), handlers);
  });
  return () => {
    stop();
    viewport(world).setGizmo([], { mode: "translate", planar: false, snap: false }, null);
  };
}
