/**
 * An in-memory render surface and editor viewport adapter, for unit tests (ADR 0128). No renderer, no
 * DOM: the "view" is a fixed orthographic camera looking along +Z (`pixelsPerUnit` canvas pixels per
 * metre, world origin at the canvas centre, +Y up), and what lies where on the canvas is whatever the
 * test puts in `rects`. It records every state call so tests can check what the editor asked for.
 */
import type { Component } from "../core/Component";
import type { World } from "../core/World";
import type { WarmContent } from "../scene/warmUp";
import type { GameObject } from "../scene/GameObject";
import type { ReflectionProbe, SpriteRenderer } from "./components";
import {
  ViewportHandle,
  type EditorColors,
  type EditorDrawing,
  type EditorOverlay,
  type EditorViewport,
  type GizmoHandlers,
  type GizmoOptions,
  type ScreenRect,
  type ViewportAdapter,
  type ViewportUI,
  type ViewRay,
  type WorldBox,
} from "./editorViewport";
import { appliedPixelRatio, noRenderDiagnostics, type PixelGrid, type RenderDiagnostics, type RenderSurface } from "./RenderSurface";
import { GAME_POLICY, type RenderPolicy, type RenderPolicyPort } from "./renderPolicy";

/** @internal A render policy port that records what the editor asked for (ADR 0129). */
export class FakeRenderPolicyPort implements RenderPolicyPort {
  /** Calls in order. */
  readonly calls: string[] = [];
  policy: RenderPolicy = { ...GAME_POLICY };

  setPolicy(change: Partial<RenderPolicy>): void {
    this.calls.push("setPolicy");
    Object.assign(this.policy, change);
  }
}

/** @internal The fake viewport adapter: state is plain fields, queries read `rects` and the fixed camera. */
export class FakeViewportAdapter implements ViewportAdapter {
  /** Setter calls in order (their names), for checking hand-over and replay. */
  readonly calls: string[] = [];
  colors: EditorColors | null = null;
  gridState = { plane: "xz" as "xz" | "xy", cellSize: 1, visible: true };
  selection: readonly GameObject[] = [];
  selectionShown = true;
  overlay: (() => EditorOverlay) | null = null;
  gizmo: { nodes: readonly GameObject[]; options: GizmoOptions; handlers: GizmoHandlers | null } | null = null;

  /** Canvas size in CSS pixels, and the fixed camera's scale. */
  width = 800;
  height = 600;
  pixelsPerUnit = 100;
  /** Each node's rectangle on the canvas; later entries draw on top. */
  readonly rects = new Map<GameObject, ScreenRect>();
  /** World boxes of nodes' meshes, and sprite sizes. */
  readonly meshBoxes = new Map<GameObject, WorldBox>();
  readonly spriteSizes = new Map<SpriteRenderer, [number, number]>();
  /** Where the gizmo's handles are on the canvas (null: no gizmo shown). */
  gizmoRect: ScreenRect | null = null;
  lightIconList: { node: GameObject; x: number; y: number }[] = [];
  uiCore: ViewportUI | null = null;
  bakeResult: ArrayBuffer | Error = new ArrayBuffer(0);

  setColors(colors: EditorColors): void {
    this.calls.push("setColors");
    this.colors = { ...colors };
  }
  setGrid(plane: "xz" | "xy", cellSize: number, visible: boolean): void {
    this.calls.push("setGrid");
    this.gridState = { plane, cellSize, visible };
  }
  setSelection(nodes: readonly GameObject[], shown: boolean): void {
    this.calls.push("setSelection");
    this.selection = [...nodes];
    this.selectionShown = shown;
  }
  setOverlay(provider: (() => EditorOverlay) | null): void {
    this.calls.push("setOverlay");
    this.overlay = provider;
  }
  setGizmo(nodes: readonly GameObject[], options: GizmoOptions, handlers: GizmoHandlers | null): void {
    this.calls.push("setGizmo");
    this.gizmo = nodes.length ? { nodes: [...nodes], options, handlers } : null;
  }
  grid(): { cellSize: number; visible: boolean; divisions: number } {
    return { cellSize: this.gridState.cellSize, visible: this.gridState.visible, divisions: 100 };
  }

  pick(x: number, y: number): GameObject[] {
    const inside = (r: ScreenRect) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    return [...this.rects].filter(([, r]) => inside(r)).map(([n]) => n).reverse();
  }

  rayAt(x: number, y: number): ViewRay {
    const s = this.pixelsPerUnit;
    return { origin: [(x - this.width / 2) / s, (this.height / 2 - y) / s, -100], direction: [0, 0, 1] };
  }

  worldToCanvas(p: readonly number[]): [number, number] {
    const s = this.pixelsPerUnit;
    return [this.width / 2 + p[0] * s, this.height / 2 - p[1] * s];
  }

