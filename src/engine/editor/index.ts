/**
 * Editor-only access to engine internals (ADR 0026). Not exported from `src/engine/index.ts` and
 * not part of the engine library's type declarations: game code must never import this. The
 * scene editor (`src/editor/`) imports it by path.
 */
import { Component } from "../core/Component";
import { _setScriptAssetRefs } from "../scene/warmUp";
import { _undefineComponent, getDataComponentDef, listDataComponentIds, type DataComponentDef, type ScalarType } from "../core/data";
import { _undefineSystem } from "../core/systems";
import { Mat4, Vector3 } from "../core/math";
import { _setReplacingRegistrations, _takeRecordedRegistrations, _unregisterComponent, getComponentClass, getComponentId, getFields, listComponentIds, type ComponentClass, type FieldOptions, type FieldType, type ScriptRegistrations } from "../core/registry";
import { World } from "../core/World";
import type { Engine, EngineTiming, WorldViewState } from "../core/Engine";
import type { WorldConfig } from "../core/worlds";
import { Input } from "../input/Input";
import { localPoseFromMatrix, matrixFrom, type LocalPose } from "../render/gizmoMath";
import type { NavigationWorld } from "../nav/NavigationWorld";
import { NavAgent } from "../nav/components";
import type { EditorColors, EditorOverlay, GizmoHandlers, GizmoOptions, ScreenRect } from "../render/RenderSurface";
import { Camera, MeshRenderer, SpriteRenderer } from "../render/components";
import { meshesIfLoaded, type ModelMesh } from "../scene/models";
import type { GameObject } from "../scene/GameObject";
import type { UICanvas, UIComponentType } from "../ui/components";
import { SceneInstance, _instantiatedPrefabOf, applyTransform, assignField, instantiateFile, type InstantiateHooks, type SceneFile } from "../scene/SceneLoader";
import type { Schema } from "../core/data";
import { _undefineInput, _writeSyntheticInput, definedInputs } from "../net/input";
import { clientReplication } from "../net/replication/client";
import { predictionStats, type PredictionStats } from "../net/prediction";
import { serverReplication } from "../net/replication/server";
import { netSession, type NetPeer, type NetTraffic } from "../net/session";
import type { LinkConditions } from "../net/Transport";

export type { InstantiateHooks } from "../scene/SceneLoader";
// The preview renderers run on Babylon.js (ADR 0075, 0081); see render/previewRouting.ts.
export { MaterialPreview, NodePreviewRenderer, loadParticleEffectPreview, type PreviewMesh } from "../render/previewRouting";
export type { ParticleEffectPreviewApi as ParticleEffectPreview, PreviewBackground } from "../render/previewTypes";

/** One node of a World, as listed by `listNodes`. */
export interface NodeInfo {
  readonly node: GameObject;
  readonly entity: number;
  /** Depth below the listing root (the root itself is 0). */
  readonly depth: number;
  readonly name: string;
  /** Scene-file id the node was created from ("" for nodes made in code). */
  readonly id: string;
  readonly active: boolean;
  readonly activeInHierarchy: boolean;
  readonly parent: GameObject | null;
  readonly children: readonly GameObject[];
  readonly isSceneNode: boolean;
  readonly isComponentNode: boolean;
}

/** Every node under `root` (default: the World root, included), parents before children. */
export function listNodes(world: World, root: GameObject = world.root): NodeInfo[] {
  const out: NodeInfo[] = [];
  const visit = (node: GameObject, depth: number): void => {
    const e = node.entity;
    if (world.isPendingDestroy(e)) return;
    const children = node.children;
    out.push({
      node,
      entity: e,
      depth,
      name: node.name,
      id: node.id,
      active: node.active,
      activeInHierarchy: node.activeInHierarchy,
      parent: node.parent,
      children,
      isSceneNode: node.isSceneNode,
      isComponentNode: node.isComponentNode,
    });
    for (const c of children) visit(c, depth + 1);
  };
  visit(root, 0);
  return out;
}

/** A field of a component with its declared type and live value. */
export interface FieldValue {
  readonly name: string;
  /** Declared type: a field type (`Number`, `Vector3`, `GameObject`, `AssetRef`…) or a data component scalar type. */
  readonly type: FieldType | ScalarType;
  readonly value: unknown;
  /** The field's declared options (choices for a dropdown, netcode settings), if any. */
  readonly options?: FieldOptions;
}

export type ComponentKind = "transform" | "behavior" | "data";

/** One component on a node, as listed by `listComponents`. */
export interface ComponentInfo {
  readonly kind: ComponentKind;
  /** Registered id, e.g. `engine.Transform`, `engine.SpriteRenderer`, `game.Scroller`. */
  readonly type: string;
  /** Which component of this type on the node (0 for the first). */
  readonly index: number;
  /** The live instance for behaviors and built-ins; null for Transform and data components. */
  readonly component: Component | null;
  readonly enabled: boolean;
  readonly fields: readonly FieldValue[];
}

/**
 * Transform first (if any), then attached components in order, then data components. Values are
 * live references for engine objects (vectors, nodes) and copies for Transform values.
 */
