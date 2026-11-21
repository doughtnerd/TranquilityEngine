# 0296. One web-build writer, behind a build-folder seam, writes every game build

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0041 (amended), 0090 (amended), 0119 (amended), 0031, 0038

## Context

A game build (0041) is planned once (`planWebBuild` in `src/export/webBuild.ts`), but written by two hand-run copies of the same pipeline: the Node exporter (`src/export/node.ts`: `exportProject`, `prepareOutput`, `writeWebBuild`) and the editor's Build / Export (`src/editor/exportBuild.ts`: `planProjectBuild`, `exportProjectBuild`). Each ran plan → bake models (0090) → process images (0119) → check the player's `files.json` → clear an earlier build → write the player (`player.html` as `index.html`), the copies, the generated files and the binaries.

- **The order rule lived in both.** `processImages` puts a processed image in `binaries` at the copy's own path; both writers wrote the copies first and the binaries after, so the processed file landed over the original. Correct only because both kept the order, and each processed image was written twice (the editor also fetched its original twice: once to process it, once to copy it).
- **They had drifted.** Node cleared the output folder before reading the player, and checked only that the default player's `files.json` existed (a `playerDir` passed in was never checked): a broken player cost the user their earlier build. The editor checked first.
- **File lists differed.** The editor planned over `project.files ∪ project.scripts.keys()`, Node over `project.files`. `planWebBuild` copies only exported files and scripts never are (0254), so the union changed nothing: `project.files` is right.
- `planProjectBuild(project, bake = true)` had one caller, passing `true`.

## Decision

We will write every web build through one module, the **build writer** (`src/export/buildWriter.ts`, `writeWebBuild(plan, options)`), over two small interfaces:

- **`FileSource`** (`read(path) → string | Uint8Array`): the project's files and the built player. Node reads through fs (bytes); the editor answers with the text it holds or the bytes behind the asset URL, and fetches the player from `player/` beside it.
- **`BuildFolder`** (`where`, `exists`, `list`, `remove`, `writeText`, `writeBytes`, by `/`-separated path relative to the folder, `""` for the folder itself), with two adapters: Node's fs (`nodeFolder`, private to `node.ts`) and the platform `FileSystem` (`fileSystemFolder`, in the writer, used by the editor). This is a real seam: two adapters in production, the in-memory `MemoryFileSystem` in tests.

The writer owns, in this order:

1. **The player check**, before anything is touched: `files.json` must parse and list `player.html` and `myco.js`, wherever the player came from.
2. **The folder check**: empty, missing, or holding an earlier build (`<web>/game.json`); anything else is refused, still before baking or reading a project file.
3. **Bake models and process images** for the build's platform, through the project `FileSource`.
4. **Clear the earlier build**, keeping the paths in `keep` (a desktop package keeps `src-tauri/target`, the Rust build cache).
5. **Write each file once**: a copy whose build path the plan also writes as a binary or generated file (a processed image, its resized sidecar) is skipped, not written over. Progress counts each file once.

`web` places the web build inside the folder (`""`, or `"web"` for a desktop package, 0041); the Node exporter writes the Tauri project and `README.txt` through the same `BuildFolder` afterwards. The output-inside-project check and planning stay with each caller (they read projects differently). `planProjectBuild` and its dead `bake` parameter are gone; the editor plans over `project.files`.

## Alternatives considered

- **Keep two writers and share only a helper for the order rule** — leaves the player-check drift possible and the duplicated tests; the order isn't the only rule they share.
- **Have Node use the platform `FileSystem` (a Node implementation of it)** — `FileSystem` is wider than a build needs (rename, watch, pickers) and has no Node implementation; a six-method folder interface is cheaper to adapt and to fake.
- **Let `processImages` write the file itself** — it would need the folder and the writer's ordering, mixing planning with writing; it stays a pure planner returning a plan.

## Consequences

**Positive**
- Locality: the order and override rule, the player check and the clearing rule are written once.
- A broken player no longer costs the earlier build in the command-line export; a `playerDir` passed in is checked too.
- Each processed image is fetched once and written once; progress totals are exact.
- One test suite (`src/export/buildWriter.test.ts`) on an in-memory folder covers both callers; the Node and editor suites keep only their adapters' wiring.

**Negative / costs**
- A third small interface (`FileSource`) beside `ProcessImagesOptions`' callbacks; the writer adapts one to the other.
- The editor's "no player" message is now the writer's generic one (it names `player/ beside the editor` and `npm run build:player`, not the command-line export).

## Deprecates

`writeWebBuild`/`prepareOutput`/`copy` in `node.ts`, `planProjectBuild`/`playerFiles` and the hand-written write loops in `exportBuild.ts` (removed). The overlapping output-folder tests in `export.test.ts` and `exportBuild.test.ts` moved to the writer's suite.

## Open questions

None.

## References

- `src/export/buildWriter.ts`, `src/export/buildWriter.test.ts`; callers `src/export/node.ts`, `src/editor/exportBuild.ts`.
- Architecture review 2026-11-21, card 3 and small fixes 3 and 7.