  screenBounds(root: GameObject): { node: GameObject; rect: ScreenRect }[] {
    const out: { node: GameObject; rect: ScreenRect }[] = [];
    const visit = (n: GameObject): void => {
      const rect = this.rects.get(n);
      if (rect) out.push({ node: n, rect });
      for (const c of n.children) visit(c);
    };
    visit(root);
    return out;
  }

  meshBounds(node: GameObject): WorldBox | null {
    return this.meshBoxes.get(node) ?? null;
  }

  spriteSize(sprite: SpriteRenderer): [number, number] | null {
    return this.spriteSizes.get(sprite) ?? null;
  }

  gizmoActiveAt(x: number, y: number): boolean {
    const r = this.gizmo ? this.gizmoRect : null;
    return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  overlayHandles(): { id: string; x: number; y: number }[] {
    return (this.overlay?.().handles ?? []).map((h) => {
      const [x, y] = this.worldToCanvas(h.position);
      return { id: h.id, x, y };
    });
  }

  lightIcons(): { node: GameObject; x: number; y: number }[] {
    return this.lightIconList;
  }

  ui(): ViewportUI | null {
    return this.uiCore;
  }

  drawn(): EditorDrawing {
    const o = this.overlay?.();
    const segments = (o?.lines.reduce((n, l) => n + l.points.length - (l.closed ? 0 : 1), 0) ?? 0) + (o?.segments?.reduce((n, s) => n + s.positions.length / 6, 0) ?? 0);
    const outlines = this.selectionShown ? this.selection.length : 0;
    return { segments, handles: o?.handles.length ?? 0, outlines, drawnObjects: 0, lightWires: 0, cameraPreview: false };
  }

  bakeReflectionProbe(_probe: ReflectionProbe): Promise<ArrayBuffer> {
    return this.bakeResult instanceof Error ? Promise.reject(this.bakeResult) : Promise.resolve(this.bakeResult);
  }
}

/** A canvas stand-in: an event target with a size, at the page's origin. */
function fakeCanvas(adapter: FakeViewportAdapter): HTMLCanvasElement {
  const canvas = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.defineProperties(canvas, {
    clientWidth: { get: () => adapter.width },
    clientHeight: { get: () => adapter.height },
  });
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: adapter.width, bottom: adapter.height, width: adapter.width, height: adapter.height, x: 0, y: 0 });
  canvas.focus = () => {};
  return canvas as unknown as HTMLCanvasElement;
}

/**
 * @internal A render surface that draws nothing, with a fake editor viewport. Its editor tools are
 * "loaded" from the start unless `loaded` is false; set it true (and call `sync`) to hand state over.
 */
export class FakeRenderSurface implements RenderSurface {
  readonly adapter = new FakeViewportAdapter();
  readonly policyPort = new FakeRenderPolicyPort();
  readonly canvas: HTMLCanvasElement;
  readonly started = Promise.resolve(true);
  loaded: boolean;
  syncs = 0;
  diagnosticsSnapshot: Partial<RenderDiagnostics> = {};
  /** The screen's pixel ratio and the tier's render scale the fake's pixel grid applies (`pixelGrid`). */
  devicePixelRatio: number;
  renderScale: number;
  private viewport: ViewportHandle | null = null;

  constructor(options: { loaded?: boolean; devicePixelRatio?: number; renderScale?: number } = {}) {
    this.loaded = options.loaded ?? true;
    this.devicePixelRatio = options.devicePixelRatio ?? 1;
    this.renderScale = options.renderScale ?? 1;
    this.canvas = fakeCanvas(this.adapter);
  }

  sync(_world: World): void {
    this.syncs++;
    this.viewport?.poll();
  }
  render(_world: World): void {}
  release(_c: Component): void {}
  releaseWorld(): void {}
  dispose(): void {}
  async preloadTextures(_paths: string[]): Promise<void> {}
  async warmUp(_set: WarmContent): Promise<void> {}

  editorViewport(): EditorViewport {
    return (this.viewport ??= new ViewportHandle(() => (this.loaded ? this.adapter : null), this.policyPort));
  }

  /** The device-pixel grid (ADR 0154): the adapter's canvas size at `appliedPixelRatio(renderScale, devicePixelRatio)`. */
  pixelGrid(): PixelGrid {
    return { width: this.adapter.width, height: this.adapter.height, pixelRatio: appliedPixelRatio(this.renderScale, this.devicePixelRatio) };
  }

  /** Draws nothing: the empty diagnostics (ADR 0154), with whatever the test put in `diagnosticsSnapshot`. */
  diagnostics(): RenderDiagnostics {
    return { ...noRenderDiagnostics(), ...this.diagnosticsSnapshot };
  }
}