export function listComponents(node: GameObject): ComponentInfo[] {
  const world = node.world;
  const out: ComponentInfo[] = [];
  const t = node.transform;
  if (t) {
    out.push({
      kind: "transform",
      type: "engine.Transform",
      index: 0,
      component: null,
      enabled: true,
      fields: [
        { name: "position", type: Vector3, value: t.position.clone() },
        { name: "rotation", type: Vector3, value: t.eulerAngles },
        { name: "scale", type: Vector3, value: t.scale.clone() },
      ],
    });
  }
  const counts = new Map<string, number>();
  for (const c of world._componentsOf(node.entity)) {
    const cls = c.constructor as ComponentClass;
    if (c instanceof SceneInstance) continue;
    const type = getComponentId(cls) ?? cls.name;
    const index = counts.get(type) ?? 0;
    counts.set(type, index + 1);
    const values = c as unknown as Record<string, unknown>;
    out.push({
      kind: "behavior",
      type,
      index,
      component: c,
      enabled: c.enabled,
      fields: getFields(cls).map((f) => (f.options ? { name: f.name, type: f.type, value: values[f.name], options: f.options } : { name: f.name, type: f.type, value: values[f.name] })),
    });
  }
  for (const def of world._dataComponentsOf(node.entity)) {
    const view = node.getData(def) as Record<string, number>;
    out.push({
      kind: "data",
      type: def.id,
      index: 0,
      component: null,
      enabled: true,
      fields: def.fields.map((f) => ({ name: f, type: def.schema[f], value: view[f] })),
    });
  }
  return out;
}

/** Mark `node` as the root of a scene being edited: scripts, systems and audio stay still inside it. */
export function setEditMode(node: GameObject, value = true): void {
  node.world.setEditMode(node.entity, value);
}

/**
 * Create a scene node under the World root for `file` and instantiate it in edit mode (no
 * scripts run). Physics isn't created. `hooks.onNode` reports each node's document path.
 */
export function instantiateDocument(world: World, file: SceneFile, path: string, hooks?: InstantiateHooks): GameObject {
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.(scene\.|prefab\.)?json$/, "");
  const sceneNode = world._createNode(name, world.root.entity, { transform: false });
  world.setSceneNode(sceneNode.entity);
  world.setEditMode(sceneNode.entity, true);
  world._batch(() => sceneNode.addBehavior(SceneInstance, { source: path }));
  instantiateFile(world, file, sceneNode, path, hooks);
  return sceneNode;
}

/** Instantiate the nodes of `file` under `parent` (used to rebuild part of an edited scene). */
export function instantiateNodes(world: World, file: SceneFile, parent: GameObject, path: string, hooks?: InstantiateHooks): GameObject[] {
  return instantiateFile(world, file, parent, path, hooks);
}

/** Destroy a node and its subtree right away. Only call between frames (editor commands). */
export function destroyNow(node: GameObject): void {
  if (!node.isValid) return;
  node.world._destroyNode(node.entity);
  node.world._flushDestroyed();
}

/**
 * Run `world`'s deferred destroys and component removals now (step 10 of a frame), so a node or
 * component the editor destroyed in a live World goes away while the session is paused (ADR 0124).
 * Only call between frames.
 */
export function applyDestroys(world: World): void {
  world._flushDestroyed();
}

/** Reparent without changing the local transform, then move to `index` among the new siblings. */
export function moveNode(node: GameObject, parent: GameObject, index: number): void {
  node.world._setParent(node.entity, parent.entity, false);
  node.world._setSiblingIndex(node.entity, index);
}

/** Move a node to `index` among its siblings. */
export function setSiblingIndex(node: GameObject, index: number): void {
  node.world._setSiblingIndex(node.entity, index);
}

/**
 * Write one serialized field value (scene-file JSON) onto a live component of `node`, the same
 * way the scene loader would. `type` is a component id; `index` picks among several of that type.
 * `$node` references go through `resolve`. Returns false if the component or field isn't there.
 */
export function writeField(
  node: GameObject,
  type: string,
  index: number,
  field: string,
  raw: unknown,
  resolve: (id: string) => GameObject | null = () => null,
): boolean {
  if (type === "engine.Transform") {
    if (!node.transform) return false;
    applyTransform(node, { [field]: raw });
    return true;
  }
  const def: DataComponentDef | undefined = getDataComponentDef(type);
  if (def) {
    const view = node.getData(def) as Record<string, number> | null;
    if (!view || !def.fields.includes(field)) return false;
    view[field] = Number(raw);
    return true;
  }
  const cls = getComponentClass(type) as (abstract new () => Component) | undefined;
  const c = cls ? node.getBehaviors(cls)[index] : undefined;
  if (!c) return false;
  const info = getFields(c.constructor as ComponentClass).find((f) => f.name === field);
  if (!info) return false;
  assignField(c, info, raw, (id, assign) => assign(resolve(id)));
  return true;
}

// --- Viewport (ADR 0022) -----------------------------------------------------------------------

/** The canvas the World renders into, or null when headless. */
export function viewportCanvas(world: World): HTMLCanvasElement | null {
  return world.render?.canvas ?? null;
}

/**
 * Nodes whose renderers lie under a canvas point (CSS pixels, origin top-left), topmost first.
 * Only nodes with a SpriteRenderer or Text are pickable. Empty when headless.
 */
export function pick(world: World, x: number, y: number): GameObject[] {
  return world.render?.pick(world, x, y) ?? [];
}

export type { ScreenRect } from "../render/RenderSurface";

