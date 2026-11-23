# 0380. The desktop app opens on a Foxfire launcher that leads to each app's projects screen

- **Status:** Proposed
- **Date:** 2026-11-23
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0059 (the Projects window's look, size and first screen), 0341 (the Audio Studio's start screen)
- **Related:** 0037, 0082, 0348, 0376

## Context

The desktop app opened on the Projects window (ADR 0059): a fixed 610 px card with the editor's start screen. The Audio Studio (ADR 0341), which will be named **Biosonic**, could only be reached from inside the editor (Window > Audio Studio) or from its own standalone app (`src-studio-tauri`), whose no-project screen was the editor's start screen with a title over it.

The owner's design (the "Foxfire Launcher" canvas, three artboards) replaces this with a launcher for the studio's applications:

1. **Foxfire Studios** (Launcher): the studio logo, a What's new card, resources, and one card per application (Myco Engine, Biosonic), each with Open.
2. **Myco Engine · Projects**: the Myco logo and tagline beside a Projects tab (New Project…, Add from Folder…, search, Continue where you left off, All projects) and a Samples tab.
3. **Biosonic · Projects**: the Biosonic logo beside a Live session bar (Connect to Game…), a Projects tab like Myco's and a Recorded takes tab (the latest take, all takes).

## Decision

**One launcher page, three stages.** `projects.html` (the window labelled `projects`) shows the Foxfire stage first. Open on an application card moves the same page to that application's projects stage; its "‹ Foxfire launcher" link goes back. The stages are views in one page, not windows, so moving between them is instant and nothing reloads.

- **The window** is 1280 × 818 (logical), resizable down to 720 × 560, still borderless, with Minimise, Maximise and Close laid over the top right; the brand column drags it. On a small screen it is fitted to the work area at start (`windowSize.ts`). The layouts are fluid and stack at narrow widths, as the design's artboards do.
- **Myco Engine** keeps ADR 0059's hand-off unchanged: the editor window is still created hidden once the launcher shows (ADR 0082), the project is resolved in the launcher (`launcherActions`) and handed over, and the launcher hides.
- **Biosonic** goes through the Studio window's existing hand-off (`create_studio_window`, `myco://studio-open`, ADR 0341): the launcher resolves the project the same way (a folder picked, a new project scaffolded, a recent one checked) and hands the Studio `{ project: root }`; Open Take adds the take as the asset, so the Studio opens on the Take screen.
- **The start actions** (`startActions()`, which the New Project dialog also uses) are set for the stage on show: the editor's for Myco, the Studio's for Biosonic.
- **Windows (Rust):** when the Studio window closes while the editor window isn't showing, the launcher shows again. Closing the launcher while neither the editor nor the Studio shows quits, as before.

**Each application owns its projects screen.**

- `src/editor/ui/appProjects/` holds the pieces both screens share: the brand column, the tab strip, and the Projects tab over the recent projects list (`recentProjects()`, shared by both apps), with search, the most recent project as Continue where you left off, and a ⋯ menu per row (Remove from list; Edit location note for browser folders).
- `MycoProjectsScreen` adds the Samples tab (the samples beside the editor: Open, Make a Copy…).
- `src/studio/start/BiosonicProjectsScreen` adds the Live session bar and the Recorded takes tab. The takes are listed from the recent desktop project folders' `takes/` (`recentTakes.ts`), each read for its length and start time; the take reader is imported on demand so the launcher still loads no engine code.
- **Opening Biosonic from the editor opens the editor's project** (Window > Audio Studio, Open in Audio Studio): a folder by its path, as before, and now a sample the editor has open by its id (`StudioOpenRequest.sample`, `?sample=` in a browser), so the Studio never shows its projects screen while the editor has a project.
- **The Studio's own no-project screen is the Biosonic projects screen** (the standalone app and `studio.html` in a browser), without the back link. The browser editor keeps its start screen over the editor (ADR 0031, 0038) for now.
- **Live session** is a placeholder: Connect to Game… is disabled until the live connection (the debug link's Studio side, ADR 0376) is wired to it. The What's new card and the Resources links are placeholders until there is a release feed.

**Branding.** The design's art is committed as masters in `branding/` (`foxfire-studios-splash.webp`, `myco-engine-splash.webp`, `biosonic-logo.webp`) and resized for the UI into `src/editor/ui/brand/`. The Biosonic screens use the Biosonic name; the rest of the Studio (its window titles, header, messages) keeps "Audio Studio" until the rename.

## Alternatives considered

- **A window per stage** (a launcher window that opens a Myco or Biosonic projects window). Each window would load the theme and fonts again, and going back would mean another window to keep in step with the editor's (ADR 0059 "two windows to keep in step").
- **The Studio keeps the editor's start screen.** Less to build, but the design gives Biosonic its own screen, and the standalone app would then show a different screen from the launcher's Biosonic stage.
- **The browser editor gets the Myco projects screen too.** It is a full-page layout, while the browser's start screen lies over the editor as a dialog that many specs drive. Left for a later change.

## Consequences

**Positive**
- One way into both applications on the desktop; the standalone Studio and the launcher's Biosonic stage are the same screen.
- Takes can be opened straight from the start screen.

**Negative / costs**
- The launcher is bigger than the old card and its window is resizable, so its old fit-to-card sizing is gone.
- Recorded takes reads every listed take (up to 50) when the tab first shows; a project with many large takes makes that tab slower to fill.
- The Studio's no-project screen no longer lists samples; samples open in the Studio by URL (`?sample=`) or from the editor.

## Open questions

- What the What's new card, the Resources links and the version line should come from.
- Whether the browser editor should move to the Myco projects screen.

## References

- `projects.html`, `src/editor/launcher/`, `src/editor/ui/appProjects/`, `src/studio/start/`, `src/studio/shell/StudioApp.tsx`, `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`, `branding/`.
- The owner's design: the "Foxfire Launcher" canvas (Launcher, Myco Engine · Projects, Biosonic · Projects).
