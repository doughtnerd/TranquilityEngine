/**
 * The editor's handle on one World's viewport (ADR 0022, 0128): overlays, the transform gizmo,
 * picking, rays, screen bounds and the camera queries behind the scene view. The editor asks a
 * render surface for it (`RenderSurface.editorViewport()`); games never do.
 *
 * Two layers. `EditorViewport` is what the editor calls. `ViewportHandle` implements it once for
 * every renderer: it keeps the editor's state (selection, grid, colours, overlay, gizmo)
 * from the first call, loads the renderer's editor tools on demand, hands that state over exactly
 * once when they arrive, and answers "nothing" until then. Renderer policy (scene view, per-object
 * sprites, camera and particle previews; ADR 0129) is not the tools' business: it goes straight to the
 * surface's `RenderPolicyPort`, live before the tools load. Below the handle, `ViewportAdapter` is the
 * seam a renderer implements for the editor tools: the Babylon one (`babylon/editorViewport.ts`) and an
 * in-memory fake for tests (`fakeViewport.ts`). Both speak engine types only (ADR 0010): node ids live on `GameObject`s,
 * points are canvas CSS pixels (origin top-left), and nothing a renderer owns is ever handed out.
 */
import type { GameObject } from "../scene/GameObject";
import type { UICanvas, UIComponentType } from "../ui/components";
import type { UICoreLike } from "../ui/uiCoreTypes";
import type { Camera, ReflectionProbe } from "./components";
import { LODGroup, SpriteRenderer } from "./components";
import type { LocalPose } from "./gizmoMath";
import type { ParticlePreviewSettings } from "./RenderSurface";
import type { World } from "../core/World";
import { visibilityService, type OcclusionDebug } from "./visibility/service";
import { sameInset, SCENE_VISIBILITY_OFF, type ParticlePreview, type PreviewInset, type RenderPolicyPort, type SceneVisibilityTools } from "./renderPolicy";

/** @internal Editor gizmo settings (ADR 0022). */
export interface GizmoOptions {
  mode: "translate" | "rotate" | "scale";
  /** 2D view: move/scale on X and Y only, rotate around Z only. */
  planar: boolean;
  /** Snap drags to `snapSteps` (default 0.25 m, π/12 rad (15°) and 0.1 scale steps). */
  snap: boolean;
  /** Snap steps: metres for moves, radians for turns (ADR 0164), a factor for scaling. */
  snapSteps?: { move: number; rotate: number; scale: number };
  /** Move and turn along the world's axes (default) or the node's own (the active node's for several). */
  space?: "world" | "local";
  /** Several nodes: the gizmo sits at their centre (default) or on the active node's origin. */
  pivot?: "center" | "pivot";
  /** Which of the nodes is the active one (default: the last). */
  activeIndex?: number;
}

/** @internal What the editor does with a gizmo drag: one start, many changes, one end. */
export interface GizmoHandlers {
  onStart(): void;
  /** Each target node's new local Transform values, in the order the nodes were given. */
  onChange(poses: LocalPose[]): void;
  onEnd(): void;
}

/** @internal Editor overlay (e.g. collider outlines and handles), supplied every frame by the editor. */
export interface EditorOverlay {
  /** Polylines in world space; `color` is 0xRRGGBB. */
  lines: { points: [number, number, number][]; closed: boolean; color: number }[];
  /** Handles drawn as fixed-size squares on top of everything; picked by `pickOverlayHandle`. */
  handles: { id: string; position: [number, number, number]; color: number }[];
  /** Many loose segments in one colour (6 floats each: a xyz, b xyz), for big overlays like navmesh debug drawing. */
  segments?: { positions: Float32Array; color: number }[];
}

/** @internal A rectangle on the canvas in CSS pixels (origin top-left); a point when left = right and top = bottom. */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * @internal Editor overlay colours (ADR 0022), 0xRRGGBB: the viewport background, the grid's lines
 * and centre lines, the selection outline and unselected camera wireframes. The editor sets them
 * from its theme.
 */
export interface EditorColors {
  background: number;
  grid: number;
  gridCenter: number;
  outline: number;
  cameraGizmo: number;
}

