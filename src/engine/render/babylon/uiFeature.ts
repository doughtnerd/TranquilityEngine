/**
 * The game UI as a render feature of the Babylon backend (ADR 0069, 0076, 0130): `UICore` lays out and
 * routes, `ui.ts` draws it with Babylon GUI, and (editor) a second passive core and drawing lay the
 * screen UI out at the camera preview inset's size. The renderer loads this whole module lazily through
 * a `FeatureSlot` (games without UI never download Yoga or Babylon GUI), so it imports them statically.
 * The UI plugin registers it (`src/plugins/ui/runtime/`, ADR 0140).
 */
import type { Layer } from "@babylonjs/core/Layers/layer.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import type { Component } from "../../core/Component";
import type { World } from "../../core/World";
import type { WarmContent } from "../../scene/warmUp";
import { isUIComponent } from "../../ui/components";
import { loadBundledFont } from "../../ui/fonts";
import { UICore } from "../../ui/UICore";
import { Text, type Camera } from "../components";
import type { FeatureSyncContext, UIFeatureApi } from "./feature";
import { BabylonUI, measureText, warmWorldCanvas } from "./ui";
import { WARM_PREFIX, type WarmItem } from "./warmUp";

/** What the UI feature takes from the renderer (ADR 0130). */
export interface BabylonUIHost {
  readonly scene: Scene;
  /** A texture for a UI image's reference (the material library's). */
  texture(ref: string): Promise<Texture>;
  /** The main view camera (world-space canvases face it, UI picking uses it), or null. */
  viewCamera(): Camera | null;
  /** Whether buttons and fields take the pointer: false in the editor's scene view (clicks select instead). */
  interactive(): boolean;
  /**
   * The editor's camera preview inset as fractions of the canvas (x and width from the left, top and
   * height from the top), or null when there's none to draw.
   */
  previewRect(): { x: number; top: number; width: number; height: number } | null;
  /** The drawing canvas's size in CSS pixels and its device pixel ratio. */
  canvasSize(): { cssW: number; cssH: number; pixelRatio: number };
  /** Set (or clear with null) the frame graph's screen UI layer hook (`BabylonFrame.ui`). */
  setFrameUI(draw: (() => Layer | null) | null): void;
  /** Set (or clear) the frame graph's camera preview UI layer hook (`BabylonFrame.previewUI`). */
  setFramePreviewUI(draw: (() => Layer | null) | null): void;
}

/** The frame graph's layer hook for a drawing's screen texture. */
function frameHook(draw: BabylonUI): () => Layer | null {
  const screen = draw.screen;
  return () => {
    screen._checkUpdate(null);
    return screen._layerToDispose;
  };
}

/** @internal The game UI. */
export class BabylonUIFeature implements UIFeatureApi {
  private readonly draw: BabylonUI;
  private readonly uiCore: UICore;
  private preview: { core: UICore; draw: BabylonUI } | null = null;
  private disposed = false;

  /** Loads the bundled Inter first, so text isn't measured in a fallback font before the first layout. */
  static async create(host: BabylonUIHost): Promise<BabylonUIFeature> {
    await loadBundledFont();
    return new BabylonUIFeature(host);
  }

  /** Once the bundled font has loaded (`loadBundledFont`): the UI plugin's factory (ADR 0140). */
  static fromHost(host: BabylonUIHost): BabylonUIFeature {
    return new BabylonUIFeature(host);
  }

  private constructor(private readonly host: BabylonUIHost) {
    this.draw = new BabylonUI(host.scene, { texture: (ref) => host.texture(ref) });
    this.uiCore = new UICore({
      interactive: host.interactive(),
      host: { viewCamera: () => host.viewCamera(), measureText },
    });
    host.setFrameUI(frameHook(this.draw));
  }

  /** The layout and routing core (the surface's `uiState()` and the editor read it). */
  core(): UICore {
    return this.uiCore;
  }

  /** Whether the editor's preview inset has its UI built (the frame plan's `preview.ui`). */
  hasPreviewUI(): boolean {
    return this.preview !== null;
  }

  sync(world: World, _ctx?: FeatureSyncContext): void {
    if (this.disposed) return;
    const { cssW, cssH, pixelRatio } = this.host.canvasSize();
    const core = this.uiCore;
    core.setInteractive(this.host.interactive());
    core.sync(world, cssW, cssH, world.time.unscaledDeltaTime);
    this.draw.sync(world, core, { caretOf: (c) => core.caretOf(c) }, cssW, cssH, pixelRatio);
    this.draw.syncTexts(world, cssW, cssH);
    this.syncPreview(world, cssW, cssH, pixelRatio);
  }

  /** Editor: lay the screen UI out at the camera preview inset's size and draw it there (or drop it when there's no inset). */
  private syncPreview(world: World, cssW: number, cssH: number, pixelRatio: number): void {
    const rect = this.host.previewRect();
    if (!rect) {
      if (this.preview) {
        this.host.setFramePreviewUI(null);
        this.preview.core.dispose();
        this.preview.draw.dispose();
        this.preview = null;
      }
      return;
    }
    if (!this.preview) {
      const host = this.host;
      this.preview = {
        core: new UICore({ interactive: false, passive: true, host: { measureText } }),
        draw: new BabylonUI(host.scene, { texture: (ref) => host.texture(ref), screenOnly: true }),
      };
      host.setFramePreviewUI(frameHook(this.preview.draw));
    }
    const { core, draw } = this.preview;
    const w = rect.width * cssW, h = rect.height * cssH;
    core.sync(world, w, h, 0);
    draw.sync(world, core, {}, w, h, pixelRatio, { x: rect.x * cssW, y: rect.top * cssH });
    draw.syncTexts(world, w, h);
  }

  release(c: Component): void {
    if (isUIComponent(c)) {
      this.uiCore.release(c);
      this.draw.release(c);
      this.preview?.core.release(c);
      this.preview?.draw.release(c);
    } else if (c instanceof Text) {
      this.draw.release(c);
      this.preview?.draw.release(c);
    }
  }

  /** ADR 0076: a world-space UI canvas's plane to warm, the GUI's material on a plane. */
  warm(content: WarmContent): WarmItem[] {
    if (!content.worldUI) return [];
    return [{ key: "worldUI", build: (at) => warmWorldCanvas(this.host.scene, `${WARM_PREFIX}canvas`, at) }];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.host.setFrameUI(null);
    this.host.setFramePreviewUI(null);
    this.uiCore.dispose();
    this.draw.dispose();
    this.preview?.core.dispose();
    this.preview?.draw.dispose();
    this.preview = null;
  }
}
