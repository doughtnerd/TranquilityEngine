// The editor contribution points (ADR 0134 onwards): asset kinds, asset formats (what an asset
// document is made from), panels, and the smaller points later records add (0138, 0142, 0146). Each
// is a registry; plugins add to them through `EditorPluginContext` so their entries are removed when
// the plugin is.
import type { FunctionComponent } from "preact";
import type { SettingsDraft } from "../projectSettingsModel";
import type { EditorProject } from "../projects";
import type { ReadonlySignal } from "@preact/signals";
import { createRegistry } from "./registry";
import type { Engine } from "../../engine";
import type { World } from "../../engine/core/World";
import type { EditorOverlay, EditorOverlayKind } from "../../engine/editor";
import type { OpenScene } from "../state";
import type { ComponentEntry, NodeEntry, NodePath, SceneDocument } from "../document";
import type { GameObject } from "../../engine/scene/GameObject";
import type { ComponentInfo } from "../../engine/editor";
import type { ImportSettings, SpriteSlice } from "../../engine/scene/importSettings";
import type { Pixels } from "../../engine/animation/sprites/islands";
import type { SliceSkin, SpriteFlipbook } from "../../engine/animation/sprites/sidecar";
import { getComponentId, type ComponentClass, type FieldChoice } from "../../engine/core/registry";
import type { Component } from "../../engine/core/Component";
import type { Wire } from "../shapeKit3d";

/** A component loaded on first use (ADR 0083). */
export type LoadComponent<P extends object> = () => Promise<FunctionComponent<P>>;

/**
 * One type of asset file and how the editor treats it (ADR 0133 "asset kind"). Core kinds (scenes,
 * prefabs, images, audio, scripts, text…) register through this too, from `assetKinds.builtin.ts`
 * (ADR 0143); `assetKindLookup.ts` answers every per-kind question from the registered kinds.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- kinds' values differ; a registry holds every T
export interface AssetKindContribution<T = any> {
  /** The kind's id, e.g. "sky". Also what `assetKind(path)` returns. */
  readonly id: string;
  /** File-name endings, lower case with the dot, e.g. [".sky.json"]. The longest match over all kinds wins; of equal ones, the kind registered last (so a plugin can take over a core extension). */
  readonly extensions: readonly string[];
  /** Shown in the Assets panel ("Sky"). */
  readonly label: string;
  /** An SVG path (`d`) drawn in a 24×24 box, stroked, like the built-in asset icons. */
  readonly icon: string;
  /** Double-click / Open, done by the kind itself. Absent: `panel` opens it, or `codeEditor`, else the file only selects. */
  open?(path: string): void;
  /**
   * The panel that edits files of this kind (ADR 0233). Opening a file (double-click, `editor.assets.open`) makes it
   * the panel's file, which the panel reads with `editor.assets.openIn(panel)`, and brings the panel forward.
   * Ignored when `open` is set.
   */
  readonly panel?: string;
  /**
   * The kind's document format (ADR 0134, 0233): what its asset documents (`openAssetDocument`), the current value
   * (`editor.assets.read`) and a new file (`editor.assets.create`) are made from.
   */
  readonly format?: AssetFormat<T>;
  /**
   * The project folder new files of this kind go in when no folder is asked for (ADR 0233), e.g. "materials": used
   * when the project has it, else the project root. The New… menu asks for none at the project root.
   */
  readonly folder?: string;
  /** The Inspector's view of a selected file of this kind, loaded on first use. */
  readonly inspector?: LoadComponent<{ path: string }>;
  /**
   * An entry in the Assets panel's New… menu, the only source of its file entries (ADR 0149): core kinds
   * (scenes, render textures) declare theirs here as plugins do. With a `format`, the host writes the file
   * (ADR 0233); otherwise the kind's own `create` does.
   */
  readonly create?: AssetKindCreate<T>;
  /**
   * Capability (ADR 0149): files of this kind are images that can be cut into slices (ADR 0040). A
   * `#slice` entry of one is a `sprite` that adds and opens as its file does, the Assets panel shows the
   * file itself as its thumbnail and lists its slices under it, and Open is "Sprite Editor…".
   */
  readonly slices?: boolean;
  /**
   * Capability (ADR 0371): files of this kind hold sub-assets (`model.glb#Skeleton`, `model.glb#Anim/Run`) that asset
   * fields take on their own. `list` names the ones a file holds right now that may suit a field of `kinds`
   * (synchronously; empty until known, so a kind may start loading the file and list them on a later render), and
   * `referencedAs` the field kinds a sub-asset of that name satisfies. Asset fields offer `path#sub` entries for them.
   */
  readonly subAssets?: { list(path: string, kinds: readonly string[]): readonly string[]; referencedAs(sub: string): readonly string[] };
  /** Policy: the field asset kinds (0131 `@field(AssetRef, { kind })`) that accept files of this kind, e.g. sky → ["environment"] (ADR 0143: any name, so a plugin's Components can reference its own kind). */
  readonly referencedAs?: readonly string[];
  /** Which built-in thumbnail renderer draws its preview (internal tier: renderers stay first-party, ADR 0133). */
  readonly preview?: "sky" | "material" | "shadergraph" | "particles" | "environment" | "model" | "prefab" | "scene" | "audio";
  /** Policy (ADR 0140): files of this kind open in the Code panel (Svelte components, stylesheets). Ignored when `open` is set. */
  readonly codeEditor?: boolean;
  /** Policy (ADR 0133, 0140): what adding a file of this kind to a scene makes (a drop on the Hierarchy or the scene view, the Assets panel's +). */
  readonly addToScene?: AssetSceneNodes;
  /**
   * The import settings (ADR 0040) the Inspector edits for a selected file of this kind, stored in its
   * sidecar `<file>.meta.json` (ADR 0143): images and audio from the shell, models from the Meshes plugin.
   * Ignored when `inspector` is set.
   */
  readonly importSettings?: ImportSettingsContribution;
  /**
   * The project files a file of this kind names in its own format (ADR 0148), such as a model's
   * material libraries, textures and buffers, and how to rewrite them when files move (ADR 0314).
   * Absent: a JSON file's dependencies are its reference strings; other files depend on nothing.
   */
  readonly references?: AssetReferences;
}

