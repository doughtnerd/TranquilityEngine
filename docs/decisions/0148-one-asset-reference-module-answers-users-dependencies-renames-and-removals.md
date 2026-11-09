# 0148. One asset reference module answers users, dependencies, renames and removals, and asset kinds extract their own format's references

- **Status:** Accepted
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0040, 0061, 0088, 0133, 0143, 0146

## Context

The rule "which files refer to asset X" was written four times in the editor, and the copies disagreed:

- `assetDelete.ts` `assetUsers` (the delete dialog's user list) matched `"p"`, `'p'`, `asset:` and `#slice` in JSON files, scripts and the open scene's unsaved document. Its `removeReferences` matched double quotes only, and had its own scene-file test (format and `nodes`).
- `assetOps.ts` `updateReferences` (rename and move) matched only a `"from` prefix and tested scene files with a bare format regex. So a rename could miss a reference the delete dialog listed (`'…'`, `./…`), and the scripts it listed for a folder move missed files inside the folder.
- `assetCleanup.ts` had a third "names this path" rule for the edits themselves.
- `thumbnails/keys.ts` `jsonReferences` parsed JSON with yet another rule (no `./`), and held the OBJ/MTL and glTF reference parsers: Meshes plugin knowledge in the shell, which ADR 0146 says holds no plugin formats. The thumbnail service also matched `.obj`/`.mtl` by name to decide which byte-served files to read as text, so `.gltf` dependencies were never read in a real project.
- About 18 places stripped `asset:` by hand (`replace(/^asset:/, "")`), some also `./`, some not, and slices handled ad hoc.

Rename and delete each repeated the same loop: for each JSON file, write it as a scene (keeping layout) and rebuild the open scene's instances of it, or write it as JSON; then edit the open scene as one undo step.

## Decision

We will keep one deep module, `src/editor/assetReferences.ts`, that answers every reference question, and let asset kinds contribute how their own formats name files.

- **Reference strings.** `parseAssetRef(ref)` splits `asset:./images/a.png#walk` into prefix (`asset:`, `./`, `/`, kept on rewrite), path and slice. `assetRefPath` (path only), `assetRefTarget` (path with slice; the engine's `normalizeAssetPath`) and `namesAsset(value, path)` (the file or one of its slices; a slice path names only that slice) are the only normalisers editor code should use.
- **Users.** `assetUsers(project, path, openDocument?)`: JSON files and scripts whose text holds a quoted reference (single, double or back quotes; optional `asset:` and `./`) to the path, one of its slices, or (for a folder) something inside it, plus the open scene's unsaved document. `scriptUsers(project, paths)` is the script half. Rename, delete and the delete dialog all use this one text rule as their pre-filter, so rename now catches what the user list shows.
- **Dependencies.** `assetDependencies(source, path)`: the project files a file names directly: its kind's extractor if it has one, else every reference string in a JSON file. `thumbnails/keys.ts` follows it transitively and adds import settings sidecars.
- **Edits.** `rewriteReferences(project, moves, label)` (files, folders or slices `image#name`) and `removeReferences(project, path, label)` share one private loop that knows scenes and prefabs (`format` `myco|tranquility.scene@` with `nodes`: written keeping layout, instances in the open scene rebuilt), `project.json` (settings) and plain JSON, and edits the open scene as one `ReplaceDocument` undo step. Rename rewrites every JSON kind; delete cleans scenes, prefabs and settings (`sceneWithoutAsset`, `settingsWithoutAsset`, folded in from `assetCleanup.ts`) and leaves other JSON and scripts to the user list. Scripts are never rewritten. Unparsable JSON files are skipped.
- **Asset kind contribution.** `AssetKindContribution` gains `references?: AssetReferenceExtractor` (`myco/editor`): `{ extensions?, read(path, text) }`. `read` returns project paths resolved against the file's folder; the module keeps those that are project files. `extensions` limits which of the kind's endings are text it reads (absent: all), so binary files are never decoded. The thumbnail service reads the text of byte-served files whose kind reads them (`hasOwnReferences`).
- **Meshes.** The OBJ/MTL and glTF parsers move to `src/plugins/meshes/editor/modelReferences.ts`. The `model` kind reads `.obj` and `.gltf` (not `.glb`, `.fbx`). The plugin registers an `mtl` kind ("Material Library", `.mtl`) whose extractor reads texture maps; before, `.mtl` files were plain "File" entries.

## Alternatives considered

- **A separate reference-extractor registry keyed by extension.** One more contribution point for what is a property of a file type; an asset kind already is "one type of asset file and how the editor treats it".
- **Treat `.mtl` as one of the model kind's extensions.** It would then satisfy `model` and `mesh` fields and get a model preview, which it isn't.
- **Keep the pure rules and the project edits in two modules.** The edit loop is where the copies drifted; splitting it again would recreate two places that must agree. The module is heavier to import (state, prefabs, scene writer), which `thumbnails/keys.ts` accepts.
- **Rewrite scripts on rename.** Text edits to code are unsafe without parsing; scripts stay listed, as before.

## Consequences

**Positive**
- One rule, tested once (`assetReferences.test.ts`); rename, delete, the delete dialog and thumbnail keys agree.
- Renames now update `./`-prefixed references (prefix kept) and plain JSON with any quote style the users list sees, and list scripts quoting files inside a moved folder or in single or back quotes.
- The shell holds no model format (ADR 0146); `.gltf` dependencies now re-key thumbnails in real projects.

**Negative / costs**
- A public editor SDK change: `AssetKindContribution.references` and `AssetReferenceExtractor`.
- `.mtl` files show as "Material Library" with an icon, not "File".
- Deleting no longer throws on a broken JSON file that mentions the asset; it is skipped and still listed as a user.

## Deprecates

`src/editor/assetCleanup.ts` (folded in and removed), `assetDelete.ts`'s `assetUsers`/`removeReferences`/`isSceneFile`, `assetOps.ts`'s `renamer` and its own reference loop, and `thumbnails/keys.ts`'s `jsonReferences`, `wavefrontReferences` and `gltfReferences` (moved to the Meshes plugin).

## Open questions

- Plugins still strip `asset:` by hand (`replace(/^asset:/, "")` in Materials, Particles, Navigation, Tilemaps, Sky). Exposing `parseAssetRef`/`assetRefPath` on `editor.assets` (ADR 0147) would let them share the rule.
- Script dependencies: `assetDependencies` reads JSON and kind formats, not scripts (the engine's `scriptAssetRefs` reads prefab, material and particle literals for warm-up).

## References

- `src/editor/assetReferences.ts`, `src/editor/assetReferences.test.ts`
- `src/plugins/meshes/editor/modelReferences.ts`
- `src/editor/sdk/contributions.ts` (`AssetKindContribution.references`, `AssetReferenceExtractor`)
- `src/editor/assetDelete.ts`, `src/editor/assetOps.ts`, `src/editor/thumbnails/keys.ts`, `src/editor/thumbnails/service.ts`
