# 0327. The Audio Studio is its own app on the editor's frontend and replaces the editor's audio panels

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** — (retires the editor-side panels of 0158, 0166/0167, 0171/0172, 0220; see Deprecates)
- **Related:** 0003, 0022, 0025, 0027, 0059, 0082, 0083, 0141, 0145, 0157, 0171, 0174, 0219, 0267, 0278, 0316, 0328–0335

## Context

Audio is authored today inside the scene editor: Project Settings > Audio (buses, effects, snapshots, ducking,
parameters), the Event editor and the music panels (`*.audioevent.json`), the Mixer and Profiler panels and the Audio
Debug panel, all in `src/plugins/audio/editor/`. They reach the playing game in-process: Play mode is a second Engine
in the same page and the panels call the `Audio`, `mixer` and `Audio.capture` singletons directly (no IPC exists).

The owner has designed a new audio tool, the **Audio Studio**, as a high-fidelity interactive prototype (the "Audio
Design Studio – Prototype UI v2" canvas: Samples, Playlists with the Sequence view, Mixer, Spatial, Take, Profiler, the
shared Curves window, and a Journeys list of 11 user journeys). It is meant to:

- launch from the editor, but run as **its own app**, so an audio designer can work without opening the scene editor;
- later **connect to a running game build or editor** (live link). The owner has scheduled that for after v1: v1
  works from files (projects, takes and captures on disk);
- be the authority on the audio concepts it introduces, while the engine stays the authority on undo-tree and history
  UX (the prototype's history is a stand-in).

Owner decisions on 2026-11-22: the Studio **replaces** the editor's audio authoring panels; the prototype's data model
wins and existing data is migrated (0329); sample edits live in sidecars (0328); Take and Profiler are separate,
related recordings (0334).

Three findings shape the structure:

- The editor's undo stack is reusable as is: `document/HistoryTree.ts`, `TextHistory.ts`, `textPatch.ts`,
  `historyStore.ts`, `historyPersistence.ts`, `historyLayout.ts`, `ui/undoTree/UndoTree.tsx` are pure; `assetDocuments.ts`
  and `activeHistory.ts` are page singletons that assume one project per page, which a Studio page satisfies.
  `src/editor/stories/editorStory.tsx` already boots asset kinds, plugins and a project outside `editor.html`.
- The dock (`src/editor/layout/`) is what the prototype's docks copy (its comments say "mirrors ADR 0174"), but its
  store is one signal saved under the fixed key `myco.editor.layout`.
- Two processes editing one project would silently overwrite each other: asset documents notice outside changes only
  through the page's own `project.assets`, and the editor watches only `scripts/` and `plugins/`.

## Decision

We will build the Audio Studio as a second app on the editor's frontend, with its own entry page and window, and
retire the editor's audio authoring panels.

**One frontend, a new entry.** `studio.html` and `src/studio/` join `vite.editor.config.ts` beside `editor.html` and
`projects.html`. `src/studio/main.tsx` boots what `editorStory.tsx`'s `withEditor` boots, made real:
`registerCoreAssetKinds()`, the audio plugin's asset kinds, `openFolderProject` over `getFileSystem()` (Tauri) or
`FsaFileSystem` (browser), `useProjectAssets`, `installTheme`. Its start screen reuses `projectOpening.ts`,
`recentProjects.ts` and `StartProjects.tsx`. The dev server serves `/studio.html`; `?project=` and `?sample=` work as
for the editor.

**Shipped two ways from that one build.**
- *From the editor:* a Studio window of the editor's Tauri app (a `studio` window label created in Rust like
  `create_editor_window`, added to the capability file). The editor's **Window > Audio Studio** and an **Open in Audio
  Studio** action on audio assets open it on the current project, handing the project and the asset over Tauri events
  with the `Bus` from `launcher/handoff.ts` (`myco://studio-open {project, asset?, screen?}`).
- *Standalone:* a second Tauri app, `src-studio-tauri/` (`com.foxfirestudios.myco.studio`), whose window loads the same
  `dist/editor/studio.html`. `npm run tauri:studio:dev` and `npm run tauri:studio:build`. In the browser, `/studio.html`
  opens a folder through the File System Access API like the browser editor (0038).

**The Studio runs its own audio runtime.** It starts a headless Engine with only the audio plugin's runtime (no
renderer, no scene), the same `myco` audio code a game runs, so every audition, the Mixer, Spatial test scenes and take
replay (0334) play through the real engine. It never boots the scene editor. It always uses the Rust core backend,
on every platform including macOS desktop (where games still default to the Babylon fallback until 0157's gate
passes); if the core can't start, the Studio says why instead of running degraded (owner decision 2026-11-22).

**The shell** (`src/studio/shell/`): the six screens of the prototype in three groups, Author (Samples, Playlists), Mix
(Mixer, Spatial), Run (Take, Profiler), switched from the header and with Ctrl/⌘+1…6. Each screen is a dock of panels
using the engine's `DockLayout`, with one fixed panel per screen and Reset layout. The output-device menu with latency
calibration, the player bar ("Layout A", a slot per screen), the status bar and toasts are shell components used by
every screen (0335).