/**
 * How an asset kind reads, and rewrites, the files its own format names (ADR 0148, 0314). A move asks `rewrite`
 * of the kind's files that aren't JSON; a JSON file's references are rewritten by its owner (ADR 0302), whatever
 * its kind.
 */
export interface AssetReferences {
  /** The endings (lower case, with the dot) whose files are text `read` understands; absent: all of the kind's. Binary files (`.glb`, `.fbx`) are left out so they are never read as text. */
  readonly extensions?: readonly string[];
  /** Project paths `text` (the file at `path`) names, resolved against the file's folder. Paths that aren't project files are ignored. */
  read(path: string, text: string): readonly string[];
  /**
   * `text` (the file now at `path`) with the references `read` finds pointing where they point after `moves`:
   * at a moved file's new path, and, when the file itself moved, a relative reference still at its target from
   * the new folder. Returns null when nothing changes. Absent: the kind's files that name a moved file are
   * reported as not rewritten.
   */
  rewrite?(path: string, text: string, moves: ReferenceMoves): string | null;
}

/** A set of moves as one file's `AssetReferences.rewrite` sees them (ADR 0314). */
export interface ReferenceMoves {
  /** Where the file was before the moves: its own path, unless it moved. */
  readonly from: string;
  /** Where a project path is after the moves (itself if it didn't move; a moved folder moves what is in it). */
  to(path: string): string;
}

/** What an import settings view is given: the shell owns the sidecar, the draft, Apply and Revert (ADR 0143). */
export interface ImportSettingsViewProps {
  readonly path: string;
  readonly project: EditorProject;
  /** The settings being edited (unsaved until Apply). */
  readonly draft: ImportSettings;
  /** Merge a change into the draft. */
  set(patch: Partial<ImportSettings>): void;
  /** Replace the draft. */
  replace(next: ImportSettings): void;
  /** True when the draft differs from the saved sidecar. */
  readonly dirty: boolean;
  /** Why the project can't be written, or null. */
  readonly readOnly: string | null;
}

/** A kind's import settings in the Inspector, loaded on first use (ADR 0143). */
export interface ImportSettingsContribution {
  /** A look at the file above its settings (the image, the model's render, the clip's player). */
  readonly preview?: LoadComponent<{ path: string }>;
  /** The rows of the Import Settings card. */
  readonly view: LoadComponent<ImportSettingsViewProps>;
}

/**
 * A node a contribution describes for the node insertion to add (ADR 0246): a node entry with no id, its parent
 * named by its index among the templates before it. The insertion mints every id (the root's from its name, or the
 * asset's file name; a descendant's from the root's id and its own name), names a root with no name and no `prefab`
 * after the asset, makes root names unique among their siblings and places them.
 */
export interface NodeTemplate extends Omit<NodeEntry, "id" | "parent"> {
  /** The index of its parent among the templates before it; absent for the root (the first). */
  parent?: number;
}

/** What a file of an asset kind becomes in a scene (ADR 0140, 0246): node templates, the first one the root. */
export interface AssetSceneNodes {
  /** Load what `nodes` needs to know first (a model's meshes). Never rejects. */
  prepare?(path: string): Promise<void>;
  /** The templates to add, at `position` in the parent's space; the first is the root (selected), the rest its descendants. */
  nodes(path: string, position?: readonly [number, number, number]): NodeTemplate[];
  /**
   * Instances keep their own position (ADR 0143: prefabs and scenes): `nodes` gets a position only
   * when the add places them (a drop on the scene view), not from the Assets panel's +.
   */
  readonly keepsOwnPosition?: boolean;
  /**
   * Why `path` can't be added to `doc` though the kind adds to scenes, or null (ADR 0149): a scene or
   * prefab that would end up inside itself. Checked before every add and while dragging.
   */
  whyNot?(doc: SceneDocument, path: string): string | null;
  /**
   * Something to tell the user about what an add made, or null (ADR 0149): a model's cameras arriving
   * turned off (ADR 0118). Logged as an info message after the add, as "<path>: <note>".
   */
  note?(path: string, entries: readonly NodeEntry[]): string | null;
}

/** A problem found reading an asset file. */
export interface AssetProblem {
  readonly message: string;
}

/**
 * How an asset kind's file becomes a value and back (ADR 0134, 0233): what an asset document is made from. Declared
 * as the kind's `format`.
 */