/**
 * Where each active node under `root` is on the canvas (CSS pixels): the rectangle around its
 * sprite or text, or a point at its origin. Parents come before children. Empty headless.
 */
export function screenBounds(world: World, root: GameObject): { node: GameObject; rect: ScreenRect }[] {
  return world.render?.screenBounds(world, root) ?? [];
}

/** A world point's place on the canvas (CSS pixels), or null (headless, or behind the camera). */
export function worldToCanvas(world: World, point: readonly number[]): [number, number] | null {
  return world.render?.worldToCanvas(world, point) ?? null;
}

/**
 * UI elements (ADR 0069, 0077) drawn under a canvas point (CSS pixels), topmost first: screen
 * canvases, then world canvases nearest first, picked with the UI's layout boxes (canvases
 * themselves aren't listed). World canvases are hit with the view camera's ray. Empty headless and
 * before the UI loads.
 */
export function pickUI(world: World, x: number, y: number): UIComponentType[] {
  const ui = world.render?.uiRuntime();
  if (!ui) return [];
  return ui.pickAll(x, y, rayAt(world, x, y));
}

/**
 * UI canvases (ADR 0117) a click at a canvas point selects, topmost first: a world canvas by its
 * rectangle, a screen canvas only by the edge strip of its frame. Empty headless.
 */
export function pickUICanvases(world: World, x: number, y: number): UICanvas[] {
  const ui = world.render?.uiRuntime();
  if (!ui) return [];
  return ui.pickCanvases(x, y, rayAt(world, x, y));
}

/**
 * A UI element's laid-out box on the canvas: its four corners in canvas CSS pixels (top-left,
 * top-right, bottom-right, bottom-left; a world canvas's projected through the view camera) and its
 * size in UI pixels, for outlining it and for the scene view's resize and move handles. Null when it
 * isn't laid out, a corner is behind the camera, or headless.
 */
export function uiElementBox(world: World, c: UIComponentType): { points: [number, number][]; size: readonly [number, number] } | null {
  const corners = world.render?.uiRuntime()?.cornersOf(c);
  if (!corners) return null;
  if (corners.space === "screen") return { points: corners.points.map((p) => [p[0], p[1]]), size: corners.size };
  const out: [number, number][] = [];
  for (const p of corners.points) {
    const q = worldToCanvas(world, p);
    if (!q) return null;
    out.push(q);
  }
  return { points: out, size: corners.size };
}

/** A UI element's box corners on the canvas (see `uiElementBox`), or null. */
export function uiElementOutline(world: World, c: UIComponentType): [number, number][] | null {
  return uiElementBox(world, c)?.points ?? null;
}

/** Outline the renderers of these nodes (and their descendants) in the viewport until changed. */
export function setSelectionOutline(world: World, nodes: readonly GameObject[]): void {
  world.render?.setSelectionOutline(nodes);
}

export type { EditorColors } from "../render/RenderSurface";

/** Recolour the viewport's background, grid, selection outline and camera gizmos (the editor's theme). No-op headless. */
export function setEditorColors(world: World, colors: EditorColors): void {
  world.render?.setEditorColors(colors);
}

export type { GizmoHandlers, GizmoOptions } from "../render/RenderSurface";
export type { LocalPose } from "../render/gizmoMath";

/**
 * Show a move/rotate/scale gizmo on `nodes` (none hides it): on the node itself for one, at their
 * centre for several. Drags report each node's new local pose. No-op headless.
 */
export function setGizmo(world: World, nodes: readonly GameObject[], options: GizmoOptions, handlers: GizmoHandlers | null): void {
  world.render?.setGizmo(nodes, options, handlers);
}

/** True while dragging the gizmo or if a canvas point is over one of its handles, so clicks there don't select. */
export function gizmoActive(world: World, x: number, y: number): boolean {
  return world.render?.gizmoActiveAt(x, y) ?? false;
}

/** Give keyboard and pointer input back to this World's canvas and make it the active World (after play mode). */
export function resumeEditorWorld(world: World): void {
  World.active = world;
  const canvas = world.render?.canvas;
  if (canvas) Input.attach(canvas);
}

// --- Several Worlds in play mode (ADR 0032, 0034) -----------------------------------------------

export type { WorldViewState } from "../core/Engine";

/**
 * Draw the World named `worldName` to a surface of its own in `element` (a tile of the game
 * view), besides the Engine's main view. Returns a function that removes it; it also goes when the
 * World is destroyed or takes over the main view, or the Engine is disposed.
 */
export function attachWorldView(engine: Engine, worldName: string, element: HTMLElement): () => void {
  return engine._attachView(worldName, element);
}

/** Give local input to the World named `worldName` (null: back to the main view's World), except Worlds whose config sets `input`. */
export function focusWorldInput(engine: Engine, worldName: string | null): void {
  engine._focusInput(worldName);
}

/** Every World of `engine`: whether it renders, which view it has, whether it takes input, and whether it's paused. */
export function worldViewStates(engine: Engine): WorldViewState[] {
  return engine._viewStates();
}

/** The config the live World named `name` was created from (its bootstrap entry or `createWorld` config), or null. */
export function engineWorldConfig(engine: Engine, name: string): Readonly<WorldConfig> | null {
  return engine._worldConfig(name);
}

/** The live World named `name` in `engine`, or null: for editor tools, which may look inside Worlds. */
export function engineWorld(engine: Engine, name: string): World | null {
  return engine._world(name);
}