/** @internal A ray in world space through a canvas point. */
export interface ViewRay {
  origin: [number, number, number];
  direction: [number, number, number];
}

/** @internal A world-space axis-aligned box. */
export interface WorldBox {
  min: [number, number, number];
  max: [number, number, number];
}

/** @internal The scene view grid: its plane, cell size (metres), lines per side, and whether it shows. */
export interface EditorGrid {
  plane: "xz" | "xy";
  cellSize: number;
  visible: boolean;
  divisions: number;
}

/** @internal The UI core queries the editor needs (ADR 0069, 0077, 0117). */
export type ViewportUI = Pick<UICoreLike, "pickAll" | "pickCanvases" | "cornersOf">;

/**
 * @internal The editor's viewport handle (ADR 0128). Setters keep their value until changed, from
 * before the renderer has loaded; queries answer nothing (empty, null, false) until it has, and
 * headless.
 */
export interface EditorViewport {
  /** True once the renderer's editor tools have loaded and the state set so far is applied. */
  readonly ready: boolean;

  // --- State -------------------------------------------------------------------------------------
  /** Recolour the background, grid, selection outline and camera gizmos (the editor's theme). Editor Worlds only. */
  setColors(colors: EditorColors): void;
  /** Change the grid's plane, cell size or visibility (unset fields keep their value). */
  setGrid(grid: Partial<Omit<EditorGrid, "divisions">>): void;
  /** Outline these nodes' renderers (and their descendants'); the particle preview plays their effects. */
  setSelection(nodes: readonly GameObject[]): void;
  /** Show or hide the selection outline, keeping what's selected. */
  setSelectionShown(shown: boolean): void;
  /** Light 2D draws by their 2D lights (default), or draw them unlit, as the scene view's 2D Lighting toggle does (ADR 0399). */
  setLighting2D(on: boolean): void;
  /** Draw `provider`'s overlay every frame (null: none). */
  setOverlay(provider: (() => EditorOverlay) | null): void;
  /** Show a move/rotate/scale gizmo on `nodes` (none hides it); drags report each node's new local pose. */
  setGizmo(nodes: readonly GameObject[], options: GizmoOptions, handlers: GizmoHandlers | null): void;
  /** Draw what `camera` sees into the canvas under `frame`, picture-in-picture (null stops). */
  setCameraPreview(camera: Camera | null, frame: HTMLElement | null): void;
  /** The scene view's particle preview (ADR 0057); unset fields keep their value. */
  setParticlePreview(preview: Partial<ParticlePreviewSettings>): void;
  restartParticlePreview(): void;
  /**
   * Preview one LOD level of `node`'s `LODGroup` in this scene view only (ADR 0459 §7): `level` is its index, -1 shows
   * it culled, null stops. Not saved, and game views and `currentLevel` don't see it.
   */
  setLodPreview(node: GameObject | null, level?: number): void;
  /**
   * The scene view's visibility tools (ADR 0459 §7, 0460 §6): occlusion culling, freeze culling, the validator, the
   * debug view and its tints. Unset fields keep their value; all are off until set.
   */
  setSceneVisibility(tools: Partial<SceneVisibilityTools>): void;