export interface AssetFormat<T> {
  /**
   * The file's parsed JSON (or undefined when missing) to a value, reporting bad values as problems. It may throw for
   * a file it can't read at all: the host then reads `empty()`, with the error's message as the one problem.
   */
  parse(raw: unknown, path: string): { value: T; problems: readonly AssetProblem[] };
  /** A value to the file's text. */
  format(value: T): string;
  /** The value of a file that can't be read, and of a new file unless `create.value` says otherwise. */
  empty(): T;
  /** Milliseconds to wait after the last coalesced edit before writing (sliders). Default 150. */
  readonly writeDelay?: number;
}

/**
 * A kind's New… entry (ADR 0149, 0233). Either the host writes it from the kind's `format` (`<name><extension>` in
 * the folder asked for, else the kind's `folder`), or the kind writes it itself with `create`, given that folder.
 */
export type AssetKindCreate<T> = AssetKindCreatePlacement &
  (
    | {
        readonly label: string;
        /** The new file's name without the extension (default: `label`), e.g. "New Formation". */
        readonly name?: string;
        /** What the files are, plural, for the read-only message: "skies". */
        readonly what: string;
        /** A new file's value (default: the format's `empty()`). */
        value?(): T;
      }
    | {
        readonly label: string;
        /** Write the new file(s) in `folder` (the kind's `folder` already applied); the new file's path, or null. */
        create(folder: string): Promise<string | null>;
      }
    );

/**
 * Where the Assets panel's Create menu puts a kind's New… entry (ADR 0383): the submenu named `category` ("Rendering",
 * "Animation"), sorted there by its label without the leading "New "; without one, the Other submenu.
 */
export interface AssetKindCreatePlacement {
  readonly category?: string;
}

/** A dock of the editor's default layout: one of the side docks, or the one filling the middle (the Scene view's). */
export type PanelDock = "left" | "right" | "bottom" | "fill";

/**
 * A dockable panel. The editor's built-in panels are contributions too (ADR 0182, `panels.builtin.ts`),
 * registered at start-up before any plugin's.
 */
export interface PanelContribution {
  readonly id: string;
  readonly title: string;
  readonly view: LoadComponent<object>;
  /** The panel whose group it joins when first shown. */
  readonly beside?: string;
  /** Kept out of the default layout and the idle preload; opened by something else (double-clicking an asset). */
  readonly onDemand?: boolean;
  /** Only one copy can be open (ADR 0174): the Add Panel dialog offers it only when none is, and a layout holding two keeps the first. */
  readonly single?: boolean;
  /** False when the user can't close it (default true). Such a panel is always in the layout: one missing from a saved layout is added back. */
  readonly closable?: boolean;
  /** False when it can't go into a detached window (default true); a saved layout with it in one drops it there. */
  readonly detachable?: boolean;
  /**
   * The default layout's dock it starts in, after the panels registered before it that name the same
   * dock (ADR 0182). Without one it starts as the tab after its `beside` neighbour.
   */
  readonly dock?: PanelDock;
}

/** What a Project settings section is given. */
export interface ProjectSettingsSectionProps {
  /** The settings being edited. */
  draft: SettingsDraft;
  /** Messages of the problems found at this section's `id` (its field head, e.g. "navigation"). */
  problems: readonly string[];
  /** The same problems with the settings field each is about (`"physics.layers.2"`), to highlight the right control. */
  fieldProblems: readonly { field: string; message: string }[];
  /** Re-render the panel (puts a text field back to the saved value after a cancelled edit). */
  refresh(): void;
  /** Replace the draft: `label` is the undo step's name. */
  set(label: string, next: SettingsDraft): void;
  project: EditorProject;
}

/**
 * A category of the Project settings panel a plugin adds (ADR 0133; built-in categories keep their own code):
 * the `project.json` keys it owns (ADR 0151), their view, and what keeps them from being saved.
 */
export interface ProjectSettingsSectionContribution {
  /** Also the settings field head its problems are found under (`project.json`'s `navigation`). */
  readonly id: string;
  /**
   * The top-level `project.json` keys it owns (`["navigation"]`; `[]` for a section that only edits core
   * keys). While it is registered they are in the panel's draft (`props.draft[key]`), saved, undone and
   * reconciled with outside edits like the core keys; unregistered, the file keeps them untouched.
   */
  readonly keys: readonly string[];
  /**
   * What's wrong with its keys in `draft`, by field (`"navigation.agentTypes.0"`, starting with `id` so
   * the category shows them). Any problem keeps the whole draft from being saved until fixed or undone.
   */
  problems?(draft: SettingsDraft): readonly { field: string; message: string }[];
  /** The category's name in the list and its heading. */
  readonly title: string;
  readonly view: LoadComponent<ProjectSettingsSectionProps>;
  /** The category it follows in the list (a title); absent, or not found: after the last one. */
  readonly after?: string;
  /**
   * The lists of names it keeps in the draft that other files name (ADR 0262): renaming an entry renames what names it,
   * asking first, and undoing the rename moves them back.
   */
  readonly names?: readonly NamedList[];
}

/**
 * A component field that holds a list entry's name (ADR 0262). `field` is a path in the component's data, `*` stepping
 * into every item of a list (`"layer"`, `"layers.*.sortingLayer"`); prefab overrides of the field count too.
 */
export interface NameField {
  /** The component type, or several; absent: any component. */
  readonly component?: string | readonly string[];
  readonly field: string;
}

/** Files of an asset format that name list entries (ADR 0262). */
export interface NameAssetField {
  /** File endings, lower case (`".audioevent.json"`). */
  readonly extensions: readonly string[];
  /** The file's JSON with the name `from` renamed `to`: the same value when nothing names it. Pure. */
  rename(json: unknown, from: string, to: string): unknown;
}

