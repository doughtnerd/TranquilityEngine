# 0411. A connected Studio is live, and one recording shows on Take and the Profiler alike

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** parts of 0408 (Follow build as a choice, the Game session pill) and 0410 (downloading with a project open)
- **Related:** 0348, 0403, 0408, 0409, 0410

## Context

After 0408 to 0410 the owner tested the Studio against a running game. Several things got in the way:
- Take and the Profiler each opened recordings separately.
- The Profiler's live feed stopped when its screen was left, and it replaced files opened there.
- The player bar's Game session pill replayed takes instead of recording the game.
- The build's audio was downloaded even with the project open.
- Take pictures were fixed at 320 px.
- Without a project, Playlists and the Mixer stayed off even though the build's audio was there.

## Decision

1. **Live while connected.** While a game build is connected, both screens show it live, and a saved recording can't be opened until it disconnects (the status line says so).
   - The Profiler follows the build's live capture on every screen, from connect to disconnect (`installProfilerLive`). If the feed ends, it offers Rejoin; there is no Stop following.
   - The Take screen shows the take recording on the build as it grows. Between recordings it shows the last one, and with none it asks for Record session.
2. **The live take feed.** The audio topic adds the `takeLive` subscription. It sends a start record (META facts), the take recorder's log as pieces (requests, keyframes, pictures, in capture framing), emitter names, and an end record. The Studio's `liveTake` rebuilds a reader `Take` from these, a few times a second. It plays nothing.
3. **Record session.** The player bar's Game session pill becomes Record session. It works only while a build is connected: a press records a take on the build, and the next stops and saves it where the Studio keeps recordings (0408). The badge beside it says Linked to game while linked, and turns into a grey Disconnected once the link ends.
4. **One recording for both screens.** Opening a `.sporesample` in either screen opens it in both: the Profiler reads its profile, and the Take screen replays its take or says it has no take data. Switching screens keeps it open. The Profiler gets the Take screen's replay controls (go to start, replay, loop, restart instances), which are inactive while a recording runs.
5. **Take picture width.** The Connect dialog sets the take pictures' width: 320, 640 (the default), 960 or 1280 px (`myco.studio.takePictureWidth`). The Studio sends it to the build with the audio topic's `take.frames` request on connect and on change, and the next take uses it. A picture that encodes too large is dropped, and the following ones are taken narrower.
6. **The Connect dialog shows where recordings go.** With no project open it shows the takes folder, with Change… and Use default.
7. **The build's audio as a read-only project.** A takes folder with a build audio set mounted also offers Playlists and the Mixer. They show that audio read-only through `audioProject`: the open project normally, or in a takes folder the mounted set as a `readOnlyProject`.
   - The set mounts when a take opens (0410), and also as soon as the connected build's download finishes.
   - The Inspector's Open playlist and the Open in Mixer buttons go there.
   - With no set mounted, they say what's missing.
8. **No download with a project open.** Its takes replay against its own audio.

## Alternatives considered

- **Let an opened file replace the live view, with a Back to live control.** Rejected by the owner: while connected, live always wins.
- **Stream the take live even when nothing records.** Rejected by the owner: the Take timeline grows only while recording.
- **Merge the build's audio files into the takes folder's own project.** Rejected: a project is read-only or writable as a whole. The takes folder must stay writable for notes and recordings, while the build's audio must stay read-only.

## Consequences

**Positive**
- Recording, watching and reviewing a game run needs no screen-hopping. A recording opened once is on both screens.

**Negative / costs**
- A saved recording can't be reviewed while a game stays connected.
- The live Take view has no Inspector values yet. Selecting an instance in it shows nothing until the take is opened after disconnecting.

## Deprecates

Follow build / Stop following, the Game session pill's replay control, and Profile this replay (removed from the Take toolbar).

## Open questions

- Inspector values for the live take.

## References

- `src/plugins/audio/runtime/debugLink/takeLive.ts`, `takeLiveStream.ts`; `src/studio/runtime/liveTake.ts`, `takePictures.ts`; `src/studio/shell/audioProject.ts`, `GameSessionSlot.tsx`; `src/studio/screens/profiler/index.tsx` (`installProfilerLive`).
