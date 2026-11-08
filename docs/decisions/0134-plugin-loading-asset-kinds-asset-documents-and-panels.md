# 0134. Editor plugins load from a first-party list and contribute asset kinds, asset formats and panels; asset documents own editing

- **Status:** Accepted
- **Date:** 2026-11-08
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0133 (builds its first contribution points), 0026, 0027, 0046, 0060, 0083, 0112, 0114

## Context

ADR 0133 makes features plugins and picks Sky as the pilot. The pilot has to settle the first editor contribution points: asset kinds, the asset document module and panels. The Sky editor today is spread across `skyAssets.ts` (its own write queue), `ui/SkyPanel.tsx` (debounce, history, outside-change detection, inline), `ui/AssetInspector.tsx` (`SkyInspector`), and `"sky"` entries in about 10 shared tables (`assetBrowser.ts`, `ui/Assets.tsx`, `ui/AssetPreview.tsx`, `assetImport.ts`, `assetFieldKinds.ts`, `thumbnails/keys.ts`, `layout/model.ts`, `ui/panels.tsx`).

## Decision

**The editor SDK** lives in `src/editor/sdk/` (what `myco/editor` will resolve to): `registry.ts`, `contributions.ts`, `plugins.ts`, and `openAssetDocument` from `src/editor/assetDocuments.ts`.

- **Registries.** Each contribution point is a `Registry<T>`: `register(entry)` returns an undo function, `get(id)`, `list()`, and a `version` signal UI reads to follow changes. Ids are unique; a duplicate throws.
- **Plugins.** An editor half is `{ manifest, activate(context) }`. `context.registerAssetKind/registerAssetFormat/registerPanel` record every registration, so `deactivatePlugin(name)` removes all of them, and a plugin whose `activate` throws is rolled back. `orderPlugins` sorts by `manifest.dependencies`, refusing missing dependencies and cycles.
- **Loading.** First-party editor halves are listed in `src/plugins/editor.ts` (`EDITOR_PLUGINS`) and runtime halves in `src/plugins/runtime.ts`. `main.tsx` activates the editor halves before the layout loads. A failing plugin is reported in the status bar and doesn't stop the editor. A test checks that runtime halves never import editor code.
- **Asset kinds** (`AssetKindContribution`): `id`, `extensions` (longest match over all kinds wins, case-insensitive), `label`, `icon` (an SVG path), and optional `open(path)`, `inspector` (loaded on first use), `create` (a New… entry), `referencedAs` (the field kinds that also accept it: the "which fields may reference it" policy) and `preview` (which built-in thumbnail renderer draws it; renderers stay internal, ADR 0133). The shared tables consult the registry first and fall back to their built-in entries, which go away kind by kind as features move into plugins.
- **Asset formats** (`AssetFormatContribution<T>`): `id` (the kind), `parse(raw, path) → { value, problems }`, `format(value) → text`, `writeDelay`.
- **Asset documents.** `openAssetDocument(project, path, formatId)` returns one `AssetDocument<T>` per open file: `value`, `problems`, `readOnly`, `canUndo`/`canRedo` signals, `edit(next, { coalesce })`, `undo`, `redo`, `flush`. It owns the per-path write queue, the read-only refusal and its message, bumping `docVersion`, telling its own writes from outside changes, and the undo history. Coalesced edits (sliders) make one undo step and one write after `writeDelay` of quiet. `moveAssets` and `deleteAssets` tell it about renames and deletes: history follows a rename and is dropped on delete.
- **History is in memory for now.** ADR 0133 gives asset documents 0027's persistent tree. The pilot keeps a linear, in-memory history behind the same interface. Persisting it changes no caller.
- **Panels** (`PanelContribution`): `id`, `title`, `view` (loaded on first use), `beside`, `onDemand`. `PanelId` widens to any string; the layout, the Window menu and preloading merge built-in and registered panels. A saved layout naming a panel no plugin registers is dropped from the layout.
- **The Sky plugin** (`src/plugins/sky/`). Its editor half registers the `sky` asset kind, its format (`parseSky`/`formatSky`), the Sky panel and the Sky inspector. `SkyPanel` edits through an asset document. The `"sky"` entries in the shared tables, `skyAssets.ts` and the built-in Sky panel are removed.
- **The Sky runtime half stays in `src/engine/sky/` for now.** The `Sky` component and its public exports (`myco`) and the internal sky render feature move when the runtime contribution points (Components, render features) are built. `src/plugins/sky/runtime/` re-exports them so the plugin's shape is already right.

## Alternatives considered

- **One registration call per plugin with a big object** (`{ assetKinds: [...], panels: [...] }`). Declarative, but harder to make conditional and no simpler to undo; the context records registrations either way.
- **Build the persistent history (0027) for asset documents now.** It needs a history file format for whole-value snapshots and recovery UI; not needed to prove the seam.
- **Move the Sky component and render feature now.** The engine library build and `myco`'s exports would have to import from `src/plugins/`, inverting the dependency before the runtime contribution points exist.

## Consequences

**Positive**
- A new asset kind, format or panel is added from a plugin without editing shared tables.
- Sky's editing gets rename-safe undo and the shared write queue; the other kinds get the same when they move.
- Asset-document behaviour is unit-tested in Node without Preact.

**Negative / costs**
- Two ways of defining kinds and panels until every built-in moves.
- Sky's runtime half is only a re-export until the runtime contribution points exist.

## Deprecates

`src/editor/skyAssets.ts`, the Sky panel's built-in registration, `SkyInspector` in `ui/AssetInspector.tsx`, and the `"sky"` entries in the shared asset tables.

## Open questions

- Persistent asset-document history (0027).
- Static asset kinds in `plugin.json` for third-party plugins (0133).
- Runtime contribution points: Components, World services, render features (internal).

## References

- [0133](0133-features-are-plugins-over-an-engine-and-editor-sdk.md); `src/editor/sdk/`; `src/editor/assetDocuments.ts`; `src/plugins/`.
