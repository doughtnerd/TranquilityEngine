# 0138. Viewport tools are an editor contribution point: installed per scene view, input routed by one host, at most one active tool

- **Status:** Accepted
- **Date:** 2026-11-08
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0133, 0134 (the registry pattern this extends), 0135, 0136 (its painting tools wait on this), 0103 (tile painting), 0026 (editor tools live in the Editor World), 0027 (undo)

## Context

ADR 0136 moved the Tilemaps runtime into `src/plugins/tilemaps/runtime/` but left the painting tools and the Tile Palette panel in `src/editor/`, because a plugin's editor half has no way to add scene-view tools. Today `session.ts` installs twelve scene-view installers by hand when a project opens, each `(engine) => dispose`:

```
installViewportSelection, installGizmo, installColliderGizmo, installJointGizmo, installNavGizmo, installNavPreviews,
installPlayGizmos, installSceneView, installViewportTheme, installUIElementOutline, installUIHandles, installTilemapPainting
```

How they share input today:

- **Who gets a pointer press.** Each installer adds its own listeners to the canvas. Tools that must win (`colliderGizmo.ts`'s handles, `tilemap/paintTool.ts`) listen to `pointerdown` in the capture phase and call `stopImmediatePropagation`, so between themselves the earlier-registered one wins (array order in `session.ts`). The transform gizmo is Babylon's and is detected, not routed: `viewportSelection.ts` ignores presses where `viewport(world).gizmoActiveAt(x, y)`. Each drag adds and removes its own `pointermove`/`pointerup`/`pointercancel` listeners and calls `setPointerCapture`.
- **Exclusive modes vs always-on gizmos.** Three unrelated signals act as modes: `tool` (Q/W/E/R transform tools, `state.ts`), `editingCollider` (collider shape editing; `pickTool` clears it, `gizmo.ts` hides the transform gizmo while it's set) and `brushTool` (tile painting, `tilemap/brush.ts`; an effect in `paintTool.ts` clears it when `tool` changes or the selection stops being a tilemap). While painting, the transform gizmo still shows; painting simply captures the press first. The joint, nav, play and UI-outline drawings are always on and take no presses.
- **Keyboard.** `shortcuts.ts` owns editor keys on `window` (Q/W/E/R, Delete, Ctrl combinations). `paintTool.ts` adds its own `window` `keydown` for B/U/G/I/Shift+E/X/Y/Z/Escape and repeats the "not in a text field, no modifiers, only while a tilemap is selected" checks; `viewportSelection.ts` and `uiHandles.ts` add capture-phase Escape handlers during drags.
- **Undo.** A stroke changes the live `Tilemap` while dragging and commits once on release: `commitTilemap` wraps one `SetField` in `scene.stack.beginGroup(label)` / `endGroup()`. Collider and UI handle drags do the same with their own commands.
- **Play mode.** Each tool checks `playState.value === "edit"` itself (`paintTarget`, `colliderGizmo` `onDown`); none cancels a drag when play starts.
- **Disposal.** The installers are disposed with the session (opening another project). Nothing follows plugin activation: `applyEnabledPlugins` can enable or disable a plugin while a project is open (`{ live: true }`), so a plugin tool installed by hand would outlive its plugin.

The editor SDK (`src/editor/sdk/`) has registries for asset kinds, formats, panels and Inspector sections; every registration returns an undo and `deactivatePlugin` runs them (0134). First-party editor halves already import editor internals (`editor/state`, `assetBrowser`, …: the internal tier of 0133). `src/plugins/plugins.test.ts` forbids the editor core from importing plugin editor halves.

## Decision

We will add a **viewport tool** contribution point. A tool is installed once per scene view (per Editor World) and registers its input, overlays and cursor through a context; one **viewport tool host** in core routes input among the installed tools and the built-in selection and gizmo, and keeps at most one tool **active**.

**1. The contribution** (`src/editor/sdk/contributions.ts`, registry `viewportTools`, `EditorPluginContext.registerViewportTool`):

```ts
export interface ViewportToolContribution {
  /** e.g. "myco.tilemaps.paint". Also the overlay id prefix and the active-tool id. */
  readonly id: string;
  /** Called for each scene view (each opened project), and at once when registered while one is open. May return extra cleanup. */
  install(view: ViewportToolContext): void | (() => void);
}
```

**2. The context** a tool installs through. Everything registered through it is removed when the install is disposed, so a tool usually needs no cleanup of its own beyond its effects.

```ts
export interface ViewportToolContext {
  readonly engine: Engine;            // internal tier (0133): first-party tools only
  readonly world: World;
  /** Whether this tool is the active tool. */
  readonly active: ReadonlySignal<boolean>;
  /** Become the active tool / give it back to the transform tools. */
  activate(): void;
  deactivate(): void;
  /** Left/middle/right presses on the scene view while editing. Return a drag to claim the press. */
  onPress(handler: (p: ViewportPointer) => ViewportDrag | null | undefined): void;
  /** The pointer over the scene view while no drag runs; null when it leaves. */
  onHover(handler: (p: ViewportPointer | null) => void): void;
  /** Keys while editing, outside text fields, without Ctrl/Cmd/Alt. Return true to consume the key. */
  onKey(handler: (e: KeyboardEvent) => boolean): void;
  /** An editor overlay on the Editor World (`addEditorOverlay`), id `${tool.id}` or `${tool.id}:${suffix}`. */
  overlay(provider: () => EditorOverlay, options?: { kind?: EditorOverlayKind; suffix?: string }): void;
  /** The scene view's CSS cursor while this tool is active (null: the default). */
  setCursor(cursor: string | null): void;
  /** One undo step on the open scene's command stack: begins a group, runs `fn`, always ends it. False with no open scene. */
  edit(label: string, fn: (scene: OpenScene) => void): boolean;
}
export interface ViewportPointer { x: number; y: number; button: number; alt: boolean; shift: boolean; ctrl: boolean; meta: boolean; pointerId: number; }
export interface ViewportDrag { move?(p: ViewportPointer): void; end?(p: ViewportPointer): void; cancel?(): void; } // cancel: no release came (pointer cancelled, play started, tool removed); finish or undo the preview
```

**3. The host** (`src/editor/viewportTools.ts`, `installViewportTools(engine)`, one entry in `session.ts`'s installer list replacing `installTilemapPainting`):

- **Follows the registry.** An effect on `viewportTools.version` installs newly registered tools and disposes removed ones, so enabling or disabling a plugin with a project open adds or removes its tools (the 0134 undo contract, carried to the scene view).
- **Press routing.** One capture-phase `pointerdown` listener on the canvas. It offers the press to the active tool first, then to the other tools in registration order; the first handler that returns a drag claims it. The host then stops the event (selection, the transform gizmo and orbiting never see it), sets pointer capture and sends that pointer's moves, release and cancel to the drag only. Unclaimed presses reach the built-in selection and gizmo unchanged. Built-in capture-phase tools (collider handles) keep their own listeners and are installed before the host, as today, so their order doesn't change.
- **One active tool.** `activeViewportTool: ReadonlySignal<string | null>` and `activateViewportTool(id | null)` (exported by the SDK; `ctx.activate` is sugar). `null` means the transform tools. Activating a tool clears `editingCollider`; `pickTool` (toolbar and Q/W/E/R) and editing a collider set it back to `null`; Escape with no drag running deactivates it; disposing the active tool's install deactivates it. `gizmo.ts` hides the transform gizmo while a tool is active, as it does while editing a collider. Always-on gizmos are tools that never call `activate`.
- **Keys.** One `window` capture-phase `keydown` listener. Text fields, Ctrl/Cmd/Alt chords, open dialogs and play mode are skipped once for everyone; then the active tool's handler, then the others. A consumed key gets `preventDefault` and `stopImmediatePropagation`, so it doesn't also reach `shortcuts.ts`. Tools must not take Q, W, E, R or F (documented on `onKey`, and a test checks the Tilemaps tool doesn't).
- **Hover and cursor.** One `pointermove`/`pointerleave` pair feeds `onHover` (not during a drag); the canvas cursor is the active tool's `setCursor` value.
- **Play mode.** Presses, hovers and keys aren't routed unless `playState` is `"edit"`. Entering play cancels a running drag (`cancel()`) and deactivates the active tool.
- **Disposal.** Disposing an install cancels its drag, removes its handlers, overlays and cursor, and runs its returned cleanup. Disposing the host disposes every install.

**4. Undo.** A gesture is one undo step: the tool previews live during the drag and commits through `ctx.edit(label, fn)` on release (or calls `scene.stack` itself, as built-in tools do). Activating, deactivating and hovering are not undoable.

**5. Tilemaps moves into its editor half.** `src/editor/tilemap/` (`paintTool.ts`, `brush.ts`, `palette.ts`), `ui/TilePalettePanel.tsx` with `tilePalette.css`, `ui/TileThumb.tsx` and `ui/TilemapInspector.tsx` move to `src/plugins/tilemaps/editor/`. The editor half registers:

- the `myco.tilemaps.paint` viewport tool: `brushTool` non-null ⇔ the tool is active (picking a brush activates it; any other activation clears the brush); presses paint, hover draws the grid and footprint, B/U/G/I/Shift+E/X/Y/Z pick and flip as today, crosshair cursor while active;
- the Tile Palette panel (id `tilepalette` kept, so saved layouts keep the tab; `beside: "code"`, so the default tabs stay Assets, Code, Tile Palette), removed from `layout/model.ts`'s built-in panels and `ui/panels.tsx`;
- the Tilemap Inspector section (`registerInspectorSection("engine.Tilemap", …)`), removed from `inspectorSections.builtin.ts`.

`tilesetAssets.ts` stays in core: the Assets panel's Create Tileset from Slices menu entry calls it and there is no asset-menu contribution point yet. `tests/e2e/tilemap.spec.ts` must pass unchanged except where it relies on the transform gizmo showing while painting.

**6. Later users.** The collider gizmo (`colliderGizmo.ts`, Physics 2D/3D, an active tool while editing a shape), the joint gizmo and the nav gizmo (always-on overlays) are candidates. They stay as built-in installers in this change: moving them means moving them into their plugins' editor halves, which is its own step per plugin.

## Alternatives considered

- **Registrable installers, no host** (`registerViewportTool({ id, install(engine) => dispose })`, today's functions made registrable). Smallest change, but keeps first-registered-wins capture races, every tool repeats the play-mode, text-field and modifier checks, and nothing makes painting and collider editing exclusive.
- **Declarative tools the editor drives** (Unity's `EditorTool`: `{ id, label, icon, shortcut, available(), onPointerDown/Move/Up, overlay() }`, all listed in the scene toolbar beside Move/Rotate/Scale). Uniform, gives a toolbar and shortcut-conflict checks for free. Not chosen: tile painting is five sub-tools picked from its panel with flip keys and Alt-to-pick, so it would be five tools sharing state through module globals; always-on handles (collider, nav) aren't modes; per-World state has nowhere to live without an install step; and Move/Rotate/Scale would have to be rewritten as such tools. The chosen context can grow a toolbar entry later (open question).
- **Route input through the engine** (`src/engine/editor`'s Babylon pointer observables). The editor-only routing would cross into the engine and Babylon, and the engine must not know about editor tools (0133 import rules).

## Consequences

**Positive**
- A plugin's editor half adds scene-view tools without touching `session.ts`, and they come and go with the plugin while a project is open.
- Press order, exclusivity, play-mode and text-field rules are decided once in the host and unit-tested there (Vitest with a fake canvas), not repeated per tool.
- The Tilemaps editor code lives with its plugin; the core loses `tilemap/`, three UI files and a built-in panel.

**Negative / costs**
- Two ways to add scene-view behaviour until the built-in installers move (they stay hand-installed).
- Behaviour change: the transform gizmo hides while painting.
- `ViewportToolContext` exposes `Engine` and `World`, so the contribution point is internal tier (first-party plugins) until a public scene-view API exists.

## Deprecates

`installTilemapPainting`'s hand installation in `session.ts`; `src/editor/tilemap/`, `ui/TilePalettePanel.tsx`, `ui/tilePalette.css`, `ui/TileThumb.tsx`, `ui/TilemapInspector.tsx` (moved to the plugin); the built-in `tilepalette` panel id in `layout/model.ts` (becomes a registered panel with the same id); the Tilemap entry in `inspectorSections.builtin.ts`.

## Open questions

- Scene-toolbar entries for active tools (a `toolbar?: { label, icon, shortcut }` on the contribution).
- Whether collider editing becomes a viewport tool of the Physics plugins, and whether Move/Rotate/Scale join as built-in tools.
- An asset-menu contribution point, so Create Tileset from Slices and `tilesetAssets.ts` can move too.
- A public (non-internal) scene-view API for third-party tools: plane picking and overlays without `Engine`.

## References

- `src/editor/session.ts` (`loadProject`'s installer list); `src/editor/tilemap/paintTool.ts`; `src/editor/viewportSelection.ts`; `src/editor/colliderGizmo.ts`; `src/editor/gizmo.ts`; `src/editor/shortcuts.ts`; `src/editor/state.ts` (`tool`, `pickTool`, `editingCollider`).
- `src/editor/sdk/`; `src/plugins/plugins.test.ts`; [0134](0134-plugin-loading-asset-kinds-asset-documents-and-panels.md); [0136](0136-tilemaps-plugin-draws-through-a-quad-batch-host.md).
- Unity `EditorTool` / `ToolManager`; Godot `EditorPlugin._forward_canvas_gui_input` (a plugin gets scene-view input first and returns whether it consumed it, close to `onPress`).
