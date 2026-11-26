# Audio takes

A **take** is one recording of a game run for the audio designer. It holds two things in one `.sporesample` file: **what the game asked of audio** (every `Audio.play`, parameter change, position, release, stop, stinger trigger and marker, with their times) and **the engine's profile** of how it played (the same data a [capture](audio-profiler.md) holds). The Studio replays a take's requests against your *current* project, so you hear your edits in the situation the game was in. A capture (`.sporesample`) records only the profile; use one when you only want to see how the engine behaved.

A take records no sound. It is small: a ten-minute take is a few MB. The requests are never dropped; the profile keeps the capture's bounded ring, so a long run's oldest profile data is dropped (and marked) while its requests stay.

**Pictures.** A take also keeps a small picture of the game view about once a second (a 320-pixel-wide JPEG, roughly 10 to 20 KB each), taken after the frame is drawn and encoded in the background, so the Take screen can show what was on screen. Pictures are on by default; a game build turns them off by clearing **Include pictures of the game view in takes** in Build / Export, with `npm run export -- <dir> --audio-take --no-take-pictures`, or with `game.json` `audioTakeFrames: false` beside `audioTake: true`. A World with no canvas (headless) records no pictures.

## Recording a take in the Audio Studio

The editor's Play toolbar no longer records (ADR 0416); takes are recorded in the Studio.