/** Advance only the World named `name` of `engine` one frame by `dt` seconds, paused or not (play mode's per-World Step). */
export function stepEngineWorld(engine: Engine, name: string, dt: number): void {
  engine._stepWorld(name, dt);
}

/** Draw every World of `engine` again without stepping it (after an edit while the game is paused). */
export function redrawEngine(engine: Engine): void {
  engine._redraw();
}

/** The prefab path `node` was instantiated from at runtime (`GameObject.instantiate`), if it's the root of such an instance. */
export function instantiatedPrefabOf(node: GameObject): string | undefined {
  return _instantiatedPrefabOf(node);
}

/** The file a scene node (a loaded scene, or a sub-scene instance) was made from, or undefined. */
export function sceneSourceOf(node: GameObject): string | undefined {
  return node.isSceneNode ? node.getBehavior(SceneInstance)?.source : undefined;
}

/** The world point on the plane z = 0 under a canvas point (CSS pixels), or null (headless, or the ray misses it). */
export function pointOnSpritePlane(world: World, x: number, y: number, z = 0): [number, number, number] | null {
  return world.render?.pointOnPlaneZ(world, x, y, z) ?? null;
}

/**
 * The local Transform values that keep `node` where it is in the world once it's moved under
 * `parent` (null: the top of the scene). Null if the node has no Transform.
 */
export function localPoseUnder(node: GameObject, parent: GameObject | null): LocalPose | null {
  if (!node.transform) return null;
  const world = node.world;
  const parentWorld = parent ? matrixFrom(world.worldMatrix(parent.entity), parent.entity * 16) : null;
  return localPoseFromMatrix(parentWorld, matrixFrom(world.worldMatrix(node.entity), node.entity * 16));
}

/** Set the scene view grid's cell size (metres) and whether it shows. No-op headless. */
export function setEditorGrid(world: World, cellSize: number, visible: boolean): void {
  world.render?.setEditorGrid(cellSize, visible);
}

/** The scene view grid's cell size, lines per side and visibility; null headless. */
export function editorGrid(world: World): { cellSize: number; visible: boolean; divisions: number } | null {
  return world.render?.editorGrid() ?? null;
}

/**
 * Draw what the Camera on `camera` sees into the canvas under `frame`, picture-in-picture (null
 * stops). The camera is one in the edited scene; the editor's helpers aren't drawn. No-op headless.
 */
export function setCameraPreview(world: World, camera: GameObject | null, frame: HTMLElement | null): void {
  world.render?.setCameraPreview(camera?.getBehavior(Camera) ?? null, frame);
}

/**
 * The scene view's particle preview (ADR 0057): in an editor World, selected ParticleSystems (or
 * every one, with `simulateAll`) play at `speed`, paused when `playing` is off. No-op headless.
 */
export function setParticlePreview(world: World, preview: { playing?: boolean; speed?: number; simulateAll?: boolean }): void {
  world.render?.setParticlePreview(preview);
}

/** Restart the previewed particle effects. */
export function restartParticlePreview(world: World): void {
  world.render?.restartParticlePreview();
}

/** What the particle renderer is playing (null headless, or before it has loaded). */
export function particleState(world: World): { systems: number; emitters: number; particles: number; batches: number; previewed: { time: number; count: number } | null } | null {
  return world.render?.particleState() ?? null;
}

/** True if the last frame drew a camera preview. */
export function cameraPreviewDrawn(world: World): boolean {
  return world.render?.cameraPreviewDrawn ?? false;
}

/** The world point on the ground (the plane y = `y`) under a canvas point, or null (headless, or the ray misses it). */
export function pointOnGround(world: World, x: number, y: number, height = 0): [number, number, number] | null {
  return world.render?.pointOnPlane(world, x, y, [0, 1, 0], [0, height, 0]) ?? null;
}

/** The world point on a plane (through `point`, facing `normal`) under a canvas point, or null. */
export function pointOnPlane(world: World, x: number, y: number, normal: readonly number[], point: readonly number[]): [number, number, number] | null {
  return world.render?.pointOnPlane(world, x, y, normal, point) ?? null;
}

/** The ray under a canvas point (CSS pixels) through the view's camera, or null headless. */
export function rayAt(world: World, x: number, y: number): { origin: [number, number, number]; direction: [number, number, number] } | null {
  return world.render?.rayAt(world, x, y) ?? null;
}

/** Where each light icon in the edited scene is on the canvas (CSS pixels). Empty headless. */
export function lightIconsOnCanvas(world: World): { node: GameObject; x: number; y: number }[] {
  return world.render?.lightIconsOnCanvas(world) ?? [];
}

/** How many light wireframe segments the last frame drew (0 headless). */
export function lightWireCount(world: World): number {
  return world.render?.lightWireCount() ?? 0;
}

/**
 * A mesh reference's triangles in mesh space (ADR 0044) as vertex positions and index triples,
 * for drawing a MeshCollider; null while its model loads (the load starts here), empty arrays
 * when it has none. An empty reference uses `node`'s MeshRenderer's mesh. The same object while
 * the meshes stay the same, so callers can cache what they derive from it.
 */
