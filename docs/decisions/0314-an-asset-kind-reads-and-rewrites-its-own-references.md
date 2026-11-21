# 0314. An asset kind reads and rewrites its own references

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** 0302 in part (model files are rewritten on a move, not reported)
- **Related:** 0088, 0134, 0148, 0302

## Context

An asset kind's `references` (ADR 0148, `AssetReferenceExtractor` in `src/editor/sdk/contributions.ts`) only read:
the Meshes plugin's readers (`src/plugins/meshes/editor/modelReferences.ts`) say which files an `.obj`, `.mtl` or
`.gltf` names, but nothing could write those files. A move rewrote JSON files through their owners (ADR 0302) and
reported every model file that named an old path as "not rewritten" (`rewriteReferences` in
`src/editor/assetReferences.ts`), which ADR 0302 left as an open question.

Worse, model files name things by paths **relative to their own folder**. Moving a `.gltf` without its `.bin`, an
`.obj` without its `.mtl`, or an `.mtl` without its textures broke the moved file's own references, and nothing said
so: `assetUsers(froms)` only finds files naming the old paths, and the moved file names files that didn't move
(confirmed by test). Reading also had gaps: `mtllib` with several libraries kept only the last, and a Windows `.mtl`
with CRLF line endings or `..` in a path resolved to nothing.

## Decision

We will make the kind's `references` member two-way: it reads the files its format names and rewrites them for a set
of moves, covering both files that name a moved file and a moved file's own relative references.

- **SDK (`myco/editor`).** `AssetReferenceExtractor` becomes `AssetReferences`: `extensions?` and
  `read(path, text)` as before, plus optional `rewrite(path, text, moves): string | null`, where `moves` is a
  `ReferenceMoves` `{ from, to(path) }`: where the file was before the moves, and where any project path is after
  them. `rewrite` returns the new text, or null when nothing changes. A kind without `rewrite` keeps the old
  behaviour: its files that name a moved path are reported.
- **The shell asks the kind for files that aren't JSON.** `rewriteReferences` runs the project file edit for JSON
  files (ADR 0302, unchanged: the generic JSON walk through each file's owner), then, for each other file whose kind
  has a `rewrite` for its ending, reads its text (from the project's URL for byte-served files), calls `rewrite` with
  the file's old path, and writes the result with `project.writeFile`. Written files join `updated`; `notRewritten`
  is what `assetUsers` still finds under the old paths (scripts, kinds without `rewrite`). The step lives in
  `assetReferences.ts`, not in `projectFileEdits.ts`: only moves rewrite own formats (deletes keep references, and
  settings name renames never touch model files), so the owner dispatch stays JSON-only.
- **JSON files stay with their owners, whatever their kind.** Audio events (`eventAsset.ts`) keep a read-only
  `references`: an event is JSON, its clip paths are reference strings, and its open asset document applies a move
  to every state of its history (ADR 0302). Rewriting it as text through the kind would bypass that and change nothing.
- **Meshes implements both for `.obj`, `.mtl` and `.gltf`.** Each format finds its reference tokens once (Wavefront:
  every `mtllib` file, a map statement's last word after its options; glTF: every `"uri"` string, URI-decoded,
  `data:` and other schemes skipped); `read` resolves them against the file's folder, `rewrite` splices the new
  relative path into the same place, so layout, comments, options and line endings are kept byte for byte. A
  reference is rewritten when its target moved or the file moved and it no longer resolves to the same target; only
  relative references count (absolute paths, drive letters and URLs are left as written). Path arithmetic is its own
  module, `src/plugins/meshes/editor/relativePaths.ts` (`resolveRelative`, `relativePath`, `isRelativeReference`).
- **`.glb` (and `.fbx`) are neither read nor rewritten.** A `.glb` keeps its JSON in a binary chunk; rewriting it
  means re-chunking with padding and a byte interface beside the text one, for a rare case (a `.glb` almost always
  embeds its buffer and images). A `.glb` with external URIs that moves alone still breaks them unreported; recorded
  below.

## Alternatives considered

- **Keep reporting model files** (ADR 0302) — honest, but the user fixes paths by hand in a text editor, and a model
  moved alone breaks silently, which no report covers.
- **A separate `rewrite` contribution beside `references`** — two members that must agree on the same tokens; one
  member keeps a format's reading and writing in one module.
- **Kind rewrite for every file, JSON included** — would put audio events through text, around the asset document
  that keeps their undo history right (ADR 0302).
- **The shell rewrites relative paths for every kind** — the shell knows no model format (ADR 0148); a format's
  reference rules belong in its plugin.

## Consequences

**Positive**
- Moving a texture, a material library or a buffer rewrites the model files that name it; moving a model alone
  keeps it loading. The Assets panel's "weren't changed" list is now scripts and kinds that only read.
- Each format's reference rules, read and write, are in one plugin module; the tests rewrite through the kind.
- Reading improves on the way: several `mtllib` files, CRLF files, `..` and `\` in paths.

**Negative / costs**
- A move reads every model file whose kind rewrites (as `assetUsers` already did for the report).
- A rewritten model file isn't an undo step (like any reference rewrite, ADR 0302); moving the file back rewrites it
  back.
- A public editor SDK change: plugins that named `AssetReferenceExtractor` rename it to `AssetReferences`.

## Deprecates

`AssetReferenceExtractor` (renamed `AssetReferences`, no alias); ADR 0302's "files no owner can rewrite are reported"
for `.obj`, `.mtl` and `.gltf`.

## Open questions

- A byte form of `rewrite` for `.glb` external URIs, if projects turn out to ship them.

## References

- `src/editor/sdk/contributions.ts` (`AssetReferences`, `ReferenceMoves`), `src/editor/assetReferences.ts` (`rewriteReferences`)
- `src/plugins/meshes/editor/modelReferences.ts`, `src/plugins/meshes/editor/relativePaths.ts`, `src/plugins/audio/editor/eventAsset.ts`
- Tests: `src/editor/assetReferences.test.ts` (Meshes block), `src/plugins/meshes/editor/modelReferences.test.ts`, `src/plugins/meshes/editor/relativePaths.test.ts`