/** Where a named list's entries are named (ADR 0262). */
export interface NameReferences {
  readonly fields?: readonly NameField[];
  readonly assets?: readonly NameAssetField[];
  /** The draft with `from` renamed `to` where another part of the settings names it (the same draft when none does). Pure. */
  settings?(draft: SettingsDraft, from: string, to: string): SettingsDraft;
}

/** A list of names a settings section keeps in the draft, and what names its entries (ADR 0262). */
export interface NamedList extends NameReferences {
  /** `"physics.layers"`, `"audio.buses"`: what `registerNameReferences` names. */
  readonly id: string;
  /** What an entry is called in messages: `"physics layer"`, `"bus"`. */
  readonly noun: string;
  /** The names in `draft`, in order (with the defaults when unset). */
  names(draft: SettingsDraft): readonly string[];
}

/** References to another section's named list, from a plugin that owns them (ADR 0262): Tilemap layers name sorting layers. */
export interface NameReferencesContribution extends NameReferences {
  readonly id: string;
  /** The named list's `id`; while no section declares it, these are ignored. */
  readonly list: string;
}

/** Extra UI a plugin adds under a built-in panel's own content (the Worlds panel's navigation counters). */
export interface PanelExtensionContribution {
  readonly id: string;
  /** The panel it renders in, e.g. "worlds". */
  readonly panel: string;
  readonly view: LoadComponent<object>;
}

/**
 * A short note a plugin adds after a Component's name in the Add Component menu (ADR 0137: Physics
 * Components say "(no physics backend)" while none is enabled for their dimension), or null for none.
 */
export interface ComponentNoteContribution {
  readonly id: string;
  note(type: string): string | null;
}

/** A pointer on the scene view, in canvas pixels (ADR 0138). */
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

/**
 * Why a drag stopped without its release (ADR 0231): Escape, the pointer was cancelled, the window lost focus,
 * another tool or a transform tool took the scene view, play started, or the tool was removed.
 */
export type ViewportCancel = "escape" | "pointer" | "blur" | "tool" | "play" | "removed";

/** A press a tool claimed: it alone gets that pointer's moves and release. */
export interface ViewportDrag {
  move?(p: ViewportPointer): void;
  end?(p: ViewportPointer): void;
  /** The drag stopped without a release (see `ViewportCancel`). Undo any preview. */
  cancel?(reason: ViewportCancel): void;
}

/**
 * What a viewport tool installs through, once per scene view (ADR 0138). Everything registered here
 * is removed when the install is disposed. Internal tier (ADR 0133): it exposes the Engine.
 */
export interface ViewportToolContext<M = unknown> {
  readonly engine: Engine;
  readonly world: World;
  /** Whether this tool is the active tool. */
  readonly active: ReadonlySignal<boolean>;
  /**
   * The tool's mode while it is active (ADR 0231): what `enter` gave it (the collider being edited, the brush),
   * else null. The host owns it and ends it on its own: when a transform tool or another tool takes the scene
   * view, on Escape, when play starts, when another scene opens and, where the contribution's `endsOnSelection`
   * says so or it has `editsComponents`, when the selection changes. `editor.viewport` reads and sets the same mode from outside the install.
   */
  readonly mode: ReadonlySignal<M | null>;
  /** Become the active tool, in `mode` (none: null). The transform gizmo and other tools step aside. Ignored while playing. */
  enter(mode?: M): void;
  /** Give the scene view back to the transform tools, if this tool is active (its mode ends). */
  leave(): void;
  /**
   * Presses on the scene view while editing: the active tool is asked first, then the others in
   * registration order, then selection and the transform gizmo. Return a drag to claim the press.
   */
  onPress(handler: (p: ViewportPointer) => ViewportDrag | null | undefined | void): void;
  /** The pointer over the scene view while no drag runs; null when it leaves. */
  onHover(handler: (p: ViewportPointer | null) => void): void;
  /**
   * Keys while editing, outside text fields and dialogs, without Ctrl/Cmd/Alt: the active tool first.
   * Return true to consume the key. Q, W, E, R and F belong to the editor; don't take them. Escape during
   * a drag cancels the drag and isn't passed on.
   */
  onKey(handler: (e: KeyboardEvent) => boolean): void;
  /** An editor overlay on the Editor World, id `${tool id}` or `${tool id}:${suffix}`. */
  overlay(provider: () => EditorOverlay, options?: { kind?: EditorOverlayKind; suffix?: string }): void;
  /** The scene view's CSS cursor while this tool is active (null: the default). */
  setCursor(cursor: string | null): void;
  /** One undo step on the open scene's command stack: every command `fn` executes, closed even when it throws. False with no open scene. */
  edit(label: string, fn: (scene: OpenScene) => void): boolean;
  /**
   * A drag that is one undo step named `label` on the open scene (ADR 0231); return it from `onPress`. The step
   * opens now; every command executed on the scene's stack from now on (by the press, then the handlers) joins
   * it, and it closes after `end` runs on release. Cancelled, `cancel` runs first; then Escape reverts the step
   * and every other reason keeps it. Null, opening nothing, with no open scene.
   */
  gesture(label: string, drag: ViewportDrag): ViewportDrag | null;
  /** `value` snapped to the scene view's move step while snapping is on (Ctrl/Cmd held, or "always snap"), as the transform gizmo snaps; else `value`. */
  snap(value: number): number;
  /**
   * Outlines that select their node (ADR 0142): a plain click inside one picks the node before renderers
   * (smallest outline first), and they count as part of the node for the selection box and the Alt+click list.
   * Read on every click; e.g. the Physics plugin's 2D collider outlines.
   */
  selectable(outlines: () => Iterable<SelectableOutline>): void;
}

