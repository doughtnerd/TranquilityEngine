// The editor contribution points the Sky pilot builds (ADR 0134): asset kinds, asset formats
// (what an asset document is made from) and panels. Each is a registry; plugins add to them
// through `EditorPluginContext` so their entries are removed when the plugin is.
import type { FunctionComponent } from "preact";
import type { ReadonlySignal } from "@preact/signals";
import { createRegistry } from "./registry";
import type { Engine } from "../../engine";
import type { World } from "../../engine/core/World";
import type { EditorOverlay, EditorOverlayKind } from "../../engine/editor";
import type { OpenScene } from "../state";

/** A component loaded on first use (ADR 0083). */
export type LoadComponent<P extends object> = () => Promise<FunctionComponent<P>>;

/**
 * One type of asset file and how the editor treats it (ADR 0133 "asset kind").
 * Built-in kinds not yet moved to a plugin still live in `assetBrowser.ts`'s tables; a registered
 * kind wins over them.
 */
export interface AssetKindContribution {
  /** The kind's id, e.g. "sky". Also what `assetKind(path)` returns. */
  readonly id: string;
  /** File-name endings, lower case with the dot, e.g. [".sky.json"]. The longest match over all kinds wins. */
  readonly extensions: readonly string[];
  /** Shown in the Assets panel ("Sky"). */
  readonly label: string;
  /** An SVG path (`d`) drawn in a 24×24 box, stroked, like the built-in asset icons. */
  readonly icon: string;
  /** Double-click / Open. Absent: the file only selects. */
  open?(path: string): void;
  /** The Inspector's view of a selected file of this kind, loaded on first use. */
  readonly inspector?: LoadComponent<{ path: string }>;
  /** An entry in the Assets panel's New… menu. `create` returns the new file's path, or null. */
  readonly create?: { readonly label: string; create(folder: string): Promise<string | null> };
  /** Policy: the field asset kinds (0131 `@field(AssetRef, { kind })`) that also accept this kind, e.g. sky → ["environment"]. */
  readonly referencedAs?: readonly string[];
  /** Which built-in thumbnail renderer draws its preview (internal tier: renderers stay first-party, ADR 0133). */
  readonly preview?: "sky" | "material" | "shadergraph" | "particles" | "environment" | "model" | "prefab" | "scene" | "audio";
}

/** A problem found reading an asset file. */
export interface AssetProblem {
  readonly message: string;
}

/** How an asset kind's file becomes a value and back: what an asset document is made from. */
export interface AssetFormatContribution<T = unknown> {
  /** The asset kind id this format is for. */
  readonly id: string;
  /** The file's parsed JSON (or undefined when missing) to a value; never throws, reports problems instead. */
  parse(raw: unknown, path: string): { value: T; problems: readonly AssetProblem[] };
  /** A value to the file's text. */
  format(value: T): string;
  /** Milliseconds to wait after the last coalesced edit before writing (sliders). Default 150. */
  readonly writeDelay?: number;
}

/** A dockable panel. */
export interface PanelContribution {
  readonly id: string;
  readonly title: string;
  readonly view: LoadComponent<object>;
  /** The panel whose group it joins when first shown. */
  readonly beside?: string;
  /** Kept out of the default layout and the idle preload; opened by something else (double-clicking an asset). */
  readonly onDemand?: boolean;
}

/** A pointer on the scene view, in canvas pixels (ADR 0137). */
export interface ViewportPointer {
  readonly x: number;
  readonly y: number;
  readonly button: number;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly pointerId: number;
}

/** A press a tool claimed: it alone gets that pointer's moves and release. */
export interface ViewportDrag {
  move?(p: ViewportPointer): void;
  end?(p: ViewportPointer): void;
  /** Play started, Escape is not involved: the tool was removed or the pointer was cancelled. Undo any preview. */
  cancel?(): void;
}

/**
 * What a viewport tool installs through, once per scene view (ADR 0137). Everything registered here
 * is removed when the install is disposed. Internal tier (ADR 0133): it exposes the Engine.
 */
export interface ViewportToolContext {
  readonly engine: Engine;
  readonly world: World;
  /** Whether this tool is the active tool. */
  readonly active: ReadonlySignal<boolean>;
  /** Become the active tool (the transform gizmo and collider editing step aside). */
  activate(): void;
  /** Give the scene view back to the transform tools, if this tool is active. */
  deactivate(): void;
  /**
   * Presses on the scene view while editing: the active tool is asked first, then the others in
   * registration order, then selection and the transform gizmo. Return a drag to claim the press.
   */
  onPress(handler: (p: ViewportPointer) => ViewportDrag | null | undefined | void): void;
  /** The pointer over the scene view while no drag runs; null when it leaves. */
  onHover(handler: (p: ViewportPointer | null) => void): void;
  /**
   * Keys while editing, outside text fields and dialogs, without Ctrl/Cmd/Alt: the active tool first.
   * Return true to consume the key. Q, W, E, R and F belong to the editor; don't take them.
   */
  onKey(handler: (e: KeyboardEvent) => boolean): void;
  /** An editor overlay on the Editor World, id `${tool id}` or `${tool id}:${suffix}`. */
  overlay(provider: () => EditorOverlay, options?: { kind?: EditorOverlayKind; suffix?: string }): void;
  /** The scene view's CSS cursor while this tool is active (null: the default). */
  setCursor(cursor: string | null): void;
  /** One undo step on the open scene's command stack: begins a group, runs `fn`, always ends it. False with no open scene. */
  edit(label: string, fn: (scene: OpenScene) => void): boolean;
}

/** A scene-view tool (ADR 0137): painting, handles, overlays. */
export interface ViewportToolContribution {
  /** e.g. "myco.tilemaps.paint". Also its overlay id and its active-tool id. */
  readonly id: string;
  /** Called for each scene view, and at once when registered while one is open. May return extra cleanup. */
  install(view: ViewportToolContext): void | (() => void);
}

export const assetKinds = createRegistry<AssetKindContribution>("Asset kind");
export const assetFormats = createRegistry<AssetFormatContribution<any>>("Asset format"); // eslint-disable-line @typescript-eslint/no-explicit-any -- formats differ in T
export const panels = createRegistry<PanelContribution>("Panel");
export const viewportTools = createRegistry<ViewportToolContribution>("Viewport tool");
