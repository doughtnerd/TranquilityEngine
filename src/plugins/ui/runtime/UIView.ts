/**
 * `UIView` (ADR 0419): game UI from a Svelte component. It makes a canvas under its node (components never
 * write a canvas tag), mounts the component onto it through the engine's renderer, and passes data in
 * through `props`, which is reactive. The component's elements are ordinary UI elements: laid out, drawn
 * and clicked by the UI core, styled by every component's CSS.
 *
 * `UIView` never imports Svelte (ADR 0421): a compiled component's module mounts itself (its `$mount`, made
 * by compile.mjs) with the Svelte and renderer it was linked with, the editor's shared runtime or the game's
 * own bundle at export. The cascade loads the first time a World has a view. The view mounts once it has
 * (`ready`); it unmounts when disabled or removed, and mounts again (fresh state) when enabled. A new
 * version of the component (hot reload) mounts again in the frame it appears.
 */
import { Component } from "../../../engine/core/Component";
import { Vector2 } from "../../../engine/core/math";
import { AssetRef, component, field } from "../../../engine/core/registry";
import { Assets, normalizeAssetPath } from "../../../engine/scene/Assets";
import type { UICanvasMode } from "../../../engine/ui/components";
import { loadUIHostSupport, UIHostTree, type UIHostElement } from "../../../engine/ui/host/UIHost";

/** A mounted component: the renderer's `MountedView`, as far as `UIView` uses it. */
interface Mounted {
  /** The props the component sees, reactive. */
  readonly props: Record<string, unknown>;
  /** Apply queued updates now. */
  flush(): void;
  unmount(): void;
}

/** What a compiled component's module exports to be mounted: `$mount(host, props)`. */
type MountComponent = (host: UIHostTree, props: Record<string, unknown>) => Mounted;

/** A compiled component module's mount function, or null for a value that isn't one. */
function mountOf(module: unknown): MountComponent | null {
  const mount = (module as { $mount?: unknown } | null)?.$mount;
  return typeof mount === "function" ? (mount as MountComponent) : null;
}

let supportLoaded = false;
let supportLoading: Promise<void> | null = null;

/** Load the cascade and selector reader (once). */
function loadViewSupport(): Promise<void> {
  if (supportLoaded) return Promise.resolve();
  supportLoading ??= loadUIHostSupport().then(
    () => {
      supportLoaded = true;
    },
    (err: unknown) => {
      supportLoading = null;
      throw err;
    },
  );
  return supportLoading;
}

@component("engine.UIView")
export class UIView extends Component {
  /** The Svelte component (`asset:ui/hud.svelte`). */
  @field(AssetRef, { kind: "svelte" }) component = "";
  /** The canvas's settings (as `UICanvas`'s): `screen` covers the canvas, `world` is a panel in the scene. */
  @field(String, { choices: ["screen", "world"] }) mode: UICanvasMode = "screen";
  /** The UI's design size in UI pixels. */
  @field(Vector2) referenceResolution = new Vector2(1280, 720);
  /** 0: scale with the canvas width; 1: with its height; between: a blend. */
  @field(Number) matchHeight = 1;
  /** Screen canvases draw (and take the pointer) in ascending order: higher is on top. */
  @field(Number) sortOrder = 0;
  /** World mode: world units per UI pixel. */
  @field(Number) pixelSize = 0.01;
  /** While it has a focusable element, focus can't leave it (ADR 0340). */
  @field(Boolean) modal = false;
  /** Focus the first focusable element when the view becomes active. */
  @field(Boolean) autoFocus = false;
  /** The local player whose UI actions drive it; -1: any local player. */
  @field(Number) player = -1;

  private staging: Record<string, unknown> = {};
  private tree: UIHostTree | null = null;
  private mounted: Mounted | null = null;
  private mountedFrom: { path: string; value: unknown } | null = null;
  private stopFlush: (() => void) | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private generation = 0;

  /**
   * The component's props. Reactive once mounted: `view.props.score = 10` (or a change inside a prop's
   * object or array) shows in the same frame. Assigning an object replaces every prop.
   */
  get props(): Record<string, unknown> {
    return this.mounted?.props ?? this.staging;
  }

  set props(value: Record<string, unknown>) {
    const target = this.props;
    for (const k of Object.keys(target)) if (!(k in value)) delete target[k];
    Object.assign(target, value);
    if (target !== this.staging) this.staging = { ...value };
  }