/** A node's outline in world space that viewport picking treats as part of the node (ADR 0142). Picked in its own XY plane. */
export interface SelectableOutline {
  readonly node: GameObject;
  readonly points: readonly (readonly [number, number, number])[];
}

/**
 * The mode of a viewport tool that edits one component at a time (ADR 0266): which component on which node.
 * The host enters it from the component's Inspector card.
 */
export interface ComponentEditMode {
  /** Path key of the node (see `pathKey`). */
  readonly key: string;
  /** The Component type, e.g. "engine.BoxCollider2D". */
  readonly type: string;
  /** Which component of that type on the node. */
  readonly index: number;
}

/**
 * The components a viewport tool edits one at a time with handles (ADR 0266). The host adds a toggle to the header
 * of each such Inspector card (a component header action, ADR 0142): it enters the tool with that card's
 * `ComponentEditMode` or leaves it, shows whether this card is the one being edited, hides while several nodes are
 * selected, and ends the mode when the card's component is removed or the selection changes.
 */
export interface ComponentEditing {
  readonly types: ReadonlySet<string> | readonly string[];
  /** The toggle's text ("Edit Collider"). */
  readonly label: string;
  /** Its tooltip while off: one for every type, or one per type. */
  readonly hint: string | ((type: string) => string);
  /** Its tooltip while this card is being edited. */
  readonly stopHint: string;
}

/** A scene-view tool (ADR 0138): painting, handles, overlays. `M` is its mode (ADR 0231). */
export interface ViewportToolContribution<M = unknown> {
  /** e.g. "myco.tilemaps.paint". Also its overlay id and its active-tool id. */
  readonly id: string;
  /**
   * Whether a change of the selected (active) node ends the tool's mode while it is active, given the mode
   * (ADR 0231). Absent: it never does, unless the tool has `editsComponents`.
   */
  endsOnSelection?(mode: M): boolean;
  /**
   * The components it edits one at a time (ADR 0266); its mode is then a `ComponentEditMode`. Registered through
   * `EditorPluginContext.registerViewportTool`, it brings the Inspector cards' Edit toggle with it.
   */
  readonly editsComponents?: ComponentEditing;
  /** Called for each scene view, and at once when registered while one is open. May return extra cleanup. */
  install(view: ViewportToolContext<M>): void | (() => void);
}

/**
 * A button in the Scene toolbar that opens a popover (ADR 0142), shown after Align and before Preview in
 * registration order: the Navigation plugin's Nav overlay toggles.
 */
export interface SceneToolbarItemContribution {
  readonly id: string;
  /** The button's and the popover's accessible name ("Navigation overlay"). */
  readonly label: string;
  /** The button's text ("Nav"). */
  readonly buttonText: string;
  /** The button's class, for styling and tests ("nav-overlay"). */
  readonly buttonClass: string;
  /** The button's tooltip. */
  readonly title: string;
  /** The popover's content, loaded when it first opens. */
  readonly view: LoadComponent<object>;
}

/**
 * Controls on the Play toolbar, after Pause and Step, in registration order (ADR 0348; the Audio plugin's record toggles
 * were removed by ADR 0416). The view loads with the toolbar and decides itself when it is enabled (while playing).
 */
export interface PlayToolbarItemContribution {
  readonly id: string;
  readonly view: LoadComponent<object>;
}

/** What a component header action is given: the card's component on one or more selected nodes. */
export interface ComponentHeaderActionProps {
  readonly scene: OpenScene;
  /** The nodes the card edits (the active node last). */
  readonly paths: readonly NodePath[];
  /** The card's component (the active node's copy). */
  readonly info: ComponentInfo;
}

/**
 * A control in an Inspector component card's header, before the Worlds menu and Remove (ADR 0142), such as the
 * Edit toggle the host adds for a viewport tool's `editsComponents` (ADR 0266). `types` limits it to those Component types.
 */
export interface ComponentHeaderActionContribution {
  readonly id: string;
  readonly types: ReadonlySet<string> | readonly string[];
  /** Rendered in the header; return null to show nothing (e.g. several nodes selected). */
  readonly view: FunctionComponent<ComponentHeaderActionProps>;
  /** Called before the card's component is removed through its Remove button. */
  onRemove?(props: ComponentHeaderActionProps): void;
}

/**
 * An entry of the Hierarchy's Create menu (and the menu bar's Create menu) a plugin adds (ADR 0146): the
 * Particles plugin's Particle System, the Tilemaps plugin's Tilemap. Listed among the built-in kinds after
 * `after`; the menu item reads `Create ${label}` (`… Child` under a node).
 */
export interface HierarchyCreateContribution {
  /** The node kind's id, e.g. "particle-system": also what the node insertion's `{ kind: "new", node }` source takes (ADR 0246). */
  readonly id: string;
  /** The menu label ("Particle System"). */
  readonly label: string;
  /** The new node's base name ("Particle System", then "Particle System (1)"…). */
  readonly name: string;
  /** The id of the entry (built-in or contributed) it follows; absent, or not found: last. */
  readonly after?: string;
  /**
   * The Create menus' submenu it goes in (ADR 0383): "2D", "3D Object", "Effects", "Light", "UI", or a new one.
   * Absent: the category of the entry `after` names, else Other.
   */
  readonly category?: string;
  /**
   * Write the asset the new node uses first (a new particle effect); resolves to its path, or null when
   * it couldn't (the node is then made without one, with the status the function set kept). Not called
   * when the creator passes an asset.
   */
  createAsset?(): Promise<string | null>;
  /** The node's components at `position` (in the parent's space), `asset` an `asset:<path>` reference or "". Transform included. */
  components(position: [number, number, number], asset: string): ComponentEntry[];
}