**Undo and history are the engine's.** Every Studio document is an `AssetDocument` (`openAssetDocument`) with its
persistent text-patch history tree (0141, 0267, 0316), so histories land in the same `.myco/asset-history/` files the
editor uses. Undo and Redo go through `activeHistory` (0145) and `shortcuts.ts` routing; the History popover draws
`UndoTree`. The prototype's per-screen linear histories are not built. Edits a user can get refused return the
refused-or-next result and apply through `applyEdit` (0307, 0313).

**Two small engine changes make a second app possible.**
- `layout/store.ts` takes a store key and a default layout per host (`createLayoutStore(key, defaults)`); the editor
  keeps `myco.editor.layout`, each Studio screen gets `myco.studio.layout.<screen>`.
- `HistoryPanel`'s empty and scene wording comes from its host, and the pure history modules are imported by leaf path
  (not through the `document/index.ts` barrel, which pulls in the scene loader).

**One app owns each file; both watch.** The Studio owns the audio files (`audio.json`, samples' sidecars,
`*.playlist.json`, `*.audioscene.json`, takes and captures; 0328–0334). The editor stops writing them: its remaining
audio UI (AudioSource, Listener, ReverbZone, Occluder and AudioZone Inspector sections and gizmos) only picks assets.
Both apps watch the project folder (Tauri `fs.watch`; in the browser, a re-read on window focus and before Play) and
feed outside changes to open documents through the existing amend path (0141), so the editor's next Play uses what the
Studio saved and the Studio sees a `git pull`. Each app writes `.myco/locks/<app>.json` (`{app, pid, started}`) while
it has the project open. A Studio move or rename of an asset that scenes or prefabs name rewrites those references
itself when no editor holds the lock; when one does, it writes the moves to `.myco/locks/pending-moves.json`, which the
editor applies to its documents and deletes (one file channel that works for both delivery modes).

**A seam for the live link, unused in v1.** The panels reach audio through host interfaces, as the editor's panels do
today (`AuditionHost`, `MixerPanelDeps`, `LiveHost`, `ProfileSource`). v1 implements them over the Studio's own
runtime. The live link (later record) implements them over a connection to a game or editor, carrying the 0171
"live link on paper" telemetry framing plus a control channel. Until then the player bar's Game session pill is
replaced by the replay of the open take (0334), the "Linked to game" badge is not shown, and Mixer and Spatial
changes are heard through the Studio's runtime (auditions, test scenes, take replay) (owner decision 2026-11-22).

## Alternatives considered

- **Studio screens as editor panels only** — no separate app; the audio designer still boots the scene editor, which
  is what the owner wants to avoid.
- **A separate frontend codebase** — duplicates the undo tree, dock, theme, project opening and every field control;
  the opposite of what the owner asked for.
- **The editor as authority, the Studio forwarding every edit to it** — needs a live channel in v1 and does nothing
  for the standalone app with no editor open.
- **Stable asset ids instead of path rewriting** — would fix renames across apps for good, but changes how every asset
  is referenced (0013, 0040); out of scope here.

## Consequences

**Positive**
- One audio tool, one data model, one set of components; the scene editor shrinks.
- The audio designer opens a project, edits and auditions through the real runtime without the scene editor.
- The same undo tree, history files, dock, theme and project opening as the editor, with no copied code.

**Negative / costs**
- Two Tauri app configs to build, sign and ship; the standalone app is a second installer.
- File watching and the lock and pending-moves files are new editor work, and `fs.watch` is only on Tauri (the browser
  re-reads on focus).
- Until the live link exists, live mixing hears the Studio's runtime replaying a take, not the running game.
- The editor's audio panels, heavily tested and recent (0292, 0307, 0313, 0326), are removed; their pure models are
  reused where they fit (0329–0334 name them).

## Deprecates

- `src/plugins/audio/editor/event/` (Event editor), `music/` (music panels), `mix/MixerPanel.tsx` and
  `mix/ProfilerPanel.tsx` (views), `AudioDebugPanel.tsx`, `AudioSettingsSection.tsx` (Project Settings > Audio): removed
  once the Studio screen that replaces each is built (the plan's milestones say which). Their pure models
  (`mixerPanelModel.ts`, `faderModel.ts`, `meterModel.ts`, `profilerSource.ts`, the track and table kits, `peaks*.ts`,
  `audition/audition.ts`, `parameterList.ts`, `editResult.ts`) move to the Studio or stay shared.
- The `audioEvent` asset kind's editor panel; the kind itself is replaced by `playlist` (0329).
- Kept in the editor: AudioSource, AudioListener, AudioReverbZone, AudioOccluder and AudioZone Inspector sections and
  gizmos, audio import settings, the asset picker.

## Open questions

- Code signing and auto-update for the second app (same as the editor's, not yet decided for either).
- Whether the Projects window (0059) should list both apps.

## References

- Prototype canvas "Audio Design Studio – Prototype UI v2" (Studio, Workflow Trials and Archive pages).
- `docs/design/audio-studio/plan.md` (milestones, gap list, owner decisions).
- `src/editor/stories/editorStory.tsx`, `src/editor/launcher/handoff.ts`, `src/editor/layout/store.ts`,
  `src/editor/assetDocuments.ts`, `src/editor/activeHistory.ts`, `src-tauri/src/lib.rs`.
- `docs/design/0171-audio-mix/goal.md` and `architecture.md` §4.1 (the live link on paper).
