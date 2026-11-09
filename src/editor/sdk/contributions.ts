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
import type { ComponentInfo, ThumbnailStage } from "../../engine/editor";
import type { ImportSettings } from "../../engine/scene/importSettings";
import type { FieldChoice } from "../../engine/core/registry";

/** A component loaded on first use (ADR 0083). */
export type LoadComponent<P extends object> = () => Promise<FunctionComponent<P>>;

/**
 * One type of asset file and how the editor treats it (ADR 0133 "asset kind"). Core kinds (scenes,
 * prefabs, images, audio, scripts, text…) register through this too, from `assetKinds.builtin.ts`
 * (ADR 0143); `assetKindLookup.ts` answers every per-kind question from the registered kinds.
 */
export interface AssetKindContribution {
  /** The kind's id, e.g. "sky". Also what `assetKind(path)` returns. */
  readonly id: string;
  /** File-name endings, lower case with the dot, e.g. [".sky.json"]. The longest match over all kinds wins; of equal ones, the kind registered last (so a plugin can take over a core extension). */
  readonly extensions: readonly string[];
  /** Shown in the Assets panel ("Sky"). */
  readonly label: string;
  /** An SVG path (`d`) drawn in a 24×24 box, stroked, like the built-in asset icons. */
  readonly icon: string;
  /** Double-click / Open. Absent: the file only selects. */
  open?(path: string): void;
  /** The Inspector's view of a selected file of this kind, loaded on first use. */
  readonly inspector?: LoadComponent<{ path: string }>;
  /**
   * An entry in the Assets panel's New… menu, the only source of its file entries (ADR 0149): core kinds
   * (scenes, render textures) declare theirs here as plugins do. `create` returns the new file's path, or null.
   */
  readonly create?: { readonly label: string; create(folder: string): Promise<string | null> };
  /**
   * Capability (ADR 0149): files of this kind are images that can be cut into slices (ADR 0040). A
   * `#slice` entry of one is a `sprite` that adds and opens as its file does, the Assets panel shows the
   * file itself as its thumbnail and lists its slices under it, and Open is "Sprite Editor…".
   */
  readonly slices?: boolean;
  /** Policy: the field asset kinds (0131 `@field(AssetRef, { kind })`) that accept files of this kind, e.g. sky → ["environment"] (ADR 0143: any name, so a plugin's Components can reference its own kind). */
  readonly referencedAs?: readonly string[];
  /**
   * Its files' preview: `"audio"` (a waveform), or a rendered thumbnail whose stage the kind supplies (ADR 0156).
   * Internal tier (ADR 0133): a stage names engine internals.
   */
  readonly preview?: "audio" | AssetThumbnail;
  /** Policy (ADR 0140): files of this kind open in the Code panel (UI documents, stylesheets). Ignored when `open` is set. */
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
   * material libraries, textures and buffers. Absent: a JSON file's dependencies are its reference
   * strings; other files depend on nothing.
   */
  readonly references?: AssetReferenceExtractor;
}