  // --- Queries (canvas CSS pixels, origin top-left) ------------------------------------------
  /** The grid as drawn, or null. */
  grid(): EditorGrid | null;
  /** The scene camera's screen-relative height of `node`'s `LODGroup` (what its transition heights are compared with), or null before the scene view has drawn. */
  lodScreenHeight(node: GameObject): number | null;
  /**
   * `world`'s last occlusion run for the debug view (ADR 0460 §6): the scene view's when it ran occlusion, else the main
   * camera's. Null unless the debug view is "occlusion" and a view ran occlusion in its last frame.
   */
  occlusionDebug(world: World): OcclusionDebug | null;
  /** Nodes whose renderers or icons lie under a canvas point, topmost first. */
  pick(x: number, y: number): GameObject[];
  /** The ray under a canvas point through the view's camera. */
  rayAt(x: number, y: number): ViewRay | null;
  /** A world point's place on the canvas, or null behind the camera. */
  worldToCanvas(point: readonly number[]): [number, number] | null;
  /** The world point on a plane (through `point`, facing `normal`) under a canvas point, or null if the ray misses it. */
  pointOnPlane(x: number, y: number, normal: readonly number[], point: readonly number[]): [number, number, number] | null;
  /** Where each active node under `root` is on the canvas; parents before children. */
  screenBounds(root: GameObject): { node: GameObject; rect: ScreenRect }[];
  /** The world box around everything drawn for `node` in the world (meshes, sprite quads, tile layers, water, world canvases; ADR 0276), or null. */
  drawnBounds(node: GameObject): WorldBox | null;
  /** The size of `node`'s sprite in node units (before its scale): its `size` if set, else its texture's; null (no sprite, texture not loaded, or not ready). */
  spriteSize(node: GameObject): [number, number] | null;
  /** True while dragging the gizmo or if a canvas point is over one of its handles. */
  gizmoActiveAt(x: number, y: number): boolean;
  /** Where each overlay handle is on the canvas; handles behind the camera are left out. */
  overlayHandles(): { id: string; x: number; y: number }[];
  /** The overlay handle nearest a canvas point within `radius` pixels (default 9), or null. */
  pickOverlayHandle(x: number, y: number, radius?: number): string | null;
  /** Where each light icon is on the canvas. */
  lightIcons(): { node: GameObject; x: number; y: number }[];
  /** UI elements under a canvas point, topmost first (world canvases hit with the view's ray). */
  pickUI(x: number, y: number): UIComponentType[];
  /** UI canvases a click at a canvas point selects, topmost first (ADR 0117). */
  pickUICanvases(x: number, y: number): UICanvas[];
  /** A UI element's four corners on the canvas and its size in UI pixels, or null (not laid out, or behind the camera); `clip`: the drawn part's corners when an `overflow: hidden` ancestor clips it (ADR 0422). */
  uiElementBox(c: UIComponentType): { points: [number, number][]; size: readonly [number, number]; clip?: [number, number][] | null } | null;
  /** Editor (ADR 0110): a reflection probe's current capture as a prefiltered `.env` file. Rejects until ready. */
  bakeReflectionProbe(probe: ReflectionProbe): Promise<ArrayBuffer>;
}

/**
 * @internal What a renderer implements for the editor viewport (ADR 0128): its loaded editor tools
 * only (grid, outlines, overlay, gizmo, picking, queries). Renderer policy goes through
 * `RenderPolicyPort` instead (ADR 0129). Setters take whole state; `ViewportHandle` keeps the pieces
 * and replays them. Engine types only.
 */
export interface ViewportAdapter {
  setColors(colors: EditorColors): void;
  setGrid(plane: "xz" | "xy", cellSize: number, visible: boolean): void;
  setSelection(nodes: readonly GameObject[], shown: boolean): void;
  setOverlay(provider: (() => EditorOverlay) | null): void;
  setGizmo(nodes: readonly GameObject[], options: GizmoOptions, handlers: GizmoHandlers | null): void;
  grid(): { cellSize: number; visible: boolean; divisions: number } | null;
  pick(x: number, y: number): GameObject[];
  rayAt(x: number, y: number): ViewRay | null;
  worldToCanvas(point: readonly number[]): [number, number] | null;
  screenBounds(root: GameObject): { node: GameObject; rect: ScreenRect }[];
  drawnBounds(node: GameObject): WorldBox | null;
  spriteSize(sprite: SpriteRenderer): [number, number] | null;
  gizmoActiveAt(x: number, y: number): boolean;
  overlayHandles(): { id: string; x: number; y: number }[];
  lightIcons(): { node: GameObject; x: number; y: number }[];
  /** The UI core once loaded, or null. */
  ui(): ViewportUI | null;
  bakeReflectionProbe(probe: ReflectionProbe): Promise<ArrayBuffer>;
}

/**
 * @internal The renderer-independent half of the editor viewport (ADR 0128). `connect` returns the
 * renderer's adapter once its editor tools have loaded (or null; calling it starts loading them).
 */
