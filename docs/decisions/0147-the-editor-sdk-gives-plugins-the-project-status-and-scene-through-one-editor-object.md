# 0147. The editor SDK gives plugins the project, status bar and scene through one `editor` object

- **Status:** Proposed — built in the same change; amended by 0173 (`editor.project.settings`)
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0025, 0026, 0060, 0083, 0116, 0133, 0134, 0138, 0139, 0140, 0142, 0143, 0144, 0145, 0146

## Context

ADR 0133 makes `myco/editor` (`src/editor/sdk/index.ts`) the editor half's SDK and everything else in `src/editor/` an internal tier for first-party plugins. 0146 made the shell reach plugins only through contribution points; the other direction was not checked. Measured on this branch before the change, over the 84 non-test files under `src/plugins/*/editor/`:

- **57 files imported shell internals**: 157 import statements (CSS left out) into 25 `src/editor/` modules. Only 19 files imported the SDK entry, mostly for `EditorPlugin` types.
- **`state.ts`** (35 files): `currentProject` ×22 and `docVersion` ×22 read as signals, `status` ×16 set directly (`status.value = { kind: "info", … }`, 9 with `errorStatus`), `openScene`, `playState` and the selection functions. Plugins also bumped `docVersion` themselves (9 places).
- **`assetBrowser.ts`** (21 files: `fileName` ×18, `assetKind` ×10, `listedFiles`, `folderOf`, `modelNodeEntries`), `projects.ts` (11, mostly the `EditorProject` type), the graph view (10), `document` (10, `SetField`), `messages.errorStatus` (9), `assetOps.freePath` (7), `assetDocuments` (6), `theme`, `ui/AssetPreview`, `assetImport`, `layout/store.showPanel`, `projectSettingsModel`, `ui/WorldsPanel` (for `TextField`/`NumberField`), `preferences`, and nine more with one or two users.
- **The "create a file" code was written 8 times** (materials, shaders, shader graphs ×2, formations, particle sub-graphs and blocks, skies, tilesets): read the project, refuse a read-only one with the same sentence, `freePath`, write, `errorStatus`, bump `docVersion`, "Created <name>.".
- **A third-party plugin (0139) gets only `myco/editor`**, which held contribution points, `openAssetDocument`, the active history and `activeViewportTool`. It could not read the open project, report to the status bar, find a free file name or tell what kind a path is.

## Decision

We will give `myco/editor` a small project and editor surface, migrate every first-party editor half to it, and make the boundary a test.

**One `editor` object** (`src/editor/sdk/editor.ts`), with four parts and one function, each a typed interface over the shell's existing code. Getters read the signals, so reading one in a component, `computed` or `effect` tracks it as the signal did; `peek…` reads without tracking.

