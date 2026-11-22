# 0324. One OS drop controller decides a drop; the browser and the desktop are adapters

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0085, 0046, 0228

## Context

0085 accepts files dropped from the OS on the Assets panel. `src/editor/osDrop.ts` wrote the drop twice inline, once for the browser's HTML5 drag events and once for Tauri's webview drag-drop event: the drag phase, the folder under the pointer, resetting the hover signals (`osDragOver`, `osDragFolder`), the refusal check and its status text. `whyNotImportable` was asked three times with two different conditions (the browser's, the desktop's `!project?.fileSystem`, and again inside `importFiles`). The copies had drifted: the browser showed a refused drop (`dropEffect = "none"`), the desktop's enter and over never asked; the desktop tested "in the panel" twice. `installOsDrop` was the module's only interface, so none of it was tested and the desktop path was unverified (implementation status, 0085).

## Decision

We will decide a drop in one module, the **OS drop controller** (`src/editor/osDropController.ts`), and translate each platform's events into its three phases in an **adapter**.

- **Controller** (`createOsDropController()`): `over(at)` (files dragged over the element `at`: returns `outside`, `accepted` or `refused`, and sets the hover state), `left(to)` (the drag left for `to`, null for out of the window or cancelled; moving within the panel keeps it) and `dropped(at, read)` (returns a `DropOutcome`: `outside`, `refused` with the reason, or `importing` with the target folder and the import's promise). It alone decides: whether `at` is in the Assets panel, the target folder (the `data-drop-folder` element under the pointer, else the folder showing), the refusal (`whyNotImportable`, asked once per phase, with its status text) and the import. `read(fs)` is called synchronously inside `dropped` and only when the drop is accepted, so a browser's DataTransfer items are still there.
- **Hover state:** one signal, `osDrag: { folder, refused } | null`, replaces `osDragOver` and `osDragFolder`. A refused drag outlines the panel in `--danger` and highlights no folder, in the browser and on the desktop alike.
- **Adapters:** `listenBrowserDrops(window, controller)` (an element target and a DataTransfer; sets `dropEffect` from `over`, prevents the default for any drop the panel owns, refused included) and `listenDesktopDrops(source, view, controller)` (a Tauri-shaped `onDragDropEvent` source: the physical position divided by `view.devicePixelRatio` and looked up with `view.elementFromPoint`; absolute paths read with `filesOfPaths` through the project's file system). `installOsDrop` (`osDrop.ts`) only wires the window, the document and, in Tauri, the current webview.
- **One refusal rule:** `whyNotImportable` refuses a project that can't save or has no file system (importing writes the folder through it), so the desktop's extra condition is gone. `importFiles` no longer asks it again: its callers (the controller) do, and a write to a read-only project fails per file into `failed`, so it stays safe for any other caller.

## Alternatives considered

- **Keep `osDrop.ts` and share helpers between the two handlers** — the phases, ordering and reset rules would still be written twice, and still be untestable behind `installOsDrop`.
- **Let each adapter build `IncomingFile`s first and pass them to `dropped`** — the desktop would read files before the refusal is known, and the browser must read DataTransfer items synchronously anyway; passing a `read` the controller calls once keeps both right.

## Consequences

**Positive**
- The drop rules live in one place; the desktop shows a refused drop like the browser.
- The controller and both adapters are tested through their interfaces with fake browser and Tauri sources (`osDropController.test.ts`), including the device-pixel scaling.

**Negative / costs**
- A real Tauri window is still not exercised by an automated test; the adapter is tested against Tauri's event shape only.

## Deprecates

`osDragOver` and `osDragFolder` (replaced by `osDrag`), the inline handlers in `osDrop.ts`, and the refusal check inside `importFiles`. Removed.

## Open questions

None.

## References

`src/editor/osDropController.ts`, `src/editor/osDrop.ts`, `src/editor/assetImportFiles.ts`, `src/editor/ui/Assets.tsx`; tests `src/editor/osDropController.test.ts`, `src/editor/assetImportFiles.test.ts`.