export class ViewportHandle implements EditorViewport {
  private adapter: ViewportAdapter | null = null;
  /** Something asked for the viewport: keep trying to connect (an editor World wants it from the start). */
  private wanted: boolean;
  private colors: EditorColors | null = null;
  private gridState: Omit<EditorGrid, "divisions"> | null = null;
  private selection: readonly GameObject[] = [];
  private selectionShown = true;
  private overlay: (() => EditorOverlay) | null = null;
  private gizmo: { nodes: readonly GameObject[]; options: GizmoOptions; handlers: GizmoHandlers | null } | null = null;
  /** The selected nodes, for the particle preview's `selected` predicate (read live by the renderer). */
  private readonly selected = new Set<GameObject>();
  private readonly isSelected = (node: GameObject): boolean => this.selected.has(node);
  /** The particle preview's playback and restart count (ADR 0154: they reach the renderer as render policy). */
  private readonly playback = { playing: true, speed: 1, simulateAll: false, restarts: 0 };
  /** Whether this handle put the renderer in particle preview mode (an editor World's scene view). */
  private previewing = false;
  private perObjectSet = false;
  /** The camera preview the editor asked for, and what was last handed to the policy (ADR 0240). */
  private preview: { camera: Camera; frame: HTMLElement } | null = null;
  private previewShown: { camera: Camera; inset: PreviewInset } | null = null;
  /** The node whose LOD level the scene view previews. */
  private lodPreviewNode: GameObject | null = null;
  /** The scene view's visibility tools as last handed to the policy. */
  private sceneVisibility: SceneVisibilityTools = SCENE_VISIBILITY_OFF;

  /**
   * `policy` is the surface's render policy port. An eager handle (an editor World) sets the scene
   * view policy at once, before the editor tools exist. `measure` says where the camera preview's
   * frame lies on the surface's canvas (ADR 0240); without it (headless) no preview is drawn.
   */
  constructor(
    private readonly connect: () => ViewportAdapter | null,
    private readonly policy: RenderPolicyPort,
    eager = false,
    private readonly measure: ((frame: HTMLElement) => PreviewInset | null) | null = null,
  ) {
    this.wanted = eager;
    if (eager) {
      this.perObjectSet = true;
      this.previewing = true;
      policy.setPolicy({ sceneView: true, drawPolicy: "perObject", particlePreview: this.particlePolicy() });
    }
  }

  /** The particle preview as render policy now (a new object, so the policy's value changes). */
  private particlePolicy(): ParticlePreview {
    return { ...this.playback, selected: this.isSelected };
  }

  get ready(): boolean {
    return this.adapter !== null;
  }

  /** The surface calls this every frame: connects once the tools have loaded, if anything wants them. */
  poll(): void {
    if (this.wanted && !this.adapter) this.live();
  }

  /** The adapter, connecting (and replaying the state kept so far, once) if it has just arrived. */
  private live(): ViewportAdapter | null {
    if (this.adapter) return this.adapter;
    this.wanted = true;
    if (!this.perObjectSet) {
      this.perObjectSet = true;
      this.policy.setPolicy({ drawPolicy: "perObject" });
    }
    const a = this.connect();
    if (!a) return null;
    this.adapter = a;
    if (this.colors) a.setColors(this.colors);
    if (this.gridState) a.setGrid(this.gridState.plane, this.gridState.cellSize, this.gridState.visible);
    a.setSelection(this.selection, this.selectionShown);
    a.setOverlay(this.overlay);
    if (this.gizmo) a.setGizmo(this.gizmo.nodes, this.gizmo.options, this.gizmo.handlers);
    return a;
  }

  // --- State -------------------------------------------------------------------------------------

  setColors(colors: EditorColors): void {
    this.colors = { ...colors };
    this.live()?.setColors(colors);
  }

  setGrid(grid: Partial<Omit<EditorGrid, "divisions">>): void {
    const was = this.gridState ?? { plane: "xz", cellSize: 1, visible: true, ...this.adapter?.grid() };
    const g = { plane: grid.plane ?? was.plane, cellSize: grid.cellSize ?? was.cellSize, visible: grid.visible ?? was.visible };
    this.gridState = g;
    this.live()?.setGrid(g.plane, g.cellSize, g.visible);
  }

  setSelection(nodes: readonly GameObject[]): void {
    this.selection = [...nodes];
    this.selected.clear();
    for (const n of this.selection) this.selected.add(n);
    this.live()?.setSelection(this.selection, this.selectionShown);
  }

