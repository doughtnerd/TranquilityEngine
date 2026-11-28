// The Lights 2D plugin's scene-view tool `myco.lights2d.shape` (ADR 0399, 0413, 0138): every Light2D in the edited
// scene drawn in its own colour (selected ones bright) and every ShadowCaster2D's outline, placed by their nodes' 2D
// frames. With "Edit Shape" on (the Inspector card's header toggle, ADR 0266): a point light's radius and cone-angle
// handles, a freeform light's or custom caster's point handles (a press mid-edge adds a point and drags it, Ctrl+click
// removes one). Each drag or click is one undo step through the component field write (ADR 0257). The lines and patches
// are `lightGizmoModel.ts`'s; this module places them and turns pointer moves into field writes.
import type { ReadonlySignal } from "@preact/signals";
import { GameObject, type Engine } from "../../../engine";
import { type EditorOverlay, viewport } from "../../../engine/editor";
import { frame2DOf, frameToLocal, frameToWorld, type Frame2D } from "../../../engine/scene/frame2d";
import { casterOutline } from "../../../engine/render/lights2D/casterOutlines";
import { Assets } from "../../../engine/scene/Assets";
import { splitSpriteRef } from "../../../engine/scene/importSettings";
import { spriteFrame } from "../../../engine/render/spriteFrame";
import { Light2D, ShadowCaster2D } from "../runtime";
import { dragLight, lightHandles, lightLines, type LightGizmoFields, type V2 } from "./lightGizmoModel";
import { type ComponentEditMode, type ViewportDrag, type ViewportPointer, type ViewportToolContext, type ViewportToolContribution, editor, type OpenScene, pointHandles, pressPoints, theme, viewportColors } from "../../../editor/sdk";

/** The tool's id: also its overlay id and its active-tool id. */
export const LIGHTS2D_TOOL_ID = "myco.lights2d.shape";
export const LIGHT2D_TYPE = "engine.Light2D";
export const CASTER2D_TYPE = "engine.ShadowCaster2D";

/** The tool's mode: which light or caster's handles show, non-null exactly while the tool is active. */
export const editingShape: ReadonlySignal<ComponentEditMode | null> = editor.viewport.mode<ComponentEditMode>(LIGHTS2D_TOOL_ID);

// Casters in grey-blue; lights in their own colour, dimmed when not selected.
const CASTER = 0x8fa3bf;
const CASTER_DIM = 0x4a5566;
const HANDLE_INSERT = 0x9a7bd8;

const hexOf = (c: { r: number; g: number; b: number }, k: number) => (Math.round(Math.min(1, c.r) * 255 * k) << 16) | (Math.round(Math.min(1, c.g) * 255 * k) << 8) | Math.round(Math.min(1, c.b) * 255 * k);

/** A light's gizmo fields now. */
function fieldsOf(light: Light2D, engine: Engine): LightGizmoFields {
  let spriteBox: LightGizmoFields["spriteBox"] = null;
  if (light.type === "sprite" && light.sprite) {
    const { path, slice } = splitSpriteRef(light.sprite);
    const size = path ? (engine.world.render?.textureSize?.(path) ?? null) : null;
    if (size) {
      const f = spriteFrame(Assets.importSettings(path), slice, size[0], size[1], { component: 0, project: engine.world.settings.render.pixelsPerUnit });
      spriteBox = [-f.pivot[0] * f.size[0], -f.pivot[1] * f.size[1], (1 - f.pivot[0]) * f.size[0], (1 - f.pivot[1]) * f.size[1]];
    }
  }
  return { type: light.type, innerRadius: light.innerRadius, outerRadius: light.outerRadius, innerAngle: light.innerAngle, outerAngle: light.outerAngle, shape: light.shape.map((p): V2 => [p.x, p.y]), falloffSize: light.falloffSize, spriteBox };
}

type Edited = { node: GameObject; editing: ComponentEditMode; light: Light2D; caster: null } | { node: GameObject; editing: ComponentEditMode; light: null; caster: ShadowCaster2D };

/** The light or caster being edited, if it's still there. */
function edited(): Edited | null {
  const editing = editingShape.value;
  const node = editor.scene.selection.node();
  if (!editing || !node?.transform || editor.scene.selection.active !== editing.key) return null;
  if (editing.type === LIGHT2D_TYPE) {
    const light = node.getComponents(Light2D)[editing.index];
    return light ? { node, editing, light, caster: null } : null;
  }
  const caster = node.getComponents(ShadowCaster2D)[editing.index];
  return caster ? { node, editing, light: null, caster } : null;
}

const place = (f: Frame2D, pts: readonly V2[]): [number, number, number][] => pts.map((p) => frameToWorld(f, p));