  /** Resolves once the component is mounted (at once if it is). */
  get ready(): Promise<void> {
    if (this.mounted) return Promise.resolve();
    return (this.readyPromise ??= new Promise<void>((resolve) => (this.readyResolve = resolve)));
  }

  /** The canvas the component renders into, or null before it's mounted. */
  get root(): UIHostElement | null {
    return this.tree?.root ?? null;
  }

  /** The first rendered element a selector matches (`#play`, `.row button`), or null. */
  query(selector: string): UIHostElement | null {
    return this.tree?.isValid ? this.tree.query(selector) : null;
  }

  /** Every rendered element a selector matches, in tree order. */
  queryAll(selector: string): UIHostElement[] {
    return this.tree?.isValid ? this.tree.queryAll(selector) : [];
  }

  // --- Lifecycle --------------------------------------------------------------------------------

  /** @internal The editor shows a view's elements in the scene being edited. */
  override get _activatesInEditMode(): boolean {
    return true;
  }

  /** @internal */
  override _onActivate(): void {
    const generation = ++this.generation;
    if (supportLoaded) this.mount();
    else {
      loadViewSupport().then(
        () => {
          if (generation === this.generation && this.isActiveAndEnabled && !this.mounted) this.mount();
        },
        (err: unknown) => console.error("[myco] couldn't load the UI cascade for a UIView:", err),
      );
    }
  }

  /** @internal */
  override _onDeactivate(): void {
    this.generation++;
    this.teardown(true);
  }

  /** @internal */
  override _onDetach(): void {
    this.generation++;
    // Called while the World flushes its destroys: queue the tree (that flush picks it up), never flush again here.
    this.teardown(false);
  }

  /**
   * Make the canvas and mount the component on it. The canvas is made without a component too (the field
   * empty, the asset missing or broken), so the frame's check below mounts it once that's fixed.
   */
  private mount(): void {
    const path = normalizeAssetPath(this.component);
    const value = path && Assets.has(path) ? Assets.get(path) : undefined;
    this.mountedFrom = { path, value };
    const tree = new UIHostTree(this._world, this.node, path || "ui");
    this.tree = tree;
    this.copyCanvasFields();
    // Each frame, before the tree restyles: hot reload, the canvas settings, then Svelte's queued updates.
    this.stopFlush = tree.onFlush(() => {
      if (this.sourceChanged()) {
        this.teardown(true);
        this.mount();
        return;
      }
      this.copyCanvasFields();
      this.mounted?.flush();
    });
    if (!path) return;
    const mount = mountOf(value);
    if (!mount) {
      console.warn(`[myco] UIView on "${this.node.name}": ${value === undefined ? `there's no component "${path}"` : `"${path}" isn't a compiled Svelte component`}.`);
      return;
    }
    try {
      this.mounted = mount(tree, this.staging);
    } catch (err) {
      console.error(`[myco] UIView on "${this.node.name}": "${path}" threw while mounting:`, err);
      return;
    }
    const resolve = this.readyResolve;
    this.readyPromise = null;
    this.readyResolve = null;
    resolve?.();
  }

  private sourceChanged(): boolean {
    const from = this.mountedFrom;
    if (!from) return false;
    const path = normalizeAssetPath(this.component);
    if (path !== from.path) return true;
    const now = path && Assets.has(path) ? Assets.get(path) : undefined;
    return now !== from.value;
  }

  private copyCanvasFields(): void {
    const c = this.tree?.root.component;
    if (!c) return;
    const canvas = c as unknown as Record<string, unknown>;
    canvas.mode = this.mode;
    const res = canvas.referenceResolution as Vector2;
    if (res.x !== this.referenceResolution.x || res.y !== this.referenceResolution.y) canvas.referenceResolution = new Vector2(this.referenceResolution.x, this.referenceResolution.y);
    canvas.matchHeight = this.matchHeight;
    canvas.sortOrder = this.sortOrder;
    canvas.pixelSize = this.pixelSize;
    canvas.modal = this.modal;
    canvas.autoFocus = this.autoFocus;
    canvas.player = this.player;
  }

  private teardown(flush: boolean): void {
    this.stopFlush?.();
    this.stopFlush = null;
    const mounted = this.mounted;
    this.mounted = null;
    if (mounted) {
      this.staging = { ...mounted.props };
      try {
        mounted.unmount();
      } catch (err) {
        console.error(`[myco] UIView on "${this.node.name}": unmounting threw:`, err);
      }
    }
    this.tree?.dispose(flush);
    this.tree = null;
    this.mountedFrom = null;
  }
}