/** What an asset action is offered for: a file, or a slice of an image (`slice` its name). */
export interface AssetActionTarget {
  readonly path: string;
  readonly slice?: string;
}

/**
 * An entry of the Assets panel's context menu for selected files or slices (ADR 0146), after Open (or
 * Sprite Editor…): the Tilemaps plugin's Create Tileset from Slices.
 */
export interface AssetActionContribution {
  readonly id: string;
  readonly label: string;
  /** Whether it's offered for the selection (one target per selected file or slice). */
  appliesTo(project: EditorProject, targets: readonly AssetActionTarget[]): boolean;
  /** It writes files: unavailable in a read-only project. */
  readonly writes?: boolean;
  /** Do it; resolves to the files it made, which are selected. */
  run(project: EditorProject, targets: readonly AssetActionTarget[]): Promise<readonly string[]>;
}

/** A count the Play Stats panel shows on a World's Nodes row (ADR 0146): the Navigation plugin's "nav agents". */
export interface PlayStatsCounterContribution {
  readonly id: string;
  /** Shown before the number ("nav agents"). */
  readonly label: string;
  /** The World's count, or null when it has none to show (a World without navigation). Internal tier: it is given the World. */
  count(world: World): number | null;
}

/** One row of a plugin's Play Stats table: a label, a value (already formatted) and an optional muted detail after it. */
export interface PlayStatsRow {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
}

/**
 * A titled table a plugin adds under a World's rows in the Play Stats panel (T34): the Animation plugin's per-frame
 * stage times and instance counts, where a one-number counter is too little. Read at the panel's refresh rate (about
 * 4 Hz) only while the panel shows, so reading may reset the plugin's own averaging period.
 */
export interface PlayStatsTableContribution {
  readonly id: string;
  /** The table's heading ("Animation"). */
  readonly title: string;
  /** The World's rows, or null when it has none to show (no animation in the World, or no frame since the last read). Internal tier: it is given the World. */
  rows(world: World): readonly PlayStatsRow[] | null;
}

/**
 * Work done on a scene when the editor opens it, after its nodes are in the scene view (ADR 0146): the
 * Particles plugin moves embedded effects into assets. Run in registration order, one at a time.
 */
export interface SceneOpenMigrationContribution {
  readonly id: string;
  /** Completes `Couldn't … <scene path>` when it fails ("move the embedded particle effects out of"). */
  readonly failure: string;
  migrate(scene: OpenScene): Promise<unknown>;
}

/**
 * Code fetched once the editor is idle and the engine's own chunks are in (ADR 0082, 0146), so a project that
 * needs it doesn't wait: the Physics plugin's core and its backends. Never rejects (a real load reports it).
 */
export interface IdlePrefetchContribution {
  readonly id: string;
  load(): Promise<unknown>;
}

/**
 * Choices for a Component field that depend on more than its declaration (ADR 0152): the Meshes plugin
 * offers `engine.MeshRenderer`'s `variant` as a dropdown of the referenced model's material variants. The
 * Inspector shows the field as a dropdown of `none` (when there are choices) then the choices. With no
 * choices it hides the row while the field is unset on every selected node, and otherwise offers `none`
 * alone, so a stale value can be cleared. A field's static `choices` option (ADR 0042) needs none of this.
 */
export interface FieldChoicesContribution {
  readonly id: string;
  /** The Component type, e.g. "engine.MeshRenderer". */
  readonly type: string;
  /** The field's name, e.g. "variant". */
  readonly field: string;
  /** The choice that clears the field, listed first (e.g. `{ label: "Default", value: "" }`). */
  readonly none?: FieldChoice;
  /**
   * What the choices depend on, from the active node's copy of the component (the MeshRenderer's mesh
   * reference): they're asked for again when it changes.
   */
  key(info: ComponentInfo): string;
  /** The choices for the component as `key` describes it; empty when there's nothing to choose. A rejection counts as none. */
  choices(info: ComponentInfo): readonly FieldChoice[] | Promise<readonly FieldChoice[]>;
}

/**
 * A Component's wireframe in the scene view (ADR 0295), offered by the plugin that knows its shape so another plugin's
 * tool can draw it without importing that plugin: the Physics plugin offers its 3D colliders' wireframes from its
 * collider shape table, and the Audio plugin's occluder tool outlines the colliders an occluder applies to with them.
 */
export interface ComponentWireframeContribution {
  readonly id: string;
  /** The Component type ids it draws, e.g. "engine.BoxCollider". */
  readonly types: ReadonlySet<string>;
  /** The component's wireframe in world space, or null while it can't be drawn (a mesh collider whose model is loading). */
  wire(component: Component): Wire | null;
}

/** A bone of a skeleton as the Hierarchy lists it (ADR 0373): its name and the bones under it. */
export interface SkeletonBoneRow {
  readonly name: string;
  readonly children: readonly SkeletonBoneRow[];
}

