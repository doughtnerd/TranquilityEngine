/**
 * three.js render backend (ADR 0004, 0010). Internal: game code never sees anything here.
 *
 * The engine node graph is authoritative. Each frame, render sync copies world matrices into
 * three.js objects kept flat under one root, with `matrixAutoUpdate = false`.
 */
import {
  AxesHelper,
  BufferGeometry,
  CanvasTexture,
  Float32BufferAttribute,
  GridHelper,
  Color as ThreeColor,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  Sprite as ThreeSprite,
  SpriteMaterial,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector2 as ThreeVector2,
  Vector3 as ThreeVector3,
  WebGLRenderer,
  type Camera as ThreeCamera,
} from "three";
import type { Component } from "../core/Component";
import type { ProjectSettings } from "../core/settings";
import type { World, WorldKind } from "../core/World";
import { Assets } from "../scene/Assets";
import type { GameObject } from "../scene/GameObject";
import { Camera, SpriteRenderer, Text, type Anchor } from "./components";
import type { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { frustumSegments } from "./cameraGizmo";
import { localPoseFromWorld, type LocalPose } from "./gizmoMath";
import { rayQuadDistance } from "./picking";

/** @internal Editor gizmo settings (ADR 0022). */
export interface GizmoOptions {
  mode: "translate" | "rotate" | "scale";
  /** 2D view: move/scale on X and Y only, rotate around Z only. */
  planar: boolean;
  /** Snap to 0.25 m, 15° or 0.1 scale steps. */
  snap: boolean;
}

/** @internal What the editor does with a gizmo drag: one start, many changes, one end. */
export interface GizmoHandlers {
  onStart(): void;
  /** The dragged node's new local Transform values. */
  onChange(pose: LocalPose): void;
  onEnd(): void;
}

interface SpriteEntry {
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  spritePath: string | null;
}

interface CameraEntry {
  camera: OrthographicCamera | PerspectiveCamera;
  projection: string;
}

interface TextEntry {
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  canvas: HTMLCanvasElement;
  texture: CanvasTexture;
  signature: string;
  width: number;
  height: number;
}

const tmpWorld = new Matrix4();
const tmpScale = new Matrix4();
const raycaster = new Raycaster();
const ndc = new ThreeVector2();

/** Editor selection outline colour (ADR 0022). */
const OUTLINE_COLOR = 0x4c8dff;
/** Editor camera gizmos: unselected wireframe colour, icon size (fraction of view height) and click radius (CSS px). */
const CAMERA_GIZMO_COLOR = 0xc9ccd1;
const CAMERA_ICON_SIZE = 0.065;
const CAMERA_ICON_PICK_RADIUS = 16;
const tmpPoint = new ThreeVector3();
/** Draw outlines above every sprite (sprites sort by layer * 10000 + order). */
const OUTLINE_ORDER = 1e9;

export class RenderBackend {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly uiScene = new Scene();
  private readonly uiCamera: OrthographicCamera;
  private readonly quad = new PlaneGeometry(1, 1);
  private readonly loader = new TextureLoader();
  private readonly textures = new Map<string, Texture>();
  private readonly loading = new Map<string, Promise<Texture>>();
  private readonly sprites = new Map<SpriteRenderer, SpriteEntry>();
  private readonly cameras = new Map<Camera, CameraEntry>();
  private readonly texts = new Map<Text, TextEntry>();
  private readonly resizeObserver: ResizeObserver;
  private readonly warnedLayers = new Set<string>();
  private readonly clearColor: ThreeColor;

  constructor(private readonly container: HTMLElement, private readonly settings: ProjectSettings, kind: WorldKind = "runtime") {
    this.canvas = document.createElement("canvas");
    this.canvas.tabIndex = 0;
    this.canvas.style.display = "block";
    this.canvas.style.outline = "none";
    this.canvas.style.touchAction = "none";
    container.appendChild(this.canvas);

    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.autoClear = false;
    this.clearColor = new ThreeColor(settings.display.backgroundColor);

    const { width, height } = settings.display;
    this.uiCamera = new OrthographicCamera(0, width, height, 0, -10, 10);

    // Editor Worlds fill their viewport panel and get a grid (1 m cells) and XYZ axes, so an
    // empty scene has a frame of reference.
    this.fill = kind === "editor";
    if (kind === "editor") {
      this.grid = new GridHelper(40, 40, 0x5a606b, 0x3a3f47);
      this.scene.add(this.grid, new AxesHelper(1.5));
    }

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  private readonly fill: boolean;
  private grid: GridHelper | null = null;

  /** @internal Editor: lay the grid on the ground (XZ, 3D view) or facing the camera (XY, 2D view). */
  setEditorGridPlane(plane: "xz" | "xy"): void {
    if (!this.grid) return;
    this.grid.rotation.x = plane === "xy" ? Math.PI / 2 : 0;
  }

  /** Width / height that cameras render at: the canvas when filling, else the reference resolution. */
  private get aspect(): number {
    if (this.fill && this.canvas.clientHeight > 0) return this.canvas.clientWidth / this.canvas.clientHeight;
    return this.settings.display.width / this.settings.display.height;
  }

  /** Fit the canvas to the container: fill it (editor) or keep the reference aspect ratio (letterboxed). */
  private resize(): void {
    const { width, height } = this.settings.display;
    const cw = this.container.clientWidth || width;
    const ch = this.container.clientHeight || height;
    if (this.fill) {
      this.renderer.setSize(Math.floor(cw), Math.floor(ch), true);
      return;
    }
    const aspect = width / height;
    let w = cw, h = cw / aspect;
    if (h > ch) {
      h = ch;
      w = ch * aspect;
    }
    this.renderer.setSize(Math.floor(w), Math.floor(h), true);
  }

  /** Load textures ahead of time so sprites don't pop in. */
  async preloadTextures(paths: string[], onProgress?: (p: number) => void): Promise<void> {
    let done = 0;
    await Promise.all(
      paths.map((p) =>
        this.texture(p)
          .catch((err) => console.error(`[tranquility] failed to load texture "${p}":`, err))
          .finally(() => onProgress?.(++done / paths.length)),
      ),
    );
  }

  private texture(path: string): Promise<Texture> {
    const cached = this.textures.get(path);
    if (cached) return Promise.resolve(cached);
    let p = this.loading.get(path);
    if (!p) {
      p = this.loader.loadAsync(Assets.url(path)).then((tex) => {
        tex.colorSpace = SRGBColorSpace;
        this.textures.set(path, tex);
        this.loading.delete(path);
        return tex;
      });
      this.loading.set(path, p);
    }
    return p;
  }

  /** @internal Release three.js objects for a removed component. */
  release(c: Component): void {
    if (c instanceof SpriteRenderer) {
      const e = this.sprites.get(c);
      if (e) {
        this.scene.remove(e.mesh);
        e.mesh.material.dispose();
        this.sprites.delete(c);
      }
    } else if (c instanceof Camera) {
      this.cameras.delete(c);
    } else if (c instanceof Text) {
      const e = this.texts.get(c);
      if (e) {
        this.uiScene.remove(e.mesh);
        e.mesh.material.dispose();
        e.texture.dispose();
        this.texts.delete(c);
      }
    }
  }

  /** Step 8: mirror engine components into three.js. */
  sync(world: World): void {
    for (const s of world._componentsOfType(SpriteRenderer)) this.syncSprite(world, s);
    for (const c of world._componentsOfType(Camera)) this.syncCamera(world, c);
    for (const t of world._componentsOfType(Text)) this.syncText(t);
    if (this.fill) {
      this.syncOutlines();
      this.syncCameraGizmos(world);
      this.syncGizmo(world);
    }
  }

  private sortOrder(layer: string, order: number): number {
    let index = this.settings.render.sortingLayers.indexOf(layer);
    if (index < 0) {
      if (!this.warnedLayers.has(layer)) {
        this.warnedLayers.add(layer);
        console.warn(`[tranquility] unknown sorting layer "${layer}"; add it to project settings render.sortingLayers.`);
      }
      index = 0;
    }
    return index * 10000 + order;
  }

  private syncSprite(world: World, s: SpriteRenderer): void {
    let entry = this.sprites.get(s);
    if (!entry) {
      const material = new MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
      const mesh = new Mesh(this.quad, material);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      entry = { mesh, spritePath: null };
      this.sprites.set(s, entry);
    }
    const { mesh } = entry;
    const material = mesh.material;

    if (entry.spritePath !== s.sprite) {
      entry.spritePath = s.sprite;
      const tex = s.sprite ? this.textures.get(s.sprite) : null;
      material.map = tex ?? null;
      material.needsUpdate = true;
      if (s.sprite && !tex) {
        const requested = s.sprite;
        this.texture(requested)
          .then(() => {
            if (entry!.spritePath === requested) entry!.spritePath = null; // re-resolve next sync
          })
          .catch((err) => console.error(`[tranquility] failed to load texture "${requested}":`, err));
      }
    }

    const ready = !s.sprite || !!material.map;
    mesh.visible = s.isActiveAndEnabled && ready;
    if (!mesh.visible) return;

    material.color.setRGB(s.color.r, s.color.g, s.color.b, SRGBColorSpace);
    material.opacity = s.color.a;
    mesh.renderOrder = this.sortOrder(s.sortingLayer, s.orderInLayer);

    let w = 1, h = 1;
    if (s.size) {
      w = s.size.x;
      h = s.size.y;
    } else if (material.map) {
      const img = material.map.image as { width: number; height: number };
      const ppu = s.pixelsPerUnit > 0 ? s.pixelsPerUnit : this.settings.render.pixelsPerUnit;
      w = img.width / ppu;
      h = img.height / ppu;
    }
    const e = s.node.entity;
    tmpWorld.fromArray(world.worldMatrix(e), e * 16);
    tmpScale.makeScale(s.flipX ? -w : w, s.flipY ? -h : h, 1);
    mesh.matrix.multiplyMatrices(tmpWorld, tmpScale);
    mesh.matrixWorldNeedsUpdate = true;
  }

  private syncCamera(world: World, c: Camera): void {
    let entry = this.cameras.get(c);
    if (!entry || entry.projection !== c.projection) {
      const camera = c.projection === "perspective" ? new PerspectiveCamera() : new OrthographicCamera();
      camera.matrixAutoUpdate = false;
      entry = { camera, projection: c.projection };
      this.cameras.set(c, entry);
    }
    const { camera } = entry;
    const aspect = this.aspect;
    if (camera instanceof OrthographicCamera) {
      const s = c.orthographicSize;
      camera.left = -s * aspect;
      camera.right = s * aspect;
      camera.top = s;
      camera.bottom = -s;
    } else {
      camera.fov = c.fieldOfView;
      camera.aspect = aspect;
    }
    camera.near = c.near;
    camera.far = c.far;
    camera.updateProjectionMatrix();
    const e = c.node.entity;
    camera.matrix.fromArray(world.worldMatrix(e), e * 16);
    camera.updateMatrixWorld(true);
  }

  private syncText(t: Text): void {
    let entry = this.texts.get(t);
    if (!entry) {
      const canvas = document.createElement("canvas");
      const texture = new CanvasTexture(canvas);
      texture.colorSpace = SRGBColorSpace;
      const material = new MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
      const mesh = new Mesh(this.quad, material);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      this.uiScene.add(mesh);
      entry = { mesh, canvas, texture, signature: "", width: 0, height: 0 };
      this.texts.set(t, entry);
    }
    entry.mesh.visible = t.isActiveAndEnabled && t.text.length > 0;
    if (!entry.mesh.visible) return;

    const outline = t.outlineColor && t.outlineWidth > 0 ? `${t.outlineColor.toCss()}/${t.outlineWidth}` : "";
    const signature = [t.text, t.fontSize, t.fontFamily, t.fontWeight, t.color.toCss(), outline, t.align, t.lineHeight].join("|");
    if (signature !== entry.signature) {
      entry.signature = signature;
      this.drawText(t, entry);
    }

    const { width: W, height: H } = this.settings.display;
    const [ax, ay] = anchorFactors(t.anchor);
    // Anchor point on screen (UI camera space: origin bottom-left, +y up).
    const sx = ax * W + t.offset.x;
    const sy = (1 - ay) * H - t.offset.y;
    // Place the text box so its own anchor point sits at the screen anchor.
    const cx = sx + (0.5 - ax) * entry.width;
    const cy = sy - (0.5 - ay) * entry.height;
    entry.mesh.matrix.makeScale(entry.width, entry.height, 1).setPosition(cx, cy, 0);
    entry.mesh.matrixWorldNeedsUpdate = true;
  }

  private drawText(t: Text, entry: TextEntry): void {
    const scale = Math.min(window.devicePixelRatio || 1, 2) * 2; // supersample for crisp edges
    const ctx = entry.canvas.getContext("2d")!;
    const font = `${t.fontWeight} ${t.fontSize}px ${t.fontFamily}`;
    ctx.font = font;
    const lines = t.text.split("\n");
    const pad = Math.ceil(t.outlineWidth + 2);
    const lineH = t.fontSize * t.lineHeight;
    const width = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2);
    const height = Math.ceil(lineH * lines.length + pad * 2);
    entry.canvas.width = width * scale;
    entry.canvas.height = height * scale;
    ctx.scale(scale, scale);
    ctx.font = font;
    ctx.textBaseline = "middle";
    ctx.textAlign = t.align;
    ctx.lineJoin = "round";
    const x = t.align === "left" ? pad : t.align === "right" ? width - pad : width / 2;
    lines.forEach((line, i) => {
      const y = pad + lineH * (i + 0.5);
      if (t.outlineColor && t.outlineWidth > 0) {
        ctx.strokeStyle = t.outlineColor.toCss();
        ctx.lineWidth = t.outlineWidth * 2;
        ctx.strokeText(line, x, y);
      }
      ctx.fillStyle = t.color.toCss();
      ctx.fillText(line, x, y);
    });
    entry.width = width;
    entry.height = height;
    // Canvas size changed: replace the GPU texture.
    entry.texture.dispose();
    entry.texture = new CanvasTexture(entry.canvas);
    entry.texture.colorSpace = SRGBColorSpace;
    entry.mesh.material.map = entry.texture;
    entry.mesh.material.needsUpdate = true;
  }

  /** Step 9: render each enabled camera in depth order, then the UI. */
  render(world: World): void {
    const r = this.renderer;
    const cams = this.viewCameras(world);
    if (!cams.length) {
      r.setClearColor(this.clearColor, 1);
      r.clear(true, true, true);
    }
    cams.forEach((c, i) => {
      if (i === 0) {
        r.setClearColor(c.backgroundColor ? new ThreeColor(c.backgroundColor.toHex()) : this.clearColor, 1);
        r.clear(true, true, true);
      } else {
        r.clearDepth();
      }
      r.render(this.scene, this.cameras.get(c)!.camera as ThreeCamera);
    });
    r.clearDepth();
    r.render(this.uiScene, this.uiCamera);
  }

  /** Enabled cameras that draw the view, in depth order. */
  private viewCameras(world: World): Camera[] {
    return world
      ._componentsOfType(Camera)
      // A scene open in the editor keeps its cameras, but the editor's scene camera draws the view (ADR 0026).
      .filter((c) => c.isActiveAndEnabled && this.cameras.has(c) && !world.inEditMode(c.node.entity))
      .sort((a, b) => a.depth - b.depth);
  }

  // --- Editor: picking and selection outline (ADR 0022) ---------------------------------------

  private readonly outlined = new Set<GameObject>();
  private readonly outlines: LineLoop[] = [];
  private outlineGeometry: BufferGeometry | null = null;
  private outlineMaterial: LineBasicMaterial | null = null;

  /**
   * @internal Editor: nodes whose renderers lie under a canvas point (CSS pixels, origin
   * top-left), topmost first: screen-space text, then sprites by draw order (they draw without
   * depth testing), then nearest. Uses the camera that draws the view (the first in depth order).
   */
  pick(world: World, x: number, y: number): GameObject[] {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return [];
    const hits: { node: GameObject; order: number; distance: number }[] = [];

    // Screen-space text: the UI camera maps the reference resolution onto the canvas.
    const { width: W, height: H } = this.settings.display;
    const ux = (x / w) * W, uy = (1 - y / h) * H;
    for (const [t, entry] of this.texts) {
      if (!entry.mesh.visible) continue;
      const e = entry.mesh.matrix.elements; // scale (width, height) and position (cx, cy)
      if (Math.abs(ux - e[12]) <= e[0] / 2 && Math.abs(uy - e[13]) <= e[5] / 2) hits.push({ node: t.node, order: Infinity, distance: 0 });
    }

    const view = this.viewCameras(world)[0];
    const camera = view && this.cameras.get(view)?.camera;
    if (camera) {
      ndc.set((x / w) * 2 - 1, -(y / h) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      for (const [s, entry] of this.sprites) {
        if (!entry.mesh.visible) continue;
        entry.mesh.updateMatrixWorld();
        const distance = rayQuadDistance(raycaster.ray, entry.mesh.matrixWorld);
        if (distance !== null) hits.push({ node: s.node, order: entry.mesh.renderOrder, distance });
      }
    }

    // Camera icons: a small circle on screen around each icon, above every sprite.
    if (camera) {
      for (const [c, entry] of this.cameraGizmos) {
        if (!entry.icon.visible) continue;
        tmpPoint.setFromMatrixPosition(entry.icon.matrixWorld).project(camera);
        if (tmpPoint.z < -1 || tmpPoint.z > 1) continue; // behind the camera or beyond far
        const sx = ((tmpPoint.x + 1) / 2) * w, sy = ((1 - tmpPoint.y) / 2) * h;
        if (Math.hypot(sx - x, sy - y) <= CAMERA_ICON_PICK_RADIUS) hits.push({ node: c.node, order: OUTLINE_ORDER, distance: 0 });
      }
    }

    hits.sort((a, b) => b.order - a.order || a.distance - b.distance);
    const seen = new Set<number>();
    return hits.filter((h) => !seen.has(h.node.entity) && seen.add(h.node.entity)).map((h) => h.node);
  }

  /**
   * @internal Editor: the world point on the plane z = `z` under a canvas point (CSS pixels),
   * seen through the camera that draws the view; null if the ray misses the plane (looking
   * along it or away from it).
   */
  pointOnPlaneZ(world: World, x: number, y: number, z = 0): [number, number, number] | null {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const view = this.viewCameras(world)[0];
    const camera = view && this.cameras.get(view)?.camera;
    if (!camera || w <= 0 || h <= 0) return null;
    ndc.set((x / w) * 2 - 1, -(y / h) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const { origin, direction } = raycaster.ray;
    if (Math.abs(direction.z) < 1e-6) return null;
    const t = (z - origin.z) / direction.z;
    if (t < 0) return null;
    return [origin.x + direction.x * t, origin.y + direction.y * t, z];
  }

  /** @internal Editor: outline the sprites of these nodes and their descendants, every frame. */
  setSelectionOutline(nodes: readonly GameObject[]): void {
    this.outlined.clear();
    for (const n of nodes) this.outlined.add(n);
  }

  /** Position one outline per selected sprite (called from `sync`, after sprites). */
  private syncOutlines(): void {
    let used = 0;
    if (this.outlined.size > 0) {
      for (const [s, entry] of this.sprites) {
        if (!entry.mesh.visible || !this.isOutlined(s.node)) continue;
        const line = this.outlines[used] ?? this.createOutline();
        line.matrix.copy(entry.mesh.matrix);
        line.matrixWorldNeedsUpdate = true;
        line.visible = true;
        used++;
      }
    }
    for (let i = used; i < this.outlines.length; i++) this.outlines[i].visible = false;
  }

  private isOutlined(node: GameObject): boolean {
    for (const n of this.outlined) {
      if (!n.isValid) continue;
      for (let p: GameObject | null = node; p; p = p.parent) if (p === n) return true;
    }
    return false;
  }

  private createOutline(): LineLoop {
    this.outlineGeometry ??= new BufferGeometry().setAttribute(
      "position",
      new Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
    );
    this.outlineMaterial ??= new LineBasicMaterial({ color: OUTLINE_COLOR, depthTest: false, depthWrite: false, transparent: true });
    const line = new LineLoop(this.outlineGeometry, this.outlineMaterial);
    line.matrixAutoUpdate = false;
    line.frustumCulled = false;
    line.renderOrder = OUTLINE_ORDER;
    this.scene.add(line);
    this.outlines.push(line);
    return line;
  }

  // --- Editor: camera gizmos (ADR 0022) --------------------------------------------------------

  private readonly cameraGizmos = new Map<Camera, { icon: ThreeSprite; frustum: LineSegments<BufferGeometry, LineBasicMaterial> }>();
  private cameraIconMaterial: SpriteMaterial | null = null;

  /**
   * Cameras inside the edited scene don't draw the editor's view (see `viewCameras`), so the
   * editor shows each as an icon (clickable, constant size on screen) and a wireframe of what it
   * sees at the game's aspect ratio; selected cameras are drawn in the selection colour.
   */
  private syncCameraGizmos(world: World): void {
    const seen = new Set<Camera>();
    const aspect = this.settings.display.width / this.settings.display.height;
    // Icons keep a constant size on screen. three.js does that itself for perspective views
    // (sizeAttenuation: false) but not orthographic ones, where the scale is in world units.
    const view = this.viewCameras(world)[0];
    const viewCamera = view && this.cameras.get(view)?.camera;
    const iconScale = viewCamera instanceof OrthographicCamera ? (CAMERA_ICON_SIZE * (viewCamera.top - viewCamera.bottom)) / viewCamera.zoom : CAMERA_ICON_SIZE;
    for (const c of world._componentsOfType(Camera)) {
      if (!world.inEditMode(c.node.entity)) continue; // the editor's own camera has no gizmo
      seen.add(c);
      const entry = this.cameraGizmos.get(c) ?? this.createCameraGizmo(c);
      const visible = c.node.activeInHierarchy;
      entry.icon.visible = entry.frustum.visible = visible;
      if (!visible) continue;
      const e = c.node.entity;
      tmpWorld.fromArray(world.worldMatrix(e), e * 16);
      entry.frustum.matrix.copy(tmpWorld);
      entry.frustum.matrixWorldNeedsUpdate = true;
      const positions = entry.frustum.geometry.getAttribute("position") as Float32BufferAttribute;
      positions.copyArray(frustumSegments({ projection: c.projection, orthographicSize: c.orthographicSize, fieldOfView: c.fieldOfView, aspect, near: c.near, far: c.far }));
      positions.needsUpdate = true;
      entry.frustum.geometry.computeBoundingSphere();
      entry.frustum.material.color.setHex(this.isOutlined(c.node) ? OUTLINE_COLOR : CAMERA_GIZMO_COLOR);
      entry.icon.position.setFromMatrixPosition(tmpWorld);
      entry.icon.scale.set(iconScale, iconScale, 1);
      entry.icon.updateMatrixWorld();
    }
    for (const [c, entry] of this.cameraGizmos) {
      if (seen.has(c) && c.node.isValid) continue;
      this.scene.remove(entry.icon, entry.frustum);
      entry.frustum.geometry.dispose();
      entry.frustum.material.dispose();
      this.cameraGizmos.delete(c);
    }
  }

  private createCameraGizmo(c: Camera): { icon: ThreeSprite; frustum: LineSegments<BufferGeometry, LineBasicMaterial> } {
    this.cameraIconMaterial ??= new SpriteMaterial({
      map: cameraIconTexture(),
      sizeAttenuation: false,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    const icon = new ThreeSprite(this.cameraIconMaterial);
    icon.scale.set(CAMERA_ICON_SIZE, CAMERA_ICON_SIZE, 1);
    icon.renderOrder = OUTLINE_ORDER;
    const geometry = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(new Float32Array(24 * 3), 3));
    const frustum = new LineSegments(geometry, new LineBasicMaterial({ color: CAMERA_GIZMO_COLOR, depthTest: false, depthWrite: false, transparent: true, opacity: 0.85 }));
    frustum.matrixAutoUpdate = false;
    frustum.frustumCulled = false;
    frustum.renderOrder = OUTLINE_ORDER - 1;
    this.scene.add(frustum, icon);
    const entry = { icon, frustum };
    this.cameraGizmos.set(c, entry);
    return entry;
  }

  // --- Editor: transform gizmo (ADR 0022) ------------------------------------------------------

  private gizmo: TransformControls | null = null;
  private gizmoLoading: Promise<void> | null = null;
  /** Stand-in the gizmo moves; synced from the target node while not dragging. */
  private readonly gizmoProxy = new Object3D();
  private gizmoTarget: GameObject | null = null;
  private gizmoOptions: GizmoOptions = { mode: "translate", planar: false, snap: false };
  private gizmoHandlers: GizmoHandlers | null = null;
  private gizmoDragging = false;
  private gizmoWorld: World | null = null;

  /**
   * @internal Editor: show a move/rotate/scale gizmo on `node` (null hides it). Drags report
   * the node's new local pose through `handlers`; the editor turns them into commands.
   */
  setGizmo(node: GameObject | null, options: GizmoOptions, handlers: GizmoHandlers | null): void {
    this.gizmoTarget = node;
    this.gizmoOptions = options;
    this.gizmoHandlers = handlers;
    if (node && !this.gizmo && !this.gizmoLoading) this.gizmoLoading = this.loadGizmo();
    this.applyGizmoOptions();
  }

  /**
   * @internal Editor: true while dragging the gizmo, or if a canvas point (CSS pixels) is over
   * one of its handles. Hit-tests directly rather than trusting hover state, which is stale
   * when a press arrives without a preceding move.
   */
  gizmoActiveAt(x: number, y: number): boolean {
    const c = this.gizmo;
    if (!c || !c.enabled) return false;
    if (this.gizmoDragging) return true;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return false;
    const pointer = { x: (x / w) * 2 - 1, y: -(y / h) * 2 + 1, button: -1 };
    c.pointerHover(pointer as unknown as PointerEvent); // TransformControls takes {x, y, button} in NDC
    return c.axis !== null;
  }

  private async loadGizmo(): Promise<void> {
    // Loaded on first use so game bundles never include the editor's gizmo code.
    const { TransformControls } = await import("three/examples/jsm/controls/TransformControls.js");
    const controls = new TransformControls(new PerspectiveCamera(), this.canvas);
    this.gizmoProxy.matrixAutoUpdate = true;
    this.scene.add(this.gizmoProxy);
    const helper = controls.getHelper();
    helper.renderOrder = OUTLINE_ORDER + 1;
    this.scene.add(helper);
    controls.attach(this.gizmoProxy);
    controls.addEventListener("dragging-changed", (e) => {
      this.gizmoDragging = Boolean((e as { value?: unknown }).value);
      if (this.gizmoDragging) this.gizmoHandlers?.onStart();
      else this.gizmoHandlers?.onEnd();
    });
    controls.addEventListener("objectChange", () => {
      const pose = this.gizmoDragging ? this.gizmoPose() : null;
      if (pose) this.gizmoHandlers?.onChange(pose);
    });
    this.gizmo = controls;
    this.applyGizmoOptions();
  }

  private applyGizmoOptions(): void {
    const c = this.gizmo;
    if (!c) return;
    const { mode, planar, snap } = this.gizmoOptions;
    c.setMode(mode);
    c.showX = !(planar && mode === "rotate");
    c.showY = !(planar && mode === "rotate");
    c.showZ = !planar || mode === "rotate";
    c.setTranslationSnap(snap ? 0.25 : null);
    c.setRotationSnap(snap ? Math.PI / 12 : null);
    c.setScaleSnap(snap ? 0.1 : null);
  }

  /** The target's local pose implied by where the gizmo has moved the proxy. */
  private gizmoPose(): LocalPose | null {
    const node = this.gizmoTarget, world = this.gizmoWorld;
    if (!node?.isValid || !world) return null;
    const parent = node.parent;
    const parentWorld = parent ? new Matrix4().fromArray(world.worldMatrix(parent.entity), parent.entity * 16) : null;
    this.gizmoProxy.updateMatrix();
    return localPoseFromWorld(parentWorld, this.gizmoProxy.position, this.gizmoProxy.quaternion, this.gizmoProxy.scale);
  }

  private syncGizmo(world: World): void {
    const c = this.gizmo;
    if (!c) return;
    this.gizmoWorld = world;
    const node = this.gizmoTarget;
    const view = this.viewCameras(world)[0];
    const camera = view && this.cameras.get(view)?.camera;
    const show = !!camera && !!node?.isValid && !!node.transform && node.activeInHierarchy;
    c.enabled = show;
    c.getHelper().visible = show;
    if (!show) return;
    c.camera = camera;
    if (!this.gizmoDragging) {
      const e = node!.entity;
      tmpWorld.fromArray(world.worldMatrix(e), e * 16);
      tmpWorld.decompose(this.gizmoProxy.position, this.gizmoProxy.quaternion, this.gizmoProxy.scale);
      this.gizmoProxy.updateMatrixWorld(true);
    }
  }

  dispose(): void {
    this.gizmo?.dispose();
    this.cameraIconMaterial?.map?.dispose();
    this.cameraIconMaterial?.dispose();
    this.resizeObserver.disconnect();
    this.outlineGeometry?.dispose();
    this.outlineMaterial?.dispose();
    for (const s of [...this.sprites.keys()]) this.release(s);
    for (const t of [...this.texts.keys()]) this.release(t);
    for (const tex of this.textures.values()) tex.dispose();
    this.quad.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

/** A small camera glyph for editor camera icons: a body and lens, light with a dark outline. */
function cameraIconTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.lineJoin = "round";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "#1b1d21";
  ctx.fillStyle = "#e8eaed";
  const body = () => {
    ctx.beginPath();
    ctx.roundRect(6, 18, 36, 28, 5);
    ctx.moveTo(42, 27);
    ctx.lineTo(58, 18);
    ctx.lineTo(58, 46);
    ctx.lineTo(42, 37);
    ctx.closePath();
  };
  body();
  ctx.stroke();
  body();
  ctx.fill();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function anchorFactors(anchor: Anchor): [number, number] {
  // [x, y] with x: 0 left → 1 right, y: 0 top → 1 bottom.
  switch (anchor) {
    case "top-left": return [0, 0];
    case "top": return [0.5, 0];
    case "top-right": return [1, 0];
    case "left": return [0, 0.5];
    case "right": return [1, 0.5];
    case "bottom-left": return [0, 1];
    case "bottom": return [0.5, 1];
    case "bottom-right": return [1, 1];
    default: return [0.5, 0.5];
  }
}