  setLighting2D(on: boolean): void {
    this.policy.setPolicy({ lighting2D: on });
  }

  setSelectionShown(shown: boolean): void {
    this.selectionShown = shown;
    this.live()?.setSelection(this.selection, shown);
  }

  setOverlay(provider: (() => EditorOverlay) | null): void {
    this.overlay = provider;
    this.live()?.setOverlay(provider);
  }

  setGizmo(nodes: readonly GameObject[], options: GizmoOptions, handlers: GizmoHandlers | null): void {
    this.gizmo = { nodes: [...nodes], options, handlers };
    this.live()?.setGizmo(this.gizmo.nodes, options, handlers);
  }

  setCameraPreview(camera: Camera | null, frame: HTMLElement | null): void {
    this.preview = camera && frame ? { camera, frame } : null;
    this.measurePreview();
  }

  /**
   * The surface calls this every frame, before the renderer's sync (ADR 0240): measure the camera
   * preview's frame once and hand the renderer its inset when it changed. The renderer never reads the DOM.
   */
  measurePreview(): void {
    const p = this.preview;
    const inset = p && this.measure ? this.measure(p.frame) : null;
    const next = p && inset ? { camera: p.camera, inset } : null;
    const was = this.previewShown;
    if (next ? was?.camera === next.camera && sameInset(was.inset, next.inset) : !was) return;
    this.previewShown = next;
    this.policy.setPolicy({ cameraPreview: next });
  }

  setParticlePreview(preview: Partial<ParticlePreviewSettings>): void {
    const p = this.playback;
    p.playing = preview.playing ?? p.playing;
    p.speed = preview.speed ?? p.speed;
    p.simulateAll = preview.simulateAll ?? p.simulateAll;
    if (this.previewing) this.policy.setPolicy({ particlePreview: this.particlePolicy() });
  }

  restartParticlePreview(): void {
    this.playback.restarts++;
    if (this.previewing) this.policy.setPolicy({ particlePreview: this.particlePolicy() });
  }

  setLodPreview(node: GameObject | null, level = 0): void {
    const was = this.lodPreviewNode;
    const group = node?.getBehavior(LODGroup) ?? null;
    // The selection path reads the service; the policy entry says the same to the renderer (ADR 0129).
    if (was && was !== node) visibilityService(was.world)?.setLodPreview(null);
    this.lodPreviewNode = group ? node : null;
    if (group) visibilityService(group.owner.world)?.setLodPreview(group, level);
    else if (node) visibilityService(node.world)?.setLodPreview(null);
    this.policy.setPolicy({ lodPreview: group && node ? { node, level } : null });
  }

  setSceneVisibility(tools: Partial<SceneVisibilityTools>): void {
    const was = this.sceneVisibility;
    const next: SceneVisibilityTools = {
      occlusion: tools.occlusion ?? was.occlusion,
      freeze: tools.freeze ?? was.freeze,
      validator: tools.validator ?? was.validator,
      debug: tools.debug ?? was.debug,
      colors: tools.colors ? { levels: [...tools.colors.levels], occluded: tools.colors.occluded } : was.colors,
    };
    this.sceneVisibility = next;
    this.policy.setPolicy({ sceneVisibility: next });
  }

  // --- Queries -----------------------------------------------------------------------------------

  occlusionDebug(world: World): OcclusionDebug | null {
    return this.sceneVisibility.debug === "occlusion" ? (visibilityService(world)?.occlusionDebug() ?? null) : null;
  }

  lodScreenHeight(node: GameObject): number | null {
    const group = node.isValid ? node.getBehavior(LODGroup) : null;
    return group ? (visibilityService(node.world)?.sceneViewHeight(group) ?? null) : null;
  }

  grid(): EditorGrid | null {
    const g = this.live()?.grid();
    return g ? { plane: this.gridState?.plane ?? "xz", ...g } : null;
  }

  pick(x: number, y: number): GameObject[] {
    return this.live()?.pick(x, y) ?? [];
  }

  rayAt(x: number, y: number): ViewRay | null {
    return this.live()?.rayAt(x, y) ?? null;
  }