/** What the Inspector's bone view is given (ADR 0242's bone target, 0373): the node with the Skeleton and the bone's name. */
export interface BoneInspectorProps {
  readonly scene: OpenScene;
  readonly path: NodePath;
  readonly bone: string;
}

/**
 * The bones a plugin lists in the Hierarchy under scene nodes (ADR 0373: the Animation plugin's Skeletons): read-only
 * virtual rows, built from the skeleton asset and never saved in the scene, each collapsed until opened and all hidden
 * while searching. Selecting one makes the Inspector target that bone (ADR 0242), which `inspector` shows.
 */
export interface SkeletonBonesContribution {
  readonly id: string;
  /** The root bones under the node at `path` (empty: none). Read while the Hierarchy renders, so it may read signals (a skeleton loading). */
  bones(scene: OpenScene, path: NodePath): readonly SkeletonBoneRow[];
  /** The Inspector's view of a selected bone. */
  readonly inspector: LoadComponent<BoneInspectorProps>;
}

/**
 * What dropping Assets panel files on a scene node's Hierarchy row does instead of adding them under it (ADR 0373: a
 * clip dropped on an Animator). Asked only for the middle of a row ("into"); the first contribution that gives a label
 * takes the drop, and the label is the drag's text.
 */
export interface NodeAssetDropContribution {
  readonly id: string;
  /** What releasing `assets` on the node at `path` does ("Set Run as Hero's default clip"), or null when this contribution doesn't take them there. */
  label(scene: OpenScene, path: NodePath, assets: readonly string[]): string | null;
  /** Releasing them there, after `label` gave a text. */
  drop(scene: OpenScene, path: NodePath, assets: readonly string[]): void;
}

/**
 * A change another plugin makes to what adding a file of an asset kind to a scene makes (ADR 0140's `addToScene`, ADR
 * 0373): the Animation plugin gives a dropped model whose meshes are skinned a Skeleton, SkinnedMeshRenderers and an
 * Animator, though the model kind is the Meshes plugin's. Augments run in registration order on the kind's own templates,
 * inside the add's one undo step; `prepare` runs beside the kind's own.
 */
export interface AssetNodesAugmentContribution {
  readonly id: string;
  /** The asset kind whose added nodes it changes, e.g. "model". */
  readonly kind: string;
  /** Load what `augment` reads, while the add prepares (with the kind's own `prepare`). Never rejects. */
  prepare?(path: string): Promise<void>;
  /** The templates to add for `path` (`templates[0]` the root): a new list, or `templates` itself to change nothing. */
  augment(path: string, templates: NodeTemplate[]): NodeTemplate[];
}

/**
 * A card another plugin adds to the Inspector's import settings of an asset kind (ADR 0143, 0373): the Animation plugin's
 * bone map and clip import settings are cards of a model's Import Settings, though the `model` kind is the Meshes plugin's.
 * It edits the same draft as the kind's own rows, so the shell's one Apply and Revert write them together. Cards show
 * after the kind's own, in registration order.
 */
export interface ImportSettingsSectionContribution {
  readonly id: string;
  /** The asset kind whose Import Settings it joins, e.g. "model". */
  readonly kind: string;
  /** The card's heading. */
  readonly title: string;
  /** The card's rows, loaded on first use. */
  readonly view: LoadComponent<ImportSettingsViewProps>;
}

/**
 * What a Sprite Editor tool changes (ADR 0373 "2D tools"): slice skins by slice name (null drops a skin) and, as a whole,
 * the image's flipbooks. Slices themselves (names, rectangles, pivots) are the Sprite Editor's own.
 */
export interface SpriteEditorChange {
  readonly skins?: Readonly<Record<string, SliceSkin | null>>;
  readonly flipbooks?: Readonly<Record<string, SpriteFlipbook>>;
  /** Slice outlines by slice name (ADR 0414): closed polygons in slice pixels, y up; null removes one. */
  readonly outlines?: Readonly<Record<string, readonly (readonly [number, number])[][] | null>>;
  /** The image's secondary textures by name (ADR 0414), replaced as a whole. */
  readonly secondaryTextures?: Readonly<Record<string, string>>;
  /** The image's normal map green channel (ADR 0414). */
  readonly normalMapGreen?: "up" | "down";
}

/** What the Sprite Editor gives a tool's view: the image's slices and flipbooks as edited so far, and the one way to change them. */
export interface SpriteEditorToolProps {
  /** The image's project path. */
  readonly image: string;
  /** The image's URL, for drawing it. */
  readonly url: string;
  readonly slices: readonly SpriteSlice[];
  readonly flipbooks: Readonly<Record<string, SpriteFlipbook>>;
  /** The image's secondary textures (ADR 0414) and its normal map's green channel, as edited so far. */
  readonly secondaryTextures: Readonly<Record<string, string>>;
  readonly normalMapGreen: "up" | "down";
  /** The selected slice's name, or null. Shared with the Slices view. */
  readonly selected: string | null;
  select(name: string | null): void;
  /** Make a change as one undo step of the Sprite Editor's history; steps sharing `key` in a row (one drag) are one step. */
  edit(change: SpriteEditorChange, key?: string): void;
  /** Why nothing can be changed (a read-only project), or null. */
  readonly readOnly: string | null;
  /** The image's pixels (meshes follow the opaque outline). */
  pixels(): Promise<Pixels>;
}