/** How an asset kind reads the files its own format names (ADR 0148). */
export interface AssetReferenceExtractor {
  /** The endings (lower case, with the dot) whose files are text `read` understands; absent: all of the kind's. Binary files (`.glb`, `.fbx`) are left out so they are never read as text. */
  readonly extensions?: readonly string[];
  /** Project paths `text` (the file at `path`) names, resolved against the file's folder. Paths that aren't project files are ignored. */
  read(path: string, text: string): readonly string[];
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

/**
 * A rendered thumbnail of an asset kind's files (ADR 0156): the made-up node set each file is drawn as,
 * through the enabled plugins' render features, and how it is framed.
 */
export interface AssetThumbnail {
  /** Names the picture in the thumbnail cache's keys ("model", "sky"); unique per look. */
  readonly id: string;
  /**
   * The stage `path` is drawn as. `live`: the Inspector's preview or a hovered tile, which may show more (a
   * sky's chrome sphere) and say whether it `animates`. Throws when the file can't be shown.
   */
  stage(path: string, live: boolean): ThumbnailStage;
}

/** A kind's import settings in the Inspector, loaded on first use (ADR 0143). */
export interface ImportSettingsContribution {
  /** A look at the file above its settings (the image, the model's render, the clip's player). */
  readonly preview?: LoadComponent<{ path: string }>;
  /** The rows of the Import Settings card. */
  readonly view: LoadComponent<ImportSettingsViewProps>;
}

/** What a file of an asset kind becomes in a scene (ADR 0140): node entries, the first one the root. */
export interface AssetSceneNodes {
  /** Load what `nodes` needs to know first (a model's meshes). Never rejects. */
  prepare?(path: string): Promise<void>;
  /** The entries to add, at `position` in the parent's space; the first is the root (selected), the rest its descendants. */
  nodes(doc: SceneDocument, path: string, position?: readonly [number, number, number]): NodeEntry[];
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

/** A press a tool claimed: it alone gets that pointer's moves and release. */
export interface ViewportDrag {
  move?(p: ViewportPointer): void;
  end?(p: ViewportPointer): void;
  /** Play started, Escape is not involved: the tool was removed or the pointer was cancelled. Undo any preview. */
  cancel?(): void;
}

/**
 * What a viewport tool installs through, once per scene view (ADR 0138). Everything registered here
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

/** A scene-view tool (ADR 0138): painting, handles, overlays. */
export interface ViewportToolContribution {
  /** e.g. "myco.tilemaps.paint". Also its overlay id and its active-tool id. */
  readonly id: string;
  /** Called for each scene view, and at once when registered while one is open. May return extra cleanup. */
  install(view: ViewportToolContext): void | (() => void);
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

/** What a component header action is given: the card's component on one or more selected nodes. */
export interface ComponentHeaderActionProps {
  readonly scene: OpenScene;
  /** The nodes the card edits (the active node last). */
  readonly paths: readonly NodePath[];
  /** The card's component (the active node's copy). */
  readonly info: ComponentInfo;
}

/**
 * A control in an Inspector component card's header, before the Worlds menu and Remove (ADR 0142): the
 * Physics plugin's Edit Collider button. `types` limits it to those Component types.
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
  /** The node kind's id, e.g. "particle-system": also what `createNode(scene, id)` takes. */
  readonly id: string;
  /** The menu label ("Particle System"). */
  readonly label: string;
  /** The new node's base name ("Particle System", then "Particle System (1)"…). */
  readonly name: string;
  /** The id of the entry (built-in or contributed) it follows; absent, or not found: last. */
  readonly after?: string;
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

export const componentNotes = createRegistry<ComponentNoteContribution>("Component note");
export const assetKinds = createRegistry<AssetKindContribution>("Asset kind");
export const assetFormats = createRegistry<AssetFormatContribution<any>>("Asset format"); // eslint-disable-line @typescript-eslint/no-explicit-any -- formats differ in T
export const panels = createRegistry<PanelContribution>("Panel");
export const projectSettingsSections = createRegistry<ProjectSettingsSectionContribution>("Project settings section");
export const panelExtensions = createRegistry<PanelExtensionContribution>("Panel extension");
export const viewportTools = createRegistry<ViewportToolContribution>("Viewport tool");
export const sceneToolbarItems = createRegistry<SceneToolbarItemContribution>("Scene toolbar item");
export const componentHeaderActions = createRegistry<ComponentHeaderActionContribution>("Component header action");
export const hierarchyCreateEntries = createRegistry<HierarchyCreateContribution>("Hierarchy create entry");
export const assetActions = createRegistry<AssetActionContribution>("Asset action");
export const playStatsCounters = createRegistry<PlayStatsCounterContribution>("Play stats counter");
export const sceneOpenMigrations = createRegistry<SceneOpenMigrationContribution>("Scene open migration");
export const idlePrefetches = createRegistry<IdlePrefetchContribution>("Idle prefetch");
export const fieldChoices = createRegistry<FieldChoicesContribution>("Field choices");
