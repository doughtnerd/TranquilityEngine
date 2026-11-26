# 0410. The Studio downloads a connected build's audio, so takes replay without the project

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0403 (the debug link), 0408 (takes without a project), 0409 (`.sporesample`), 0351 (audio packages), 0348 (takes)

## Context

A take opened without its project (ADR 0408) replays against no audio, so it's silent. A sound designer on another machine, the second workflow 0408 names, has the running build but not the project. The build already has everything a replay needs: `audio.json`, the playlists and the other JSON files, the sounds as it ships them, and its audio packages.

## Decision

1. **The build lists and sends its audio over the audio topic.**
   - The request `build.audio` makes an index upload. The index is JSON: the project's name, the build's `audioHash` (the hash a take records, from `currentAudioHash`), the build's media table (`game.json`'s `audio`, or null), and its files.
   - The files are every JSON project file, every sound file (by extension) the build serves loose, and every package and streamed media file the media table names.
   - Each file has a kind (`project`: a project path; `build`: a build path such as `audio/packages/Core.mycopak`) and, for JSON, an FNV-1a hash of its text.
   - The request `build.file` `{ kind, path }` makes an upload of that one file's bytes.
   - Both uploads go through the take upload's chunked subscription (`upload`), with their own id range.
2. **The Studio downloads it on connect.** It does this when the Connect dialog's **Download the build's audio for replays** option is on, which is the default (`myco.studio.downloadBuildAudio`). Turning it off warns that replays will be silent unless the take is moved into the project and opened there.
3. **Where the downloaded audio lives.** Each download is a *build audio set* in the takes folder: `.build-audio/<project>-<audioHash>/`. It holds `project/<path>` and `build/<path>` files and a `set.json` (the index, written last, so a set without it is incomplete).
   - A file already in the set is skipped, unless the index gives a JSON file a different hash.
   - On the desktop the takes folder is the user's (ADR 0408). In a browser it's the live session's in-memory folder, so the audio lasts for the session.
   - The status line shows progress.
4. **A take opened in a takes folder mounts the matching set.** The match is on the take's project name and `audioHash`, and works the way the player loads a build:
   - the set's JSON files become an asset source over the workspace's, and its sounds and build files become blob URLs;
   - the media table is installed with the set's build files;
   - the Studio's audio runtime opens on the set's `project.json` and `audio.json`.
   - Closing the take or opening another releases the mount. With a set mounted, Profile this replay is offered.

## Alternatives considered

- **Stream each sound on demand during a replay.** Rejected: a replay seeks and plays many sounds at once, the link adds latency, and the take couldn't replay once the build had gone.
- **Send only the project's source audio files.** Rejected: a build ships converted and packaged sounds, not its sources. Sending what the build actually plays reproduces the game exactly.
- **Key sets by a hash of every file.** Rejected for now: a take records only `audioHash` (the mix settings). A set is matched by project name and `audioHash`, and its JSON is refreshed by hash on each connect.

## Consequences

**Positive**
- A take recorded from a build replays, with sound, on a machine that has no project.

**Negative / costs**
- The first connect to a build downloads all its audio (packages included). That can take a while for a large game, and it uses disk space in the takes folder.
- Two builds with the same project name and mix settings but different sounds share a set. The newer download replaces changed JSON, but a changed sound with the same path is kept as first downloaded.
- In a browser the audio is held in memory for the session.

## Deprecates

Nothing.

## Open questions

- Pruning old build audio sets.

## References

- `src/plugins/audio/runtime/debugLink/buildAudio.ts`, `src/studio/runtime/buildAudioSets.ts`.