/**
 * A tool of the Sprite Editor (ADR 0373): a tab beside Slices whose view replaces the editor's body while it is open. The
 * Animation plugin's Flipbooks and Bones tools. Edits go on the editor's one history and are written by its Apply.
 */
export interface SpriteEditorToolContribution {
  readonly id: string;
  readonly label: string;
  readonly view: LoadComponent<SpriteEditorToolProps>;
}

/** A component field of a scene document, as the field adornments and field write interceptors see it (ADR 0373). */
export interface DocumentField {
  readonly scene: OpenScene;
  /** The node (`[id]`, or `[instanceId, innerId…]` inside a prefab instance). */
  readonly path: NodePath;
  /** The Component type id, e.g. "engine.Transform". */
  readonly type: string;
  /** Which component of its type on the node. */
  readonly index: number;
  /** The field's name (a whole field: a plain object's sub-paths are inside its value). */
  readonly field: string;
}

/** What a field adornment is given: the field of the Inspector's active node, and its value in scene-file JSON. */
export interface FieldAdornmentProps extends DocumentField {
  /** The value the row shows on the active node, as the scene file would hold it (undefined when it can't be). */
  readonly value: unknown;
}

/**
 * A small control after a field's name in the Inspector of a scene document (ADR 0373: the Animation window's key
 * buttons on animatable fields). Rendered on every field row of the active node; the view returns null where it has
 * nothing to show. Not shown in the live Inspector of a running game.
 */
export interface FieldAdornmentContribution {
  readonly id: string;
  readonly view: FunctionComponent<FieldAdornmentProps>;
}

/** A component field write to a scene document, as an interceptor is asked about it. */
export interface InterceptedFieldWrite extends DocumentField {
  /** The value to write, in scene-file JSON. */
  readonly value: unknown;
  /** What the document holds there now (undefined when unset). */
  readonly stored: unknown;
  /**
   * The open undo step the write is part of (a gizmo drag, an Inspector scrub, a multi-node edit), as a number shared
   * by every write inside it; null for a write outside any step. `gestureEnded` hears when it closes.
   */
  readonly gesture: number | null;
}

/**
 * Takes component field writes to scene documents instead of the document (ADR 0373: the Animation window's record
 * mode, where changing an animatable field in the Inspector or with a gizmo writes a key into the clip). Asked before
 * every document write from the Inspector, gizmos and plugin tools (they all go through the one component field write,
 * ADR 0257), after the edit gate; the first that takes a write keeps the scene document unchanged.
 */
export interface FieldWriteInterceptorContribution {
  readonly id: string;
  /** Take `write` (true: the scene document isn't changed) or leave it to the document (false). Must not throw. */
  take(write: InterceptedFieldWrite): boolean;
  /** The undo step numbered `gesture` closed (`cancelled`: put back), after writes inside it were asked about. */
  gestureEnded?(gesture: number, cancelled: boolean): void;
}

export const componentNotes = createRegistry<ComponentNoteContribution>("Component note");
export const fieldAdornments = createRegistry<FieldAdornmentContribution>("Field adornment");
export const fieldWriteInterceptors = createRegistry<FieldWriteInterceptorContribution>("Field write interceptor");
export const assetKinds = createRegistry<AssetKindContribution>("Asset kind");
export const panels = createRegistry<PanelContribution>("Panel");
export const projectSettingsSections = createRegistry<ProjectSettingsSectionContribution>("Project settings section");
export const panelExtensions = createRegistry<PanelExtensionContribution>("Panel extension");
export const viewportTools = createRegistry<ViewportToolContribution>("Viewport tool");
export const sceneToolbarItems = createRegistry<SceneToolbarItemContribution>("Scene toolbar item");
export const playToolbarItems = createRegistry<PlayToolbarItemContribution>("Play toolbar item");
export const componentHeaderActions = createRegistry<ComponentHeaderActionContribution>("Component header action");
export const hierarchyCreateEntries = createRegistry<HierarchyCreateContribution>("Hierarchy create entry");
export const assetActions = createRegistry<AssetActionContribution>("Asset action");
export const playStatsCounters = createRegistry<PlayStatsCounterContribution>("Play stats counter");
export const playStatsTables = createRegistry<PlayStatsTableContribution>("Play stats table");
export const sceneOpenMigrations = createRegistry<SceneOpenMigrationContribution>("Scene open migration");
export const idlePrefetches = createRegistry<IdlePrefetchContribution>("Idle prefetch");
export const fieldChoices = createRegistry<FieldChoicesContribution>("Field choices");
export const nameReferences = createRegistry<NameReferencesContribution>("Name references");
export const componentWireframes = createRegistry<ComponentWireframeContribution>("Component wireframe");
export const skeletonBones = createRegistry<SkeletonBonesContribution>("Skeleton bones");
export const nodeAssetDrops = createRegistry<NodeAssetDropContribution>("Node asset drop");
export const assetNodesAugments = createRegistry<AssetNodesAugmentContribution>("Asset nodes augment");
export const importSettingsSections = createRegistry<ImportSettingsSectionContribution>("Import settings section");
export const spriteEditorTools = createRegistry<SpriteEditorToolContribution>("Sprite Editor tool");

/** The wireframe a registered contribution draws for `component` (by its Component type id), or null when none draws it or it can't be drawn now. */
export function componentWireframe(component: Component): Wire | null {
  const type = getComponentId(component.constructor as ComponentClass);
  for (const w of componentWireframes.list()) if (type && w.types.has(type)) return w.wire(component);
  return null;
}
