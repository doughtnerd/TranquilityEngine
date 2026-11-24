# Audio takes

A **take** is one recording of a game run for the audio designer. It holds two things in one `.mycotake` file: **what the game asked of audio** (every `Audio.play`, parameter change, position, release, stop, stinger trigger and marker, with their times) and **the engine's profile** of how it played (the same data a [capture](audio-profiler.md) holds). The Studio replays a take's requests against your *current* project, so you hear your edits in the situation the game was in. A capture (`.mycap`) records only the profile; use one when you only want to see how the engine behaved.

A take records no sound. It is small: a ten-minute take is a few MB. The requests are never dropped; the profile keeps the capture's bounded ring, so a long run's oldest profile data is dropped (and marked) while its requests stay.

**Pictures.** A take also keeps a small picture of the game view about once a second (a 320-pixel-wide JPEG, roughly 10 to 20 KB each), taken after the frame is drawn and encoded in the background, so the Take screen can show what was on screen. Pictures are on by default; a game build turns them off by clearing **Include pictures of the game view in takes** in Build / Export, with `npm run export -- <dir> --audio-take --no-take-pictures`, or with `game.json` `audioTakeFrames: false` beside `audioTake: true`. A World with no canvas (headless) records no pictures.

## Recording a take in the editor

1. Press Play.
2. Press **Record take** on the Play toolbar. Press it again to stop: the take is written into the project's `takes/` folder under a free name (`take_01.mycotake`, `take_02.mycotake`, ...).
3. Stopping Play while a take records stops it and saves it the same way.

**Record capture**, beside it, does the same for a capture (into `captures/`).

## Recording from an exported game

Export with the **Audio take** option (the checkbox in Build / Export, `npm run export -- <dir> --audio-take`, or `game.json` `audioTake: true`). In that game **F10** starts a take and the next F10 stops and saves it; a toast says "Recording a take…" and then where it went. There is no touch gesture for takes (three fingers belong to the capture trigger, F9). On the web the take downloads. On desktop and Android it's saved as a plain `<name>.mycotake` in the app's data folder, under `takes/`, keeping the newest 16 auto-named takes. On Windows that's `%APPDATA%\<app identifier>\takes\`. Drop the file on Biosonic's launcher to add it to **Recorded takes**, or copy it into your project's `takes/` folder.

## `Audio.take`

The same recorder from a script:

```ts
await Audio.take.start();          // loads the recorder (a separate chunk), then records; rejects if the audio core isn't available
Audio.take.mark("boss phase 2");   // a marker on the take's timeline and its profile; no-op while not recording
// ...play...
Audio.take.stop();
const where = await Audio.take.save("boss-fight");   // "boss-fight.mycotake"; a file name on the web, a path in the app
```

| Member | Type | Meaning |
| --- | --- | --- |
| `state` | `AudioTakeState` | `"idle"`, `"loading"` (the recorder is loading), `"recording"` or `"stopped"` (a take exists to save) |
| `seconds` | `number` | Seconds recorded (the running take's, else the last one's); 0 while idle |
| `start()` | `Promise<void>` | Load the recorder and begin a take, with a capture of the profile beside it. A second call while recording does nothing |
| `stop()` | `void` | End the take. It is kept for `save()` until the next `start()` |
| `mark(text)` | `void` | A marker at now, in the take and in its profile |
| `save(name?)` | `Promise<string>` | Compress and save the take, stopping a running one first. Rejects with "nothing recorded: call Audio.take.start() first" when there is no take |

`save` names files as `Audio.capture.save` does, with `.mycotake`: letters, digits, `.`, `_` and `-` kept, 64 characters at most; without a name the file is `take-YYYYMMDD-HHMMSS.mycotake`. A take stops by itself when Play stops or when it would pass the take cap (256 MiB of records), with a message; what it holds can still be saved.

## Opening a take

- **Without a project (ADR 0407):** Biosonic's **Recorded takes** lists your projects' takes (badge **Project**) and takes outside any project (badge **Recording**). Those are the takes in the Studio's takes folder and any `.mycotake` you drop on the launcher. Each row's **⋯** menu shows the file's path and has **Open Folder Location**. A take outside a project opens in a *takes folder*: the Studio's Take and Profiler screens over the folder that holds it, with no project audio. You can look at its timeline, requests and notes, but replay is silent.
- **Live, from a debug build:** **Connect to Game…** opens the Studio on the Profiler, following the build's live capture straight away. With no project open, it opens the takes folder, and the Take screen's **Start take**, **Mark**, **Stop** and **Save take** write takes there. The Live session section and the Take screen show the folder, with **Change…** to pick another (by default `<Studio app data>/takes`). With a project open, takes from a build go into the project's `takes/`. While the Studio is connected it owns the build's takes. F10 in the game, or the game's script, only starts and stops a take, and the Studio saves it as soon as the game stops it. On desktop and Android the game also keeps a backup copy in its own app data `takes/` folder, in case the stream is interrupted ("Take sent to the Audio Studio (a copy is kept in app data)"). That copy counts toward the newest-16 rotation. The Studio in a browser has no takes folder, so **Save take** asks where to save each take, and a take the game stops waits for you to press Save.
- **In the Studio:** the Take screen opens the takes in your project's `takes/` folder and replays their requests against the current project. The take records the state of the World's pick generator when it began and at each one-second keyframe; replay restarts the Studio's generator from it at the start and at every seek, so random picks (Queue picks, volume and pitch randomness, playback chance) come out as the game's did while the playlists they pick from are unchanged. A take recorded without `audio.seed` has unseeded picks and can't be matched. The picture lane shows the game view (click a picture to move there), and with nothing selected the Inspector shows the picture at the playhead. Edits apply to instances that start after them; you can restart the ones already playing. Notes you add are kept beside the take (`<take>.notes.json`); the take file itself never changes.
- **Profiling a replay:** **Profile this replay** on the Take screen (or Record on the Profiler while a take replays) records the Studio's own runtime. That capture names the take it replayed (its path and the `audio.json` hash it was recorded against); the Profiler shows "Replay of …" with **Open in Take**.
- **In the editor's Audio Profiler:** press **Open** or drop the file on the panel. The Profiler reads a take's profile as it reads a capture (the requests are skipped) and shows its pictures on a **Picture** track above the others (a click there moves the cursor); takes may be larger than captures, up to the take cap.

## What a take reveals

Everything a capture reveals (the project's name, its `audio` section, and the names of clips, buses, playlists, parameters and snapshots the game used), plus the requests: which sounds the game played, when, where, and with which parameter values, and any marker text. Treat a take like a source file when you share it.

## See also

- [Audio profiler](audio-profiler.md) for captures and the Profiler panel
- [Audio mix: API reference](audio-mix-api.md)
- [ADR 0348](../decisions/0348-takes-record-what-the-game-asked-of-audio-and-replay-it-profiler-captures-stay-telemetry.md)