export function meshTriangleData(ref: string, node?: GameObject): { readonly vertices: readonly number[]; readonly indices: readonly number[] } | null {
  const mesh = ref || node?.getBehavior(MeshRenderer)?.mesh || "";
  const meshes = meshesIfLoaded(mesh);
  if (!meshes) return null;
  const cached = triangleCache.get(mesh);
  if (cached && cached.meshes.length === meshes.length && cached.meshes.every((m, i) => m === meshes[i])) return cached.data;
  const vertices: number[] = [], indices: number[] = [];
  for (const m of meshes) {
    const base = vertices.length / 3;
    for (const v of m.data.positions) vertices.push(v);
    for (const i of m.data.indices) indices.push(base + i);
  }
  const data = { vertices, indices };
  triangleCache.set(mesh, { meshes: [...meshes], data });
  return data;
}

const triangleCache = new Map<string, { meshes: readonly ModelMesh[]; data: { vertices: number[]; indices: number[] } }>();

/**
 * The box around the meshes `node`'s MeshRenderer draws, in the node's own space (before its
 * scale); null without a MeshRenderer, or while its model loads.
 */
export function meshLocalBounds(node: GameObject): { min: [number, number, number]; max: [number, number, number] } | null {
  const ref = node.getBehavior(MeshRenderer)?.mesh;
  const meshes = ref ? meshesIfLoaded(ref) : null;
  if (!meshes?.length) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    const p = m.data.positions;
    for (let v = 0; v < p.length; v += 3) {
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], p[v + i]);
        max[i] = Math.max(max[i], p[v + i]);
      }
    }
  }
  return { min, max };
}

/**
 * The world-space box around `node`'s mesh (ADR 0043) or sprite (its quad's corners through the
 * node's world matrix), or around its origin when it has neither (or the model or texture isn't
 * loaded, or headless).
 */
export function worldBounds(node: GameObject): { min: [number, number, number]; max: [number, number, number] } {
  const world = node.world;
  const mesh = world.render?.meshBounds(node);
  if (mesh) return mesh;
  const m = world.worldMatrix(node.entity), mo = node.entity * 16;
  const size = spriteSize(node);
  const corners = size
    ? [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, y]) => Mat4.transformPoint(m, mo, x * size[0], y * size[1], 0))
    : [Mat4.transformPoint(m, mo, 0, 0, 0)];
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const a of corners) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], a[i]);
      max[i] = Math.max(max[i], a[i]);
    }
  }
  return { min, max };
}

/** A world point in `node`'s parent's space: the local position that puts `node`'s origin there. */
export function localPositionFor(node: GameObject, point: readonly number[]): [number, number, number] {
  const parent = node.parent;
  const x = point[0], y = point[1], z = point[2] ?? 0;
  if (!parent?.transform) return [x, y, z];
  const inverse = matrixFrom(node.world.worldMatrix(parent.entity), parent.entity * 16);
  Mat4.invert(inverse, 0, inverse, 0);
  return Mat4.transformPoint(inverse, 0, x, y, z);
}

export type { EditorOverlay } from "../render/RenderSurface";

/**
 * What an overlay draws, so the editor can show or hide each kind (play mode's Gizmos menu):
 * "navigation", "colliders", or "other" (the default: anything else, a game's own debug drawing).
 */
export type EditorOverlayKind = "navigation" | "colliders" | "other";

interface OverlayEntry {
  readonly provider: () => EditorOverlay;
  readonly kind: EditorOverlayKind;
}

const overlayProviders = new WeakMap<World, Map<string, OverlayEntry>>();
const overlayFilters = new WeakMap<World, (kind: EditorOverlayKind) => boolean>();

/** Several overlays in one: lines, segments and handles concatenated in order. */
export function mergeOverlays(overlays: readonly EditorOverlay[]): EditorOverlay {
  const merged: EditorOverlay = { lines: [], handles: [] };
  for (const o of overlays) {
    merged.lines.push(...o.lines);
    merged.handles.push(...o.handles);
    if (o.segments?.length) (merged.segments ??= []).push(...o.segments);
  }
  return merged;
}

/**
 * Draw `provider`'s overlay every frame, with any others added under other ids (merged in the order
 * added). Same id replaces. `kind` says what it draws (see `setEditorOverlayFilter`). No-op headless.
 */
export function addEditorOverlay(world: World, id: string, provider: () => EditorOverlay, kind: EditorOverlayKind = "other"): void {
  let map = overlayProviders.get(world);
  if (!map) overlayProviders.set(world, (map = new Map()));
  map.set(id, { provider, kind });
  installOverlays(world, map);
}

/** Stop the overlay added under `id`. */
export function removeEditorOverlay(world: World, id: string): void {
  const map = overlayProviders.get(world);
  if (!map?.delete(id)) return;
  installOverlays(world, map);
}

/**
 * Draw only the overlays whose kind `filter` accepts on `world` (null: all of them, the default),
 * now and as overlays are added later. Play mode's Gizmos toggle sets it on the game's Worlds.
 */
export function setEditorOverlayFilter(world: World, filter: ((kind: EditorOverlayKind) => boolean) | null): void {
  if (filter) overlayFilters.set(world, filter);
  else overlayFilters.delete(world);
  const map = overlayProviders.get(world);
  if (map) installOverlays(world, map);
}