1. Run a debug build of your game and connect the Studio to it (the status bar's builds menu, see [The debug link](debug-link.md)).
2. Press **Record session** in the Studio's player bar. Press it again to stop: the take is written into the project's `recordings/` folder. The Take screen shows it as it records, and it stays open on Take and the Profiler once the build disconnects.
3. F10 in the game, or its script, starts and stops a take the same way while the Studio is connected; the Studio saves it.

**Record** on the Profiler screen records a capture of the Studio's own audio (into `recordings/`).

## Recording from an exported game

Export with the **Audio take** option (the checkbox in Build / Export, `npm run export -- <dir> --audio-take`, or `game.json` `audioTake: true`). In that game **F10** starts a take and the next F10 stops and saves it; a toast says "Recording a take…" and then where it went. There is no touch gesture for takes (three fingers belong to the capture trigger, F9). On the web the take downloads. On desktop and Android it's saved as a plain `<name>.sporesample` in the app's data folder, under `recordings/`, keeping the newest 16 auto-named takes. On Windows that's `%APPDATA%\<app identifier>\takes\`. Drop the file on Biosonic's launcher to add it to **Recorded takes**, or copy it into your project's `recordings/` folder.

## `Audio.take`

The same recorder from a script:

```ts
await Audio.take.start();          // loads the recorder (a separate chunk), then records; rejects if the audio core isn't available
Audio.take.mark("boss phase 2");   // a marker on the take's timeline and its profile; no-op while not recording
// ...play...
Audio.take.stop();
const where = await Audio.take.save("boss-fight");   // "boss-fight.sporesample"; a file name on the web, a path in the app
```

| Member | Type | Meaning |
| --- | --- | --- |
| `state` | `AudioTakeState` | `"idle"`, `"loading"` (the recorder is loading), `"recording"` or `"stopped"` (a take exists to save) |
| `seconds` | `number` | Seconds recorded (the running take's, else the last one's); 0 while idle |
| `start()` | `Promise<void>` | Load the recorder and begin a take, with a capture of the profile beside it. A second call while recording does nothing |
| `stop()` | `void` | End the take. It is kept for `save()` until the next `start()` |
| `mark(text)` | `void` | A marker at now, in the take and in its profile |
| `save(name?)` | `Promise<string>` | Compress and save the take, stopping a running one first. Rejects with "nothing recorded: call Audio.take.start() first" when there is no take |

`save` names files as `Audio.capture.save` does, with `.sporesample`: letters, digits, `.`, `_` and `-` kept, 64 characters at most; without a name the file is `take-YYYYMMDD-HHMMSS.sporesample`. A take stops by itself when Play stops or when it would pass the take cap (256 MiB of records), with a message; what it holds can still be saved.

## Opening a take

- **Without a project (ADR 0408):** Biosonic's **Recorded takes** lists your projects' takes (badge **Project**) and takes outside any project (badge **Recording**). Those are the takes in the Studio's takes folder and any `.sporesample` you drop on the launcher. Each row's **⋯** menu shows the file's path and has **Open Folder Location**. A take outside a project opens in a *takes folder*: the Studio's Take and Profiler screens over the folder that holds it, with no project audio. You can look at its timeline, requests and notes, but replay is silent.
- **Replaying without the project (ADR 0410):** with **Download the build's audio for replays** on in the Connect dialog (the default), connecting downloads the build's audio into the takes folder's hidden `.build-audio/` folder: its `audio.json`, playlists and other JSON files, its loose sounds and its audio packages. Only what changed downloads again. A take from that build, opened without its project, then replays with the game's own sounds, and **Profile this replay** works. Turn the option off and the dialog warns that replays will be silent unless the take is moved into the project and opened there.
- **While connected (ADR 0411):** both screens are live. The Profiler follows the game's live capture on every screen. **Record session** in the player bar records a take on the game (press it again to stop and save), and the Take screen shows it growing as it records. The badge beside it says **Linked to game**, and **Disconnected** once the link ends. Saved recordings open after you disconnect. The Connect dialog sets where recordings go (with no project open) and how wide the take's pictures are (320 to 1280 px).
- **One recording, both screens:** opening a `.sporesample` on Take or the Profiler opens it on both, and switching screens keeps it open. The Profiler has the same replay controls as Take. Both timelines zoom with Ctrl/⌘ + wheel or a pinch, scroll with Shift + wheel or a sideways swipe, and have a zoom strip with a scrollbar.
- **Live, from a debug build:** **Connect to Game…** opens the Studio on the Profiler, following the build's live capture straight away. With no project open, it opens the takes folder, and the Take screen's **Start take**, **Mark**, **Stop** and **Save take** write takes there. The Live session section and the Take screen show the folder, with **Change…** to pick another (by default `<Studio app data>/takes`). With a project open, takes from a build go into the project's `recordings/`. While the Studio is connected it owns the build's takes. F10 in the game, or the game's script, only starts and stops a take, and the Studio saves it as soon as the game stops it. On desktop and Android the game also keeps a backup copy in its own app data `recordings/` folder, in case the stream is interrupted ("Take sent to the Audio Studio (a copy is kept in app data)"). That copy counts toward the newest-16 rotation. The Studio in a browser has no takes folder, so **Save take** asks where to save each take, and a take the game stops waits for you to press Save.
- **In the Studio:** the Take screen opens the takes in your project's `recordings/` folder and replays their requests against the current project. The take records the state of the World's pick generator when it began and at each one-second keyframe; replay restarts the Studio's generator from it at the start and at every seek, so random picks (Queue picks, volume and pitch randomness, playback chance) come out as the game's did while the playlists they pick from are unchanged. A take recorded without `audio.seed` has unseeded picks and can't be matched. The picture lane shows the game view (click a picture to move there), and with nothing selected the Inspector shows the picture at the playhead. Edits apply to instances that start after them; you can restart the ones already playing. Notes you add are kept beside the take (`<take>.notes.json`); the take file itself never changes.
- **One file for takes and captures (ADR 0409):** every recording is a `.sporesample` in `recordings/`. A take holds the engine's profile beside what the game asked of audio, so **Show profile** on the Take screen opens that profile on the Profiler at the playhead. A capture recorded with the Profiler's Record has no take data, and the Take screen says "No take data in this capture" with **Open in Profiler**.
- **At the playhead:** with nothing selected, the Inspector shows the game view (click it to see it larger), the take time and the time of day in the game, what was sounding (click one to select it), how many instances had started, the markers either side (click to jump), the game values, and where the take was recorded.
- **Profiling a replay:** **Profile this replay** on the Take screen (or Record on the Profiler while a take replays) records the Studio's own runtime. That capture names the take it replayed (its path and the `audio.json` hash it was recorded against); the Profiler shows "Replay of …" with **Open in Take**.
- **In the editor's Audio Profiler:** press **Open** or drop the file on the panel. The Profiler reads a take's profile as it reads a capture (the requests are skipped) and shows its pictures on a **Picture** track above the others (a click there moves the cursor); takes may be larger than captures, up to the take cap.

## What a take reveals

Everything a capture reveals (the project's name, its `audio` section, and the names of clips, buses, playlists, parameters and snapshots the game used), plus the requests: which sounds the game played, when, where, and with which parameter values, and any marker text. Treat a take like a source file when you share it.

## See also

- [Audio profiler](audio-profiler.md) for captures and the Profiler panel
- [Audio mix: API reference](audio-mix-api.md)
- [ADR 0348](../../decisions/0348-takes-record-what-the-game-asked-of-audio-and-replay-it-profiler-captures-stay-telemetry.md)