  worldToCanvas(point: readonly number[]): [number, number] | null {
    return this.live()?.worldToCanvas(point) ?? null;
  }

  pointOnPlane(x: number, y: number, normal: readonly number[], point: readonly number[]): [number, number, number] | null {
    const ray = this.rayAt(x, y);
    if (!ray) return null;
    const [ox, oy, oz] = ray.origin, [dx, dy, dz] = ray.direction;
    const nz = normal[2] ?? 0, pz = point[2] ?? 0;
    const denom = normal[0] * dx + normal[1] * dy + nz * dz;
    if (Math.abs(denom) < 1e-6) return null;
    const t = (normal[0] * (point[0] - ox) + normal[1] * (point[1] - oy) + nz * (pz - oz)) / denom;
    if (t < 0) return null;
    const hit: [number, number, number] = [ox + dx * t, oy + dy * t, oz + dz * t];
    // On an axis plane, land exactly on it (no float drift on the plane's own axis).
    for (let i = 0; i < 3; i++) if (normal[i] !== 0 && normal[(i + 1) % 3] === 0 && normal[(i + 2) % 3] === 0) hit[i] = point[i] ?? 0;
    return hit;
  }

  screenBounds(root: GameObject): { node: GameObject; rect: ScreenRect }[] {
    return this.live()?.screenBounds(root) ?? [];
  }

  drawnBounds(node: GameObject): WorldBox | null {
    return this.live()?.drawnBounds(node) ?? null;
  }

  spriteSize(node: GameObject): [number, number] | null {
    const s = node.getBehavior(SpriteRenderer);
    const a = s ? this.live() : null;
    if (!s || !a) return null; // headless, or not loaded yet: like every query, nothing
    return s.size ? [s.size.x, s.size.y] : a.spriteSize(s);
  }

  gizmoActiveAt(x: number, y: number): boolean {
    return this.live()?.gizmoActiveAt(x, y) ?? false;
  }

  overlayHandles(): { id: string; x: number; y: number }[] {
    return this.live()?.overlayHandles() ?? [];
  }

  pickOverlayHandle(x: number, y: number, radius = 9): string | null {
    let best: string | null = null, bestDistance = radius;
    for (const h of this.overlayHandles()) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d <= bestDistance) {
        bestDistance = d;
        best = h.id;
      }
    }
    return best;
  }

  lightIcons(): { node: GameObject; x: number; y: number }[] {
    return this.live()?.lightIcons() ?? [];
  }

  pickUI(x: number, y: number): UIComponentType[] {
    const ui = this.live()?.ui();
    return ui ? ui.pickAll(x, y, this.rayAt(x, y)) : [];
  }

  pickUICanvases(x: number, y: number): UICanvas[] {
    const ui = this.live()?.ui();
    return ui ? ui.pickCanvases(x, y, this.rayAt(x, y)) : [];
  }

  uiElementBox(c: UIComponentType): { points: [number, number][]; size: readonly [number, number]; clip: [number, number][] | null; layoutPoints: [number, number][] | null } | null {
    const corners = this.live()?.ui()?.cornersOf(c);
    if (!corners) return null;
    const onCanvas = (points: number[][]): [number, number][] | null => {
      if (corners.space === "screen") return points.map((p) => [p[0], p[1]]);
      const out: [number, number][] = [];
      for (const p of points) {
        const q = this.worldToCanvas(p);
        if (!q) return null;
        out.push(q);
      }
      return out;
    };
    const points = onCanvas(corners.points);
    if (!points) return null;
    // ADR 0422: the drawn part, when an `overflow: hidden` ancestor clips it.
    // ADR 0422 wave 3: `points` are as drawn (transformed); `layoutPoints` where layout put it in its parent's frame.
    return { points, size: corners.size, clip: corners.clip ? onCanvas(corners.clip) : null, layoutPoints: onCanvas(corners.layoutPoints) };
  }

  bakeReflectionProbe(probe: ReflectionProbe): Promise<ArrayBuffer> {
    const a = this.live();
    return a ? a.bakeReflectionProbe(probe) : Promise.reject(new Error("the renderer hasn't started yet"));
  }
}
