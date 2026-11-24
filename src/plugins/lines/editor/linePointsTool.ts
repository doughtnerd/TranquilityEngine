// The line point tool (ADR 0396), the Lines plugin's viewport tool `myco.lines.points`: with "Edit Points" on (the
// LineRenderer card's header toggle, ADR 0266), the line being edited shows its centre line and a handle per point.
// Drag a handle to move the point in the plane facing the scene camera through it (a 2D line: its XY plane), snapped
// like the transform gizmo; Shift-click on a segment inserts a point there; Delete removes the point last grabbed (a
// line keeps two). Each change is one undo step through the component field write (ADR 0257), so Animation record mode
// can take it. Points are written in the line's own space: world, or its node's when `useWorldSpace` is off.
import type { ReadonlySignal } from "@preact/signals";
import type { GameObject } from "../../../engine";
import { type EditorOverlay, viewport } from "../../../engine/editor";
import { LineRenderer } from "../runtime";
import { invertAffine, lerp3, nearestSegment, pointsJson, rayPlane, transformPoint, type V3 } from "./pointEdit";
import { type ComponentEditMode, type OpenScene, type ViewportDrag, type ViewportToolContribution, editor, theme, viewportColors } from "../../../editor/sdk";

/** The tool's id: also its overlay id and its active-tool id. */
export const LINE_TOOL_ID = "myco.lines.points";
/** The component type the tool and its Edit Points toggle work on. */
export const LINE_TYPE = "engine.LineRenderer";

/** The tool's mode: which line's points show, non-null exactly while the tool is active. */
export const editingLine: ReadonlySignal<ComponentEditMode | null> = editor.viewport.mode<ComponentEditMode>(LINE_TOOL_ID);

const CENTRE = 0x7fd1ae;
/** How close (CSS pixels) a Shift-click must be to a segment to insert a point. */
const INSERT_REACH = 10;

/** The line being edited, if it's still there. */
function editedLine(): { node: GameObject; line: LineRenderer; editing: ComponentEditMode } | null {
  const editing = editingLine.value;
  const node = editor.scene.selection.node();
  if (!editing || !node?.transform || editor.scene.selection.active !== editing.key) return null;
  const line = node.getComponents(LineRenderer)[editing.index];
  return line ? { node, line, editing } : null;
}

/** The node's world matrix (for a line in its node's space), or null for a world-space line. */
function spaceOf(line: LineRenderer): number[] | null {
  return line.useWorldSpace ? null : Array.from(line.node.transform!.localToWorld.value);
}

/** The line's points in world space. */
function worldPoints(line: LineRenderer): V3[] {
  const m = spaceOf(line);
  return line.positions.map((p) => (m ? transformPoint(m, [p.x, p.y, p.z]) : [p.x, p.y, p.z]));
}