- **`editor.project`** (`sdk/project.ts`, `ProjectSurface`): `current`, `peek()`, `version` (the old `docVersion`: bumped when the open scene or a project file changes), `peekVersion()`, `changed()`, `refuseReadOnly(project, what)`, `createFile({ folder, name, what, write(project, path), created? })`, `freePath(project, folder, name, copy?)`, `joinPath(root, path)`. `createFile` holds the eight copies' logic: no project → null; read-only → one info message ("<project> is read-only. Open a project folder (or copy the sample) to add <what>."); free name; write; failure → "Couldn't create <path>: …"; success → `changed()` and "Created <file>." (or `created(path)`).
- **`editor.assets`** (`AssetsSurface`): `kindOf(path)` (the asset kind module's `assetKind`, 0143), `fileName`, `folderOf`, `listed(files)` (sidecars left out), `isScene`, `importSettings(project, path)`, `reveal(path)` (Assets panel and Inspector), `openScript(path, at?)`.
- **`editor.messages`** (`sdk/messages.ts`, `MessagesSurface`): `info(text, detail?, action?)`, `error(text, detail?, action?)`, `failed(context, err)` (the old `errorStatus`), `clear()`. The status signal and `Status` type stay shell-only.
- **`editor.scene`** (`sdk/scene.ts`, `SceneSurface`): `open`, `peekOpen()`, `tabs`, `playState`, `peekPlayState()`, `selection` (`keys`, `active`, `peekActive()`, `peekKeys()`, `path()`, `node()`, `nodes()`, `set(keys, active?)`), `uniqueId(doc, base)`, `idBase(path)`. Editing still goes through the scene's `stack` with `SetField` (0026).
- **`editor.showPanel(id)`**.

**Building blocks re-exported flat** from `myco/editor`, because 0133 already names them SDK: `SetField`, `pathKey` and the `NodePath`/`NodeEntry`/`SceneDocument`/`OpenScene`/`EditorProject` types; `sectionField`; `LargePreview`; the settings controls `Row`, `NameList`, `ProblemList`, `TextField`, `NumberField` (the last two move from `ui/WorldsPanel.tsx` to `ui/settingsControls.tsx`, so importing them no longer loads the Worlds panel); `setValue` with `SettingsDraft`/`SettingsProblem`; `persisted`; the theme (`theme`, `mix`, `parseHex`, `viewportColors`, `ThemeTokens`); and the whole graph view (`src/editor/graph/`, 0060).

**State stays hidden.** `state.ts`'s signals (`currentProject`, `docVersion`, `status`, `openScene`, `selectedKeys`, …) are not exported from `myco/editor`; the shell keeps using them directly. A test asserts they are absent.

**First-party plugins import the SDK entry** by relative path (`../../../editor/sdk`), the convention so far: there is no Vite alias for `myco/editor` inside the repository, and the third-party pipeline (0139) maps `myco/editor` to the same module (`thirdPartyEditor.ts`'s `__mycoEditor`). Deep imports of `sdk/contributions` become imports of the entry.

**Moves (shell code only one plugin used):** `modelNodeEntries` → `src/plugins/meshes/editor/modelNodes.ts`; `worldsConfig.uniqueName`'s three lines → a local helper in `navSettingsModel.ts`; `freePath`/`splitExtension` → a new leaf `src/editor/freePath.ts` that `assetOps.ts` re-exports.

**The SDK's own imports never reach the plugins.** Plugin modules call the SDK while loading (`persisted(…)`); if the SDK's import graph reached `plugins/editor.ts` (it did, through `assetOps.ts` → `session.ts` → `editorApply.ts`, now `editorPlugins.ts`, 0144), a plugin module would run while `myco/editor` is still loading and read `undefined`. That is why `freePath` moved to a leaf module, and a test walks the SDK's static imports and fails if any reaches `src/plugins/` (beyond `manifest`/`order`).

**The internal tier, kept small and listed** in `plugins/plugins.test.ts` as `<file> -> <module>` pairs; anything else under `src/editor/` fails, and an entry that is no longer used fails too, so the list only shrinks:

- the play session (`session`, `state.playing`, `playMode` type) for Navigation's debug overlays and panel, and `projects.editorSettings` for baking: both reach a World, which stays internal as for viewport tools (0138);
- `sceneTools` (snapping) for the collider gizmo, viewport-tool internals (0142);
- `polygonMath` for collider maths, geometry shared with the shell's marquee selection;
- `projectSettingsModel`'s layer and collision-matrix helpers and `layerRenameEdit` for the Physics settings section: core `project.json` keys the shell owns (0116);
- `materialExtract` for the Meshes plugin's Extract Materials, which writes material assets and the model's sidecar through the shell's import settings writer (the model import settings moved into the plugin with 0143, after this record was written);
- three shared stylesheets (`ui/assetInspector.css`, `ui/bake.css`, `graph/graph.css`): class names, no code.

**Tests can use the surface.** `src/editor/testing.ts` gains `openTestProject(files)` (a writable in-memory project set as the editor's project) and `closeTestProject()` (clears project, status and selection); the Sky plugin's test uses them. Tests that make editor halves active do so through 0144's plugin set helper (`useEditorPlugins`) and register the core asset kinds with `useCoreAssetKinds` (0143). `src/editor/sdk/editor.test.ts` covers the surface.

## Alternatives considered

- **Four top-level exports (`project`, `assets`, `messages`, `scene`)** — shorter call sites, but `project` and `scene` are the natural local names: plugin editor halves declare `const project` / `const scene` on 30 lines, so every file would alias the imports. One `editor` root reads well beside them (`const project = editor.project.current`).
- **Methods on `EditorPluginContext`** — the context exists only during `activate`; components, stores and lazy inspectors that need the project run later and would have to thread it through. A module export is reachable anywhere in the editor half.
- **Re-export the signals (`currentProject`, `status`, …) from the SDK** — no migration cost, but it freezes `state.ts`'s shape as public API and lets plugins write editor state (`status.value = …`, `docVersion.value++`) without a rule. The getters keep tracking without exposing the signals.
- **Flat functions (`fileName`, `assetKind`, …) instead of grouped objects** — what plugins used before; dozens of generic names (`fileName`, `px`, `theme`) in one namespace beside the graph view's. Groups keep the editor surface small; widely used building blocks (fields, graph, theme) stay flat because they are components and constants, not editor state.
- **Leave stylesheets out of the rule or have the SDK import them** — loading 10 KB of panel CSS with the SDK at boot runs against 0083's lazy loading; ignoring CSS would hide the coupling. They are listed instead (open question below).

## Consequences

**Positive**
- Plugin editor halves import shell internals in 4 files (8 statements: the listed internal tier; one more once 0143's model import settings joined the Meshes plugin) instead of 57 files (157 statements); 69 files import the SDK entry, up from 19.
- A third-party editor half can read the project, create files, report status, tell asset kinds and read the selection with what `myco/editor` already gives it.
- The create-a-file logic and its read-only message exist once (`editor.project.createFile`); the 8 copies are gone.
- New plugin→shell imports and SDK import cycles fail CI.

**Negative / costs**
- More public SDK surface to keep stable from v1 (0133); `EditorProject`, `OpenScene` and `SceneDocument` were already reachable through contribution types and stay so.
- Call sites are longer (`editor.assets.fileName(path)` for `fileName(path)`).
- `src/editor/sdk/` must not import modules that reach `session.ts`; the test says so, but a shell helper a plugin wants may have to move to a leaf module first, as `freePath` did.

## Deprecates

- Plugin imports of `state.ts`, `assetBrowser.ts`, `assetOps.ts`, `messages.ts`, `projects.ts`, `assetImport.ts`, `assetDocuments.ts`, `layout/store.ts`, `code/codeState.ts`, `document`, `graph`, `theme.ts`, `preferences.ts`, `ui/AssetPreview.tsx`, `ui/inspectorSections.tsx`, `ui/settingsControls.tsx`, `ui/WorldsPanel.tsx`, `worldsConfig.ts`, `sdk/contributions.ts` (deep): replaced by `myco/editor`.
- `assetBrowser.ts`'s `modelNodeEntries` (moved to the Meshes plugin); `TextField`/`NumberField` in `ui/WorldsPanel.tsx` (moved to `ui/settingsControls.tsx`, not re-exported).

## Open questions

- Should `myco/editor` carry the shared stylesheets (asset Inspector, bake sections, graph view) so third-party plugins get the class names, perhaps loaded on first use of a component that needs them?
- Physics layers: a small `editor.project.layers` surface, or a contribution point for core `project.json` keys, would retire two internal-tier entries.
- Should the play session's Worlds become an SDK service for overlays (0138's internal tier), or stay first-party?
- `editor.project.version` is one coarse counter; per-file change events would let panels skip re-reads.

## References

- `src/editor/sdk/editor.ts`, `sdk/project.ts`, `sdk/messages.ts`, `sdk/scene.ts`, `sdk/index.ts`, `src/editor/freePath.ts`, `src/editor/ui/settingsControls.tsx`, `src/editor/testing.ts`
- `src/plugins/meshes/editor/modelNodes.ts`, `src/plugins/navigation/editor/navSettingsModel.ts`
- Tests: `src/editor/sdk/editor.test.ts`, `src/plugins/plugins.test.ts` ("plugin editor halves reach the editor through its SDK"), `src/plugins/sky/sky.test.ts`

## Amendment (ADR 0172 §1.8, 2026-11-13): `editor.project.onSectionChanged`

Written by task Hk1 for [0171](0171-audio-profiler-loudness-metering-and-live-mixing.md) as amended by [0172](0172-audio-mix-design-corrections-and-owner-decisions.md) §1.8. This record is still Proposed, so the change is a section appended here, not a new record.

`editor.project` gains one method:

```ts
onSectionChanged(key: string, listener: (change: SectionChange) => void): () => void;

interface SectionChange {
  readonly key: string;      // the top-level project.json key: "audio"
  readonly before: unknown;  // the key's value before and after, as the drafts hold them
  readonly after: unknown;
  readonly cause: "edit" | "undo" | "redo" | "external";
}
```

- **When it fires.** Synchronously, from a project section's `edit` right after the history push and from its undo and redo, for each owned key whose value now differs from the last value listeners were told about. A draft with problems never fires it. The next valid draft carries the changes an invalid one held, so `before` is the last valid value, not the previous draft. A failed disk write doesn't stop it: the live sound follows the draft, and the section keeps its unsaved draft and error. `cause: "external"` (an outside edit of `project.json`) is reserved in the type and not fired yet.
- **What it skips.** A preview that never enters the undo history (a fader drag in progress) doesn't use it; the plugin applies those to its engine directly. Only the commit comes through the hook.
- **Why the name.** `ProjectSurface.changed()` already exists with no arguments and means "files or the open scene changed, re-read `version`". It keeps that meaning; the hook is a second, keyed channel.
- **Listeners.** A throwing listener is logged and doesn't stop the others or the edit. The unsubscribe is idempotent.
- **Imports.** The registry is a leaf module (`src/editor/sectionChanged.ts`) that imports nothing; `sdk/project.ts` re-exports it and `projectSection.ts` fires it. The SDK still imports no plugin, so the rule that the SDK's imports never reach `src/plugins/` holds, and the internal-tier list is unchanged.
- **First user.** The audio plugin's op log (`src/plugins/audio/editor/mix/opLog.ts`) listens on `"audio"`, turns the change into mix ops and, only while Play runs, hands them to `mixer.apply`.
- **Consequence.** One more method of public SDK surface to keep stable from v1 (0133).