/** The ids of `world`'s overlays that are drawn under its filter, in order (tests and tools). */
export function shownEditorOverlays(world: World): string[] {
  const filter = overlayFilters.get(world);
  return [...(overlayProviders.get(world) ?? [])].filter(([, e]) => !filter || filter(e.kind)).map(([id]) => id);
}

function installOverlays(world: World, map: Map<string, OverlayEntry>): void {
  const filter = overlayFilters.get(world);
  const shown = [...map.values()].filter((e) => !filter || filter(e.kind)).map((e) => e.provider);
  // None shown: no provider, so the backend clears what it drew and stops asking.
  if (shown.length === 0) return world.render?.setOverlayProvider(null);
  world.render?.setOverlayProvider(() => mergeOverlays(shown.map((p) => p())));
}

/** Draw an overlay (lines and handles) supplied by `provider` every frame; null stops. Shares the World with `addEditorOverlay`'s overlays (under the id "default"). */
export function setEditorOverlay(world: World, provider: (() => EditorOverlay) | null): void {
  if (provider) addEditorOverlay(world, "default", provider);
  else removeEditorOverlay(world, "default");
}

/** Show or hide `world`'s selection outline, keeping what's outlined (play mode's Gizmos menu). No-op headless. */
export function setSelectionOutlineShown(world: World, shown: boolean): void {
  world.render?.setSelectionOutlineShown(shown);
}

/** How much editor drawing `world`'s view shows now: overlay line segments, handles and selection outlines. Null headless. */
export function editorDrawingShown(world: World): { segments: number; handles: number; outlines: number; drawnObjects: number } | null {
  return world.render?.editorDrawingShown() ?? null;
}

// --- Play mode's Stats -------------------------------------------------------------------------

export type { EngineTiming } from "../core/Engine";

/** What `world`'s view drew last frame (every camera and the UI) and the GPU resources it holds. */
export interface RenderStats {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly lines: number;
  readonly points: number;
  readonly geometries: number;
  readonly textures: number;
  readonly programs: number;
}

/** `world`'s render counters (see `RenderStats`), or null when it doesn't render (headless, or no view). */
export function renderStats(world: World): RenderStats | null {
  return world.render?.renderStats() ?? null;
}

/** Report `engine`'s frame and per-World phase timings to `timing` from now on (null stops; then there's no cost). */
export function setEngineTiming(engine: Engine, timing: EngineTiming | null): void {
  engine._setTiming(timing);
}

/** ADR 0080: the prefab and material files the project's scripts name, warmed up with every scene load. */
export function setScriptAssetRefs(paths: readonly string[]): void {
  _setScriptAssetRefs(paths);
}

/** ADR 0080: `engine`'s render surfaces, now and later, log shader variants compiled after loading, naming their prefab (editor play mode). */
export function setVariantReport(engine: Engine, on: boolean): void {
  engine._setVariantReport(on);
}

/** How many nodes `world` has (the World root not counted). */
export function nodeCount(world: World): number {
  let n = 0;
  const stack = [...world.root.children];
  for (let node = stack.pop(); node; node = stack.pop()) {
    n++;
    stack.push(...node.children);
  }
  return n;
}

/** How many navigation agents `world` has, or null while it has no navigation (ADR 0065). */
export function navAgentCount(world: World): number | null {
  return world.navigation ? world._componentsOfType(NavAgent).length : null;
}

/** The World's navigation (ADR 0065), or null while it has none. */
export function navigationOf(world: World): NavigationWorld | null {
  return world.navigation ?? null;
}

/** The id of the overlay handle under a canvas point, or null. */
export function overlayHandleAt(world: World, x: number, y: number): string | null {
  return world.render?.pickOverlayHandle(world, x, y) ?? null;
}

/** Where each overlay handle is on the canvas (CSS pixels). Empty headless. */
export function overlayHandlesOnCanvas(world: World): { id: string; x: number; y: number }[] {
  return world.render?.overlayHandlesOnCanvas(world) ?? [];
}

// --- Adding components (ADR 0022) ---------------------------------------------------------------

/** A component type the editor can add: its id, display name and group. */
export interface ComponentTypeInfo {
  readonly id: string;
  readonly name: string;
  /** Built into the engine, a game script (GameBehavior), or an ECS data component. */
  readonly group: "Engine" | "Scripts" | "Data";
}

/** Components every node has or the engine manages itself: never offered, never removable. */
const FIXED = new Set(["engine.Transform", "engine.SceneInstance"]);

/** True if the editor may add or remove components of type `id`: everything but Transform, engine internals and the editor's own (`editor.*`). */
export const isEditableComponent = (id: string) => !FIXED.has(id) && !id.startsWith("editor.");

/** True if `id` names an ECS data component (ADR 0017) rather than a script or engine component. */
export const isDataComponent = (id: string) => getDataComponentDef(id) !== undefined;

/** Every component type that can be added to a node, grouped (Engine, Scripts, Data) and sorted by name. */
export function componentCatalog(): ComponentTypeInfo[] {
  const name = (id: string) => id.replace(/^[^.]*\./, "");
  const out: ComponentTypeInfo[] = [
    ...listComponentIds()
      .filter(isEditableComponent)
      .map((id) => ({ id, name: name(id), group: id.startsWith("engine.") ? ("Engine" as const) : ("Scripts" as const) })),
    ...listDataComponentIds().map((id) => ({ id, name: name(id), group: "Data" as const })),
  ];
  const order = { Engine: 0, Scripts: 1, Data: 2 };
  return out.sort((a, b) => order[a.group] - order[b.group] || a.name.localeCompare(b.name));
}