export const linePointsTool: ViewportToolContribution<ComponentEditMode> = {
  id: LINE_TOOL_ID,
  editsComponents: {
    types: [LINE_TYPE],
    label: "Edit Points",
    hint: "Show the line's points in the viewport: drag one to move it, Shift-click a segment to add one, Delete removes the last one grabbed",
    stopHint: "Stop editing the line's points (handles hide, the transform gizmo returns)",
  },
  install(view) {
    const { world } = view;
    /** The point last grabbed (Delete removes it), for the line being edited. */
    let grabbed: { key: string; index: number } | null = null;

    view.overlay(() => {
      const overlay: EditorOverlay = { lines: [], handles: [] };
      const edited = editedLine();
      if (!edited) return overlay;
      const points = worldPoints(edited.line);
      const accent = viewportColors(theme.peek()).handle;
      if (points.length > 1) overlay.lines.push({ points, closed: edited.line.loop, color: CENTRE });
      points.forEach((position, i) => overlay.handles.push({ id: `point:${i}`, position, color: grabbed?.key === edited.editing.key && grabbed.index === i ? CENTRE : accent }));
      return overlay;
    });

    view.onPress((p) => {
      if (p.button !== 0) return null;
      const edited = editedLine();
      const open = editor.scene.peekOpen();
      if (!edited || !open) return null;
      const handle = viewport(world).pickOverlayHandle(p.x, p.y);
      if (handle?.startsWith("point:")) {
        const index = Number(handle.slice(6));
        grabbed = { key: edited.editing.key, index };
        return startPointDrag(open, edited, index, p) ?? {};
      }
      if (!p.shift) return null;
      // Shift-click near a segment: a new point there.
      const points = worldPoints(edited.line);
      const screen = points.map((q) => viewport(world).worldToCanvas(q));
      const near = nearestSegment(screen, p.x, p.y, INSERT_REACH, edited.line.loop);
      if (!near) return null;
      const m = spaceOf(edited.line);
      const inv = m ? invertAffine(m) : null;
      const at = lerp3(points[near.index]!, points[(near.index + 1) % points.length]!, near.t);
      const local = inv ? transformPoint(inv, at) : at;
      const next = edited.line.positions.map((q) => [q.x, q.y, q.z]);
      next.splice(near.index + 1, 0, local);
      view.edit("Insert line point", (scene) => void editor.scene.writeField(placeOf(scene, edited.editing), "positions", pointsJson(next)));
      grabbed = { key: edited.editing.key, index: near.index + 1 };
      return {};
    });

    view.onKey((e) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return false;
      const edited = editedLine();
      if (!edited || !grabbed || grabbed.key !== edited.editing.key) return false;
      const positions = edited.line.positions;
      if (positions.length <= 2 || grabbed.index >= positions.length) return true; // a line keeps two points
      const next = positions.filter((_, i) => i !== grabbed!.index).map((q) => [q.x, q.y, q.z]);
      view.edit("Remove line point", (scene) => void editor.scene.writeField(placeOf(scene, edited.editing), "positions", pointsJson(next)));
      grabbed = null;
      return true;
    });

    /** Drag point `index`: in the camera-facing plane through it (a 2D line's XY plane), offset by where it was grabbed. */
    function startPointDrag(scene: OpenScene, edited: { node: GameObject; line: LineRenderer; editing: ComponentEditMode }, index: number, press: { x: number; y: number }): ViewportDrag | null {
      const ray0 = viewport(world).rayAt(press.x, press.y);
      if (!ray0) return null;
      const start = worldPoints(edited.line)[index];
      if (!start) return null;
      const normal: V3 = edited.line.mode === "2d" ? [0, 0, 1] : [-ray0.direction[0], -ray0.direction[1], -ray0.direction[2]];
      const hit0 = rayPlane(ray0.origin, ray0.direction, start, normal);
      if (!hit0) return null;
      const offset: V3 = [start[0] - hit0[0], start[1] - hit0[1], start[2] - hit0[2]];
      const m = spaceOf(edited.line);
      const inv = m ? invertAffine(m) : null;
      const base = edited.line.positions.map((q) => [q.x, q.y, q.z]);
      const place = placeOf(scene, edited.editing);
      return view.gesture("Move line point", {
        move: (p) => {
          const ray = viewport(world).rayAt(p.x, p.y);
          const hit = ray && rayPlane(ray.origin, ray.direction, start, normal);
          if (!hit) return;
          const w: V3 = [hit[0] + offset[0], hit[1] + offset[1], hit[2] + offset[2]];
          const local = inv ? transformPoint(inv, w) : w;
          const next = base.slice();
          next[index] = [view.snap(local[0]), view.snap(local[1]), edited.line.mode === "2d" ? base[index]![2]! : view.snap(local[2])];
          void editor.scene.writeField(place, "positions", pointsJson(next));
        },
      });
    }
  },
};

function placeOf(scene: OpenScene, editing: ComponentEditMode): { scene: OpenScene; path: string[]; type: string; index: number } {
  return { scene, path: editing.key.split("/"), type: LINE_TYPE, index: editing.index };
}
