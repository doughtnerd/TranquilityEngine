# 0233. Asset kinds declare their format, folder and panel; the asset kind host creates, reads and opens their files

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0134: asset formats are part of the asset kind, `registerAssetFormat` goes; amends 0143 and 0149: opening and the New… entries move from the asset kind module to the host)
- **Related:** 0027, 0133, 0134, 0143, 0147, 0149

## Context

Each plugin's editor half rewrote the same asset-kind plumbing around `registerAssetKind` and `registerAssetFormat`:

- **Default folder.** `folder === "" && editor.project.current?.folders.includes("x") ? "x" : folder` had 7 copies (particles, materials, shaders, shader graphs, formations, skies, audio events), plus 2 in the shell (New Scene, Create > UI Document).
- **Parse or default.** `readMaterial` and `readFormation` copied `materialFormat.parse` and `formationFormat.parse` line for line, and 6 formats wrapped their engine parser in the same `try/catch` that returns a default value.
- **Open in panel.** Particles, shader graphs, skies and audio events each kept a signal of "the file this panel has open" and a function that set it and called `showPanel`.
- **Stale reads.** `readEffect`, `readShaderGraph`, `readFormation` and `readShaderAsset` parsed the file text, so an Inspector showed the last written value while the asset document (0134) held a newer one in its write queue.
- `readMaterial` was called only by its test, and `ReadTileset` was dead (CLAUDE.md's no-test-only-code rule).

## Decision

We will let an asset kind declare its format, default folder and panel, and give every kind the same create, read and open behaviour from one module, the asset kind host (`src/editor/assetKindHost.ts`).

- **The kind declares** (`AssetKindContribution<T>`, `sdk/contributions.ts`):
  - `format?: AssetFormat<T>`: `parse(raw, path)`, `format(value)`, `empty()` and `writeDelay`. `parse` may throw for a file it can't read; the host reads that as `empty()` with the error's message as the one problem. The separate asset format registry, `registerAssetFormat` and `AssetFormatContribution` go: an asset document's format is its kind's.
  - `folder?: string`: where new files go when no folder is asked for, used when the project has it.
  - `panel?: string`: the panel that edits its files. Ignored when `open` is set.
  - `create?`: either `{ label, name?, what, value?() }` (the host writes `<name><first extension>` with the format), or `{ label, create(folder) }` for a kind that writes its own files (New Scene, New Shader, New UI Document, New Render Texture), given the folder the host chose.
- **The host provides**, on `editor.assets` (0147):
  - `create(kind, { folder?, value?, name? })`: a new file in `folder`, else the kind's `folder`, else the root; refuses in a read-only project naming `what`; reports success or the error. The Assets panel's New… entries (`kindCreators()`, moved here from the asset kind module) ask for no folder at the project root and for the panel's folder elsewhere, so the old rule holds everywhere. File > New Scene and Create > UI Document use it too (`scene` declares `folder: "scenes"`, `uidocument` `folder: "ui"`).
  - `read(project, path)`: the current value, `{ value, problems }`. The asset document module answers it (`readAsset` in `assetDocuments.ts`): the open document's value, unwritten edits included, else the file parsed with the kind's format. This is the one rule for "which value is current".
  - `open(path)` and `openIn(panel)`: opening a file runs the kind's `open`, else makes it the `panel`'s file and shows the panel, else opens it in the Code panel (`openAsset`, moved here from the asset kind module). `openIn(panel)` is the file open in that panel in the open project (null after a project switch). Panels read it instead of a signal of their own.
  - `openAssetDocument(project, path, kind?)` takes the kind from the path when it is left out.
- **Moved onto it:** the Particles (3 kinds), Materials (material, shader, shader graph, sub-graph), Navigation (formation), Sky, Tilemaps (tileset) and Audio (`audioEvent`) plugins. `skyAssets.ts` and `formationAssets.ts` are deleted; `readEffect`, `readMaterial`, `readShaderGraph`, `readShaderAsset`, `readFormation`, `ReadTileset`, the `create*` helpers and the open signals go. A particle effect's "old format" flag, a fact about the file, stays the plugin's (`effectFileMigrated`).
- **Not moved:** the audio music panels (segment view, segment properties, rules) open a node *inside* an event, not a file, so they keep their own state.

## Alternatives considered

- **Keep `registerAssetFormat` beside the kind and add only `folder` and `panel`.** Every format is one kind's (the ids already matched one to one), so two registrations for one thing kept a way to get them out of step and a second lookup.
- **A base class or helper module plugins call (`makeAssetHelpers(kind)`).** Each plugin would still wire it; the host can do it from the declaration alone, and the New… menu and double-click already go through the host.
- **Make `read` always parse the file.** Cheaper to explain, but it is the stale-Inspector bug.

## Consequences

**Positive**
- About 200 lines leave six plugins; a new asset kind with a format gets New…, a default folder, reading and a panel by declaring them.
- Inspectors show the value being edited, not the last write.
- The host is tested once with a fake kind (`assetKindHost.test.ts`); plugin tests go through `editor.assets` and the kind's contribution.

**Negative / costs**
- A public SDK change (experimental, 0133): `registerAssetFormat` and `AssetFormatContribution` are removed; `AssetKindContribution` is generic and its `create` a union.
- New Scene and New UI Document from the New… menu at the project root now go to `scenes/` and `ui/` when the project has them, as File > New Scene and Create > UI Document always did.
- Save Selection as Sub-graph writes beside its effect even at the project root (it went to `effects/` there before, against its own comment).
- A thrown parse error's problem has no severity; the Particle Graph shows a problem without one as an error.

## Deprecates

`registerAssetFormat`, `AssetFormatContribution`, the `assetFormats` registry; `openAsset` and `kindCreators` in `assetKindLookup.ts` (moved to `assetKindHost.ts`); `readMaterial`, `readShaderAsset`, `readShaderGraph`, `readFormation`, `readEffect`, `ReadTileset`, `createMaterial`, `createShaderGraph`, `createShaderSubGraph`, `createParticleEffect`/`Subgraph`/`Block`, `createFormation`, `createSky`, `createTileset`, `writeMaterial`, `formatTileset` (now the format's), `openParticleGraph(Asset)`, `openShaderGraph(Asset)`, `openSky(Asset)`, `openEvent`/`openEventEditor`; `skyAssets.ts`, `formationAssets.ts`. All removed.

## Open questions

- `freePath`'s `splitExtension` still lists plugin compound extensions by name (`.particles.json`, `.formation.json`…), and misses `.tileset.json` and `.audioevent.json`; it could ask the registered kinds.
- The particle sub-graph and block Inspector still reads the file's asset JSON (it reports "not a sub-graph" from the raw file).

## References

- `src/editor/assetKindHost.ts` (+ `assetKindHost.test.ts`), `src/editor/assetDocuments.ts`, `src/editor/sdk/contributions.ts`, `src/editor/sdk/project.ts`, `src/editor/assetKindLookup.ts`
- Architecture review, 2026-11-17 (candidate 5).