/** The size of the sprite on `node` in the node's units (before its scale), or null (no sprite, texture not loaded, or headless). */
export function spriteSize(node: GameObject): [number, number] | null {
  const s = node.getBehavior(SpriteRenderer);
  return s ? (node.world.render?.spriteSize(s) ?? null) : null;
}

// --- Project scripts (ADR 0030) -----------------------------------------------------------------

export type { ScriptRegistrations } from "../core/registry";

/**
 * Run `load` (which imports project scripts) with registration replacing: a component, data
 * component or system whose id or name is already taken (by the editor build, or an earlier load
 * of the script) is replaced instead of throwing. Returns what `load` registered.
 */
export async function withScriptRegistrations(load: () => Promise<void>): Promise<ScriptRegistrations> {
  _setReplacingRegistrations(true);
  try {
    await load();
  } finally {
    _setReplacingRegistrations(false);
  }
  return _takeRecordedRegistrations();
}

/** Forget registrations scripts made (a script was deleted, or another project opened), putting back any of the editor build's they replaced. */
export function unregisterScripts(registrations: ScriptRegistrations): void {
  for (const id of registrations.components) _unregisterComponent(id);
  for (const id of registrations.data) _undefineComponent(id);
  for (const name of registrations.systems) _undefineSystem(name);
  for (const id of registrations.inputs) _undefineInput(id);
}

// --- Network tools (ADR 0033 §9, T15) ------------------------------------------------------------

/** Bytes and messages one way on a connection, copied: totals and per message kind (`net.snapshot`, `net.input:…`, `net.rpc`, `net.ping`…). */
export interface NetTrafficInfo {
  readonly bytes: number;
  readonly messages: number;
  readonly byKind: Readonly<Record<string, { readonly bytes: number; readonly messages: number }>>;
}

/** One connection of a networked World, as the Network panel shows it. */
export interface NetPeerInfo {
  /** The connection id the server assigned (0 on a client before the handshake). */
  readonly id: number;
  readonly state: "handshake" | "open" | "closed";
  /** The other end's address, as the transport names it. */
  readonly remote: string;
  /** Smoothed round trip in ms (measured by the client, reported to the server). */
  readonly rtt: number;
  readonly sent: NetTrafficInfo;
  readonly received: NetTrafficInfo;
  /** Server: the size of the last snapshot sent on this connection, in bytes; null on a client. */
  readonly snapshotBytes: number | null;
  /** Server: the ghosts this connection has been told about; null on a client. */
  readonly ghosts: number | null;
  /** Server: this connection's counters per input stream (only streams it has sent input on). */
  readonly inputs: readonly { readonly id: string; readonly received: number; readonly repeated: number; readonly late: number }[];
  /**
   * Server: bytes sent on this connection per ghost type since it opened (each ghost's spawn and
   * states in the snapshots sent; snapshot headers and despawns aren't counted). A type is a
   * prefab path, or a scene ghost's `scene#node/path`. Empty on a client.
   */
  readonly ghostTypes: readonly { readonly type: string; readonly bytes: number }[];
}

/** A networked World of an Engine, as the Network panel shows it. */
export interface NetWorldInfo {
  readonly world: string;
  readonly role: "server" | "client";
  readonly tick: number;
  readonly serverTick: number;
  readonly interpolationTick: number;
  /** The client's smoothed RTT in ms (0 on a server). */
  readonly rtt: number;
  readonly peers: readonly NetPeerInfo[];
  /** Client: the ghosts it has; null on a server. */
  readonly ghosts: number | null;
  /** Recently closed connections and why, newest last. */
  readonly closed: readonly { readonly id: number; readonly reason: string }[];
  /** Client prediction's counters (T13); null for a World that isn't a network client or hasn't predicted yet. */
  readonly prediction: Readonly<PredictionStats> | null;
}

const copyTraffic = (t: NetTraffic): NetTrafficInfo => ({ bytes: t.bytes, messages: t.messages, byKind: Object.fromEntries([...t.byKind].map(([k, v]) => [k, { ...v }])) });

/** The live Worlds of `engine`, in its order. */
const liveWorlds = (engine: Engine): World[] => engine.worlds().flatMap((h) => engine._world(h.name) ?? []);

/** Every networked World of `engine`, with its connections and counters: a snapshot to show. */
export function netWorldInfo(engine: Engine): NetWorldInfo[] {
  const out: NetWorldInfo[] = [];
  for (const world of liveWorlds(engine)) {
    const session = netSession(world);
    if (!session || (!session.isServer && !session.isClient)) continue;
    const server = session.isServer ? serverReplication(world) : null;
    const inputs = session.isServer ? definedInputs() : [];
    const peerInfo = (peer: NetPeer): NetPeerInfo => {
      const ps = server?.peerState(peer);
      const node = peer.node;
      return {
        id: peer.id,
        state: peer.state,
        remote: peer.link.remote,
        rtt: peer.rtt,
        sent: copyTraffic(peer.sent),
        received: copyTraffic(peer.received),
        snapshotBytes: session.isServer ? (ps?.lastBytes ?? 0) : null,
        ghosts: session.isServer ? (ps?.known.size ?? 0) : null,
        ghostTypes: ps ? [...ps.typeBits].map(([type, bits]) => ({ type, bytes: bits / 8 })) : [],
        inputs: node?.isValid ? inputs.flatMap((def) => {
          const stats = World._runIn(world, () => def.stats(node));
          return stats ? [{ id: def.id, ...stats }] : [];
        }) : [],
      };
    };
    const t = session.time;
    out.push({
      world: world.name,
      role: session.isServer ? "server" : "client",
      tick: session.tick,
      serverTick: t.serverTick,
      interpolationTick: t.interpolationTick,
      rtt: session.isClient ? t.rtt : 0,
      peers: session.allPeers().map(peerInfo),
      ghosts: session.isClient ? (clientReplication(world)?.ghosts.size ?? 0) : null,
      closed: session.closed.map((c) => ({ ...c })),
      prediction: predictionStats(world),
    });
  }
  return out;
}

