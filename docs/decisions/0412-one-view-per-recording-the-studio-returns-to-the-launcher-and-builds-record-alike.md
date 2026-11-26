# 0412. One view per recording, the Studio returns to the launcher, and a build records alike from F10 or the Studio

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0348, 0349, 0380, 0408, 0411

## Context

The owner tested ADR 0411's round against a desktop build and reported twelve problems:
- Take pictures came out at 320 px whatever the Connect dialog said.
- The game showed no recording notification when the Studio started a take.
- Selecting an instance hid the picture and the playhead facts.
- The live take showed no picture of the game.
- The Take and Profiler timelines didn't move together.
- Closing the takes folder left the user on a second copy of the launcher, which has no way back to the Foxfire apps.
- Takes couldn't be deleted from the launcher.
- Mixer meters fell to silence on pause.
- The dialogs were drawn in styles of their own rather than the kit's (ADR 0349).

## Decision

1. **One view per recording.** The Take and Profiler timelines of one `.sporesample` share their visible span (`components/recordingView.ts`, passed to `useTimelineView`). Zooming, scrolling, or the playhead paging either one moves the other. The review link (0411) already keeps their playheads together.
2. **Pictures at the chosen width.** The build takes pictures at the width asked for (default 640, as in the Studio) and is not limited by the canvas's own width. A picture over the FRAME cap first lowers its JPEG quality, then its width, and steps back up once pictures fit again. The Studio sends `take.frames` right before `take.start` as well as on connect and on change.
3. **The build records alike.** `take.start` and `take.stop` from a tool go through the take trigger (`capture/takeControl.ts`). The game shows the same notifications as F10, and the next F10 stops a take the Studio started.
4. **The Take Inspector keeps the game in view.** Under a selected instance or note, the Inspector still shows the picture and the take at the playhead. Clicking a picture on the Gameplay row clears the selection. While live, the Inspector shows the live take's newest picture, what sounds and the game's values.
5. **Back to the launcher.** In the desktop app, closing the project or the takes folder hides the Studio window, keeping its debug link, and shows the launcher. The launcher stays on Biosonic, with its way back to the Foxfire apps. Without a launcher window, the Studio's own start screen stays.
6. **Delete a take from the launcher.** The ⋯ menu's Delete… asks first, then removes the take file and its notes from disk; it can't be undone.
7. **Meters hold while paused.** The Mixer keeps each bus's last reading while a take replay is paused, and moves again on play.
8. **Kit dialogs only.** The Studio's Debug link settings use `KitDialog` with the editor's settings fields. The Connect dialog's Studio options use the dialog's own field rows, the Studio `Checkbox` and a warning `Chip`. The Build / Export dialog puts each option on its own `dialog-option` row. The Connect dialog is mounted once at the Studio's root, so opening the live session under it keeps what was typed and the build picked from the network.

## Alternatives considered

- **Keep each timeline's own zoom and only link the playheads.** Rejected: the owner asked for the timelines to be synchronized too.
- **Close the Studio window on close.** Rejected: it holds the debug link, and the connection should outlive the screen.
- **Move deleted takes to a trash.** Takes outside a project have no project trash. Delete asks first instead.

## Consequences

**Positive**
- A recording reads the same on both screens, and a build behaves the same whichever side starts a take.

**Negative / costs**
- Deleting a take from the launcher is permanent.
- The meters' hold covers take replay only; the game session has no pause.

## Deprecates

The Studio's own `.studio-link-settings` dialog frame and the Connect dialog's `studio-build-audio*` / `studio-picture-width` classes.

## Open questions

- None.

## References

- `src/studio/components/recordingView.ts`, `useTimelineView.ts`; `src/plugins/audio/runtime/capture/takeFrames.ts`, `takeControl.ts`, `trigger.ts`; `src/studio/screens/take/index.tsx` (`LiveInspector`); `src/studio/main.tsx` (`returnToLauncher`); `src/studio/start/BiosonicProjectsScreen.tsx` (`deleteTake`); `src/studio/screens/mixer/mixerScreen.ts`; `src/studio/debugLink/StudioDebugLink.tsx`; `src/editor/ui/ExportDialog.tsx`.
