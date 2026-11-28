# 0466. One runtime rule resolves a relative path inside the project

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0013, 0077, 0088, 0394, 0423, 0454, 0459

## Context

Files name other files relative to themselves: a glTF its buffers and images, an OBJ its material libraries, a model
its textures, a UI stylesheet its `url()`s. Each had its own resolver, and they disagreed:

- `gltf.ts` `projectFiles().resolve`: `..` above the project was dropped (`../../x.bin` from `models/a.gltf` → `x.bin`),
  `/abs/x.png` → `abs/x.png`, `C:/t.png` → `C:/t.png`.
- `models.ts` `resolveRelative` (textures, `mtllib`): `..` above the project → null; `/…` and `C:…` → null.
- `ui/document/sourceText.ts` `resolvePath` (the cascade's `url()`): `..` above the project dropped; `/x` the project
  root.
- The folder of a path was computed inline three more times.

So the same reference found a file through one loader and nothing through another.

## Decision

We will resolve relative paths at runtime only through `src/engine/core/projectPath.ts`, which imports nothing:

```ts
fileName(path): string                  // models/a.gltf → a.gltf
folderOf(path): string                  // models/a.gltf → models; a.gltf → "" (the root)
resolveRelative(fromFile, rel, opts?: { leadingSlash?: "projectRoot" | "outside" }): string | null
```

`resolveRelative` reads backslashes as `/`, folds `.` and `..` against `fromFile`'s folder, and returns null when the
path climbs above the project folder or starts with a drive letter (another machine's path). What a leading `/` means
is the caller's: `"outside"` (the default, null) for model files, which come from other tools and machines;
`"projectRoot"` for UI documents, where `/images/a.png` has always meant the project's `images/a.png`.

The editor's `src/editor/projectPath.ts` (ADR 0454) now re-exports `fileName` and `folderOf` from it.

## Alternatives considered

- **Clamp at the root, as glTF and the cascade did** — `../../x.bin` would quietly find an unrelated `x.bin` at the
  root; a file that names something outside the project should find nothing and say so.
- **One meaning for `/`** — model files' absolute paths are another machine's and UI documents' are project-rooted;
  both meanings are established, so the option names which one a caller wants.

## Consequences

**Positive**
- glTF, OBJ/MTL, model textures and UI stylesheets agree on what a relative path names.

**Negative / costs** (behaviour changed on purpose)
- glTF: `../..` above the project, `/abs/…` and `C:/…` URIs now find nothing (the load fails with "isn't in the
  project", as for any missing buffer); the glTF specification only allows relative URIs anyway.
- UI documents: a `url(../…)` above the project is left out with an "isn't a valid …" warning instead of naming a file
  at the root; `/a/../b` now folds to `b`.

## Deprecates

`models.ts`'s private `resolveRelative`, glTF's inline resolver and `sourceText.resolvePath`: removed. The cascade
resolves through `documentAssetRef`, which calls `resolveRelative`.

## As built

`src/engine/core/projectPath.ts` (tested in `projectPath.test.ts`); callers `scene/gltf.ts`, `scene/models.ts`,
`ui/document/cascade.ts`. Through the loaders: `tests/gltf.test.ts` ("finds no file above the project folder…") and
`tests/uiPaint.test.ts` ("leaves out a url() that climbs above the project"). The tilemaps importers' `resolvePath`
(`plugins/tilemaps/editor/import/shared.ts`) resolves against the source file's location on disk, outside the
project, and stays its own.