/** A transport or connection that simulates conditions (loopback). */
type Conditioned = { setConditions(c: LinkConditions): void; readonly conditions: Readonly<LinkConditions> };
const conditioned = (t: object): t is Conditioned => typeof (t as Partial<Conditioned>).setConditions === "function" && typeof (t as Partial<Conditioned>).conditions === "object";

/**
 * Simulate `conditions` on every link of `engine` whose transport can (loopback), both ways: on
 * the servers' listening transports (what servers send) and the clients' (what clients send).
 * Connections with conditions of their own get them too. Applies to messages sent from now on.
 * Returns how many transports took them.
 */
export function setNetConditions(engine: Engine, conditions: LinkConditions): number {
  let n = 0;
  for (const world of liveWorlds(engine)) {
    const session = netSession(world);
    if (!session) continue;
    for (const t of session.transportList()) {
      if (!conditioned(t)) continue;
      t.setConditions(conditions);
      n++;
    }
    for (const peer of session.allPeers()) {
      // Only links with an override of their own; the rest follow their transport.
      const link = peer.link as object;
      if (conditioned(link) && link.conditions !== (peer.transport as Partial<Conditioned>).conditions) link.setConditions(conditions);
    }
  }
  return n;
}

/** The conditions a conditioned transport of `engine` simulates (a client's first, so what clients send), or null if it has none. */
export function netConditions(engine: Engine): Readonly<LinkConditions> | null {
  const worlds = liveWorlds(engine);
  for (const world of [...worlds.filter((w) => netSession(w)?.isClient), ...worlds]) {
    for (const t of netSession(world)?.transportList() ?? []) if (conditioned(t)) return { ...t.conditions };
  }
  return null;
}

/** A defined input stream (ADR 0033 §5): its id and fields with their scalar kinds. */
export interface InputStreamInfo {
  readonly id: string;
  readonly fields: readonly { readonly name: string; readonly kind: "f32" | "i32" | "u8" }[];
}

/** Every input stream the engine and the project's scripts define. */
export function inputStreams(): InputStreamInfo[] {
  return definedInputs().map((def) => ({ id: def.id, fields: Object.entries(def.schema as Schema).map(([name, type]) => ({ name, kind: type.kind })) }));
}

/**
 * Write input in a client World of `engine` for it: thin clients' synthetic input. From then on the
 * World's own writes to that stream are ignored (`Move.write` from a system reading the keyboard),
 * so the synthetic input is what's sent and predicted. False if it can't (no such World or stream, or a server).
 */
export function writeWorldInput(engine: Engine, worldName: string, streamId: string, values: Readonly<Record<string, number>>): boolean {
  const world = engine._world(worldName);
  const def = definedInputs().find((d) => d.id === streamId);
  if (!world || !def || netSession(world)?.isServer) return false;
  return _writeSyntheticInput(world, streamId, values);
}

// --- Worlds panel: live connections (ADR 0062) -----------------------------------------------------

/** A live client-to-server connection between two Worlds of one Engine, as the Worlds panel draws it in play. */
export interface LiveLink {
  readonly from: string;
  readonly to: string;
  readonly transport: string;
  readonly state: "handshake" | "open" | "closed";
}

/**
 * Every client World of `engine` connected (or connecting) to a server World of the same Engine,
 * however the connection was made: a bootstrap link or a script's `connect`. Clients connected to
 * a server outside the Engine (a dedicated server) aren't listed.
 */
export function liveLinks(engine: Engine): LiveLink[] {
  const worlds = engine.worlds().flatMap((h) => engine._world(h.name) ?? []);
  const servers = worlds.flatMap((w) => {
    const session = netSession(w);
    return session?.isServer ? session.listening().map((l) => ({ world: w.name, ...l })) : [];
  });
  const out: LiveLink[] = [];
  for (const w of worlds) {
    const peer = netSession(w)?.serverPeer;
    if (!peer) continue;
    const server = servers.find((s) => s.address === peer.link.remote);
    if (server) out.push({ from: w.name, to: server.world, transport: server.transport, state: peer.state });
  }
  return out;
}

// --- Asset thumbnails (ADR 0061) -------------------------------------------------------------------

export type { ThumbnailKind, ThumbnailPreview, ThumbnailRendererApi as ThumbnailRenderer } from "../render/previewTypes";

/** The editor's asset thumbnail renderer (one offscreen GPU context), loaded the first time it's needed. */
export { createThumbnailRenderer } from "../render/previewRouting";
