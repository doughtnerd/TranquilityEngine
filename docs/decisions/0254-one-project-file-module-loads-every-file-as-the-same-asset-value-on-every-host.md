# 0254. One project-file module decides which files are project files and loads each as the same asset value on every host

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0013 (assets by path; amended), 0030 (scripts read apart), 0041 (game builds), 0077 (UI documents as text), 0106 (shader code files), 0111 (`.cube` LUTs; amended), 0236 (one launch)

## Context

`AssetSource.get` returns `unknown`, and each host decided on its own what a file loads as:

| file | editor (play) | player (build) | dedicated server / `npm run export` |
|---|---|---|---|
| `.json` | parsed | parsed | parsed |
| `.txt` `.md` `.js` | text | URL (`.js`: text) | `file:` URL |
| `.wgsl` `.glsl` | text | text | `file:` URL |
| `.xml` `.css` | text | text | text |

Each had its own regex (`src/editor/projects.ts` with `isTextAsset` in `projectPaths.ts`; `src/editor/samples.ts`; `src/player/main.ts`; `src/server/project.ts`, which export reads through), and the skipped-folder list was written three times (`projects.ts`, `server/project.ts`, `export/webBuild.ts`). The editor listed only files with a known binary extension or a text extension, while the server and export took every file. So `Assets.get("data/intro.txt")` gave the contents in play mode and a URL in a build; in the editor `Assets.text()` called `Assets.url()` on a text asset (its contents) and fetched them as a URL. Readers guessed the shape: `readAsset` in `materialResolution.ts` took any string as text, and the Custom Function node (`shaderGraph/compile.ts`) also probed a `.default` member.

## Decision

We will put the project-file rules in one engine module, `src/engine/scene/projectFiles.ts`, beside `Assets`, and make the typed reads on `Assets` answer by file kind.

- **Which files are project files:** `isProjectFile(path)` — no part hidden (a leading dot, as the editor's `.myco/`), not inside a skipped folder (`node_modules`, `dist`, `target`, `test-results`, `playwright-report`; `skipsFolder(name)`), and not TypeScript source (`.ts`, `.tsx`; scripts are read and compiled apart, ADR 0030). Every other file is one, whatever its extension, so the editor now lists files of kinds it doesn't know (served by URL), as the server and export always did.
- **What each loads as:** `projectFileKind(path)` — `json` for `.json` (parsed), `text` for `js mjs cjs mts cts md txt xml css wgsl glsl` (the contents), `url` for everything else (a URL serving the bytes). The value an `AssetSource` holds for a path follows its kind.
- **Hosts keep only their I/O:** `loadProjectFiles(paths, { readText, url })` loads a list of project files as asset values (`values`, the JSON and text files' `texts`, and JSON `problems`). The editor's folder reader passes the platform FileSystem (blob URLs), the sample reader and the player `fetch`, the server `node:fs` (`file:` URLs). Each host reports bad JSON its own way (the editor warns and skips; the sample reader, the player and the server fail).
- **Typed reads:** `Assets.json(path)` (json files), `Assets.text(path): string` (text files, now synchronous), `Assets.url(path)` (url files) each check the kind and throw a message naming the right read otherwise; `Assets.bytes(path)` fetches a url file's bytes (a `.cube` LUT, read as text by its loader). `Assets.get` stays as the raw value, for comparing what a file held. `Assets.fromGlob` expects text files globbed with `query: "?raw"`.
- **Export:** a file is copied into a build when it is a project file, not an editor-only root file (`tsconfig.json`, `jsconfig.json`, `sample.json`), and not a TypeScript tool module (`.mts`, `.cts`).
- **Readers move to the typed reads:** `readAsset` (materials and shader assets), the Custom Function node, `UIDocument`, the editor's text-file host and UI markup locations read text with `Assets.text` after checking the kind; the LUT loader reads `Assets.bytes`. The Code panel's `isTextAsset` is "kind isn't url"; its language map stays in `projectPaths.ts`.

## Alternatives considered

- **A tagged value (`{ kind, value }`) from `AssetSource.get`** — the kind would travel with the value, but every source, `fromObject` in over a hundred tests and Vite globs would change shape. The kind is a pure function of the path, so the path is enough.
- **Keep the editor's extension whitelist and have the server and export adopt it** — builds would silently drop data files of unlisted kinds that a game reads by URL.
- **Keep `Assets.text` asynchronous, fetching url files** — the readers that need text (shaders, UI documents) are synchronous, and a sync and an async read under one name is the guessing this removes. Awaiting the new synchronous `Assets.text` still works.

## Consequences

**Positive**
- Play mode, game builds and the dedicated server load every file the same way; `data/intro.txt` is text everywhere.
- One place per rule: adding a text kind or a skipped folder is one line, with one table test (`engine/tests/projectFiles.test.ts`) and a test per host adapter.
- Readers stop guessing the value's shape; a wrong read says which read to use.

**Negative / costs**
- `Assets.text` on a `.cube` or `.obj` now throws (read `Assets.bytes`); `Assets.url` on a JSON or text file throws (it never had a URL in the editor).
- The editor reads files of unknown kinds into blob URLs when a project opens (memory for large stray files such as `.psd`), and shows them in the Assets panel.
- The player fetches `.txt`, `.md` and other text files at start-up instead of on demand.

## Deprecates

- The per-host regexes in `src/player/main.ts`, `src/server/project.ts`, `src/editor/samples.ts` and `projects.ts` (`BINARY_EXTENSIONS`, `isAssetFile`), the three `SKIP_DIRS` copies and the `TEXT_LANGUAGES` set in `projectPaths.ts`: removed.
- `Assets.text`'s URL cache (`textCache`) and its fetch of text assets: removed. The `.default` tolerance in `Assets.url` and the Custom Function node: removed.

## Open questions

- The samples manifest (`vite.shared.ts`, Node build tooling) keeps its own small skip rule for what ships beside the editor.

## References

- `src/engine/scene/projectFiles.ts`, `src/engine/scene/Assets.ts`, `src/engine/tests/projectFiles.test.ts`, `src/server/sidecars.test.ts`, `src/editor/codeFiles.test.ts`
- Architecture review 2 (2026-11-20), card 1