/** What to draw this frame: every light and caster in the edited scene, handles for the one being edited. */
function shapeOverlay(engine: Engine): EditorOverlay {
  const overlay: EditorOverlay = { lines: [], handles: [] };
  const selected = new Set(editor.scene.selection.nodes().map((s) => s.node));
  const textureSize = (path: string) => engine.world.render?.textureSize?.(path) ?? null;
  for (const light of GameObject.findObjectsOfType(Light2D)) {
    const node = light.node;
    if (!node.transform || !engine.world.inEditMode(node.entity)) continue;
    const on = selected.has(node);
    const f = frame2DOf(node);
    for (const line of lightLines(fieldsOf(light, engine))) overlay.lines.push({ points: place(f, line.points), closed: line.closed, color: hexOf(light.color, on ? (line.dim ? 0.6 : 1) : line.dim ? 0.25 : 0.45) });
  }
  for (const caster of GameObject.findObjectsOfType(ShadowCaster2D)) {
    const node = caster.node;
    if (!node.transform || !engine.world.inEditMode(node.entity)) continue;
    const f = frame2DOf(node);
    const o = casterOutline(engine.world, caster, textureSize);
    const color = selected.has(node) ? CASTER : CASTER_DIM;
    for (const loop of o.loops) overlay.lines.push({ points: place(f, loop as V2[]), closed: true, color });
    for (const chain of o.chains) overlay.lines.push({ points: place(f, chain as V2[]), closed: false, color });
  }
  const e = edited();
  if (e) {
    const handle = viewportColors(theme.peek()).handle; // the theme's accent
    const f = frame2DOf(e.node);
    const handles = e.light ? lightHandles(fieldsOf(e.light, engine)) : e.caster.shape === "custom" ? pointHandles(e.caster.path.map((p): V2 => [p.x, p.y]), true) : {};
    for (const [id, p] of Object.entries(handles)) overlay.handles.push({ id, position: frameToWorld(f, p), color: id.startsWith("insert:") ? HANDLE_INSERT : handle });
  }
  return overlay;
}

/** The scene view's 2D light and caster tool. */
export const lights2dTool: ViewportToolContribution<ComponentEditMode> = {
  id: LIGHTS2D_TOOL_ID,
  editsComponents: {
    types: new Set([LIGHT2D_TYPE, CASTER2D_TYPE]),
    label: "Edit Shape",
    hint: (type) =>
      type === CASTER2D_TYPE
        ? "Show handles in the viewport: drag a point of the custom path, press an edge's middle to add one, Ctrl+click to remove one"
        : "Show handles in the viewport: a point light's radii and cone angles, or a freeform light's points (press an edge's middle to add one, Ctrl+click to remove one)",
    stopHint: "Stop editing the shape (handles hide, the transform gizmo returns)",
  },
  install(view) {
    const { engine, world } = view;
    view.overlay(() => shapeOverlay(engine), { kind: "other" });
    view.onPress((p) => {
      if (p.button !== 0) return null;
      const e = edited();
      const open = editor.scene.peekOpen();
      if (!e || !open) return null;
      const handle = viewport(world).pickOverlayHandle(p.x, p.y);
      if (!handle) return null;
      return startDrag(view, open, p, handle, e, engine) ?? {};
    });
  },
};

const tidy = (n: number) => Math.round(n * 1e5) / 1e5;
const tidied = (v: unknown): unknown => (typeof v === "number" ? tidy(v) : Array.isArray(v) ? v.map(tidied) : v);

/** Press on a handle: a radius or angle drag, a point drag (after inserting one mid-edge), or a Ctrl+click removal. */
function startDrag(view: ViewportToolContext<ComponentEditMode>, scene: OpenScene, press: ViewportPointer, handle: string, e: Edited, engine: Engine): ViewportDrag | null {
  const pose = frame2DOf(e.node); // fixed for the drag
  const pointer = (m: ViewportPointer): V2 | null => {
    const w = viewport(view.world).pointOnPlane(m.x, m.y, [0, 0, 1], [0, 0, pose.position[2]]);
    return w ? frameToLocal(pose, w) : null;
  };
  const target = { scene, path: e.editing.key.split("/"), type: e.editing.type, index: e.editing.index };
  const write = (patch: Record<string, unknown>) => {
    for (const [field, value] of Object.entries(patch)) void editor.scene.writeField(target, field, tidied(value));
  };
  const snapped = (p: V2): V2 => [view.snap(p[0]), view.snap(p[1])];
  const outline = e.light ? (e.light.type === "freeform" ? { field: "shape", points: fieldsOf(e.light, engine).shape } : null) : e.caster.shape === "custom" ? { field: "path", points: e.caster.path.map((q): V2 => [q.x, q.y]) } : null;
  if (outline && (handle.startsWith("p:") || handle.startsWith("insert:"))) {
    const action = pressPoints(outline.points, handle, press.ctrl || press.meta);
    if (!action) return null;
    if ("refused" in action) {
      editor.messages.info(action.refused);
      return null;
    }
    if ("removed" in action) {
      view.edit("Remove point", () => write({ [outline.field]: action.removed }));
      return null;
    }
    const points = action.points;
    const drag = view.gesture(handle.startsWith("insert:") ? "Add point" : "Move point", {
      move: (m) => {
        const p = pointer(m);
        if (!p) return;
        points[action.drag] = snapped(p);
        write({ [outline.field]: points.map((q) => [q[0], q[1]]) });
      },
    });
    if (drag && handle.startsWith("insert:")) write({ [outline.field]: points.map((q) => [q[0], q[1]]) });
    return drag;
  }
  if (!e.light) return null;
  const light = e.light;
  const label = handle.endsWith("Angle") ? "Change light angle" : "Change light radius";
  return view.gesture(label, {
    move: (m) => {
      const p = pointer(m);
      const patch = p && dragLight(fieldsOf(light, engine), handle, p);
      if (!patch) return;
      for (const k of Object.keys(patch)) if (typeof patch[k] === "number" && k.endsWith("Radius")) patch[k] = Math.max(0, view.snap(patch[k] as number));
      write(patch);
    },
  });
}
