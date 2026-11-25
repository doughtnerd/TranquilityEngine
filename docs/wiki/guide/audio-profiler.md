# Audio profiler and capture files (ADR 0171, amended by 0172)

> **The Audio Profiler panel moved to the Audio Studio.** Captures (`.sporesample`) open on the Studio's Profiler screen (the **Audio Studio** (in the editor: Window > Audio Studio, or **Open in Audio Studio** on a file; ADR 0341)). Recording happens in the Studio: **Record** on the Profiler records the Studio's own audio, and **Record session** in the player bar records a take on a connected game build; both save into `recordings/` (the editor's Play toolbar no longer records, ADR 0416). The panel walk-through below describes the editor panel this replaced.

The Audio Studio's **Profiler** screen shows what the audio core did while your game played: how busy it was, which voices were playing and why others were not, where it glitched, how loud each bus was. You can record in the editor's Play mode, record from an exported game with `Audio.capture`, save the recording as a `.sporesample` file, and open that file later in the editor (on your machine or a tester's). For the buses the profiler reports on, see [Audio mixer](audio-mixer.md); to change the mix while you watch it, [Live mixing and ducking](audio-mixing.md); for what the loudness tracks mean, [Loudness](audio-loudness.md); for every `Audio.capture` member, [Audio mix: API reference](audio-mix-api.md#audiocapture); for a silent sound, [Why is there no sound?](why-no-sound.md). To record what the game asked of audio as well, so the Studio can replay it against your current project, record a [take](audio-takes.md) instead.

The recorder is a separate chunk that loads on the first `Audio.capture.start()`. A game that never calls it loads no recorder and pays nothing.

## What the panel shows

Open a capture in the Audio Studio (double-click a `.sporesample` in the editor's Assets panel, or the Studio's Profiler screen). It has a timeline of tracks above a set of tables, a bar of buttons and a legend of keys. All of it reads one recording, either the live one (Play, with the panel open) or a file.

Timeline tracks:

- **CPU** (the window length is in its label) and **CPU estimated share**, how that load splits between sections of the core. The share is an estimate. Until the first window fills the track says "CPU not yet measured". On the Studio's Profiler screen the same estimate is the **Effects cost · estimated** track: one line per section, in permille of an audio quantum, with the two costliest at the cursor. Voice and instance effects fall in Voices, bus and return effects in Buses; the core doesn't yet report each effect's own cost.
- **Voices**: playing, virtual, cap, HRTF and bed counts.
- **Underruns**, **Late commands**, **Min slack (frames)**: the glitch tracks. An underrun is the output running dry; a late command is one that reached the core after the time it was meant for.
- **Ladder and voice cap**, **Ladder steps**: when the core shed work (HRTF, beds, zones, metering) to keep up, and each step.
- **Bus levels** and **Bus gain**: each bus's level, and the gain factors on it.
- **Loudness** and **Loudness target**: see below.
- **Event instances**, **Parameters**, **State changes**, **Music state**, **Music transitions**: what [playlists](playlists.md) and [interactive music](interactive-music.md) did.
- **Markers**: text you or the editor dropped on the timeline.

Tables under the timeline show the state **at the cursor**: voices (with the reason a voice is virtual, stolen or refused, and who stole it), buses (each bus's gain factors and their product), event instances and music. A name filter narrows all four. The voice table renders at most 64 rows and counts the rest.

A view with nothing to show says why: "Not playing", "Recording starts when the panel opens in Play", "CPU not yet measured", "Not metered", "Truncated: the ring wrapped", or "Babylon fallback: no CPU line".

### The cursor and the keys

The cursor is live (following the recording), paused, or scrubbed to a time. The keys work while focus is inside the panel (Tab reaches it) and never inside the name filter or with Ctrl, Alt or Meta held, so no editor shortcut is shadowed:

| Key | Does |
| --- | --- |
| Left, Right | step one status block back, forward |
| U, Shift+U | previous, next underrun |
| L, Shift+L | previous, next late command |
| D, Shift+D | previous, next ladder step |
| M, Shift+M | previous, next marker |
| Space | play or pause the live view |

The panel lists them in its own legend.

### Loudness

Loudness tracks (the meters themselves, targets and the verdicts are in [Loudness](audio-loudness.md)) show momentary (M), short-term (S) and integrated (I) LUFS for every bus the project meters, the final output included, with LRA and true peak in the tooltip. If the project has a loudness target, its integrated level is drawn as a line and ticks mark where the mix went over or under it. The profiler **warns and never adjusts**: it does not touch a fader, a bus or the target. A reopened capture and the live meter agree, because both use the same statistics. A bus that is not metered reads "Not metered".

## Recording in the editor

1. Press Play. The panel records on its own while it is open in Play: the live view follows a ring of the most recent audio.
2. Press **Record** in the bar to start a recording. **Stop** ends it. **Save** writes the recording to a `.sporesample` file.
3. The ring is bounded. If it wrapped over the start of your recording, the file begins at a later keyframe and is marked **Truncated**.
4. The [Mixer](audio-mixing.md#the-mixer-panel)'s Compare switches and owner joins drop markers into the recording by themselves. Edits you make with the Mixer while recording show on the Bus levels and Bus gain tracks.

A recording survives Stop of Play once, so you can press Stop and then Save. Save with nothing recorded fails with "nothing recorded: call Audio.capture.start() first".

Where the file goes: on the web a download (`<name>.sporesample`); in the desktop and Android apps the app data folder's `recordings/` as `<name>.sporesample` (the desktop's path is shown in the bar when it is saved).

## Capturing from a game script

```ts
await Audio.capture.start();          // loads the recorder, then records; rejects with a message if it can't
Audio.capture.mark("boss phase 2");   // a marker on the timeline (cut to 120 UTF-8 bytes); no-op while not recording
// ...play...
Audio.capture.stop();
const where = await Audio.capture.save("boss-fight");   // "boss-fight.sporesample"; a file name on the web, a path in the app
```

- `Audio.capture.state` is `"idle"`, `"loading"`, `"recording"` or `"stopped"` (a recording exists to save). `seconds` and `bytes` describe what the ring holds, `truncated` says it wrapped.
- `save(name?)` keeps letters, digits, `.`, `_` and `-` (other runs become `_`, 64 characters, `.sporesample` added). Without a name the file is `capture-YYYYMMDD-HHMMSS.sporesample`.
- A second `start()` while recording joins the recording and writes a marker. A `start()` after `stop()` begins a new recording; `save()` writes the **latest** recording only.
- **Automatic file rotation:** auto-named files keep the newest 16 in the app's `cache` folder; the oldest are deleted. A file you named yourself is never deleted. A browser cannot delete a download, so its built-in trigger stops at 16 saves per session.
- On the Babylon fallback the recording holds main-side events and keyframes only, and the file says so.

**Exported games can record too.** Export with the Audio capture option (`npm run export -- <dir> --audio-capture`, or the checkbox in Build / Export). In that game F9 starts recording and the next F9 stops and saves a `.sporesample` file; on a touch screen, hold three fingers for one second. A toast says what happened. On desktop and Android it keeps the newest 16 auto-named files in the app's cache folder; a browser stops at 16 saves per page session.

## Captures on Android

There is no Android export target yet (ADR 0155's `--target android` is not implemented: `--target` is `web` or `desktop`). To record on a phone, export the **web** build with capture on, serve it from your computer and open it in the phone's Chrome. Android 14 with Chrome 113 is the supported floor ([ADR 0169](../../decisions/0169-the-supported-mobile-floor-is-android-14-with-chrome-113.md)).

1. Build and export with the option, then serve the folder:

   ```sh
   npm run build
   npm run export -- samples/sound-lab --out /tmp/lab-web --audio-capture
   cd /tmp/lab-web && node serve.mjs 8083
   ```

2. Turn on USB debugging on the phone, connect it and forward the port, so the phone's `localhost` is your computer:

   ```sh
   adb reverse tcp:8083 tcp:8083
   ```

3. Open `http://localhost:8083/` in Chrome on the phone. `localhost` counts as a secure context, so the audio worklet runs. Tap once to unlock audio.
4. Hold exactly **three fingers on the screen for one second**: a toast says recording started. Play a while, then hold three fingers again: the toast names the saved file. Fewer or more fingers, or lifting early, does nothing. (With a keyboard on the phone, F9 does the same.)
5. Pull the file to your computer. Chrome saves it in the phone's Downloads:

   ```sh
   adb shell ls /sdcard/Download
   adb pull /sdcard/Download/capture-YYYYMMDD-HHMMSS.sporesample .
   ```

6. Open it as any capture: **Audio Profiler**, **Open** (or drop the file on the panel). The CPU track shows the phone's load, or says why it can't ("CPU not yet measured", "clock too coarse") when the phone's worklet clock is too coarse to time it.

A browser stops at 16 saves per page session (a toast says so); reload the page to record again, since a browser can't delete its own downloads.

**A Tauri app** (the desktop export's Tauri project, or an Android Tauri build) saves into its private data folder instead, as `recordings/capture-YYYYMMDD-HHMMSS.sporesample`, and keeps the newest 16 auto-named files, deleting the oldest (a file you named yourself is never deleted). On a debuggable build, find the file and pull it:

```sh
adb shell run-as <package id> find . -name "*.sporesample"
adb exec-out run-as <package id> cat files/recordings/<name>.sporesample > <name>.sporesample
```

The exact data folder depends on the build, which is why the first command looks for it. Open the pulled file as it is.

What a phone can and can't tell you: an emulator's audio runs through your computer and its timing is not a device's, so use it for the trigger, the file and the load, and use a real phone for CPU figures and for how much recording costs.

## Takes

A capture records how the engine played. A **take** (`.sporesample`) records that profile *and* what the game asked of audio (every play, parameter, position, stop and marker), so the Studio can replay the run against your current project and you hear your edits in context. Record one with **Record session** in the Audio Studio's player bar while a game build is connected (it saves into the project's `recordings/` folder), with **F10** in a game exported with the Audio take option, or with `Audio.take` from a script. The Profiler opens a take's profile as it opens a capture. The full story is in [Audio takes](audio-takes.md).

## Opening a capture

Press **Open** and choose a `.sporesample` or a `.sporesample`, or drop the file on the panel. Only those files are accepted; anything else, or a file larger than any capture (or take) can be, is turned away with a banner before it is read. Opening decodes in a worker, with a progress bar and a **Cancel**. A refusal leaves the capture you had open.

What a capture holds is decided by the file, not by your open project, so you see what the recorder saw. Opening never replays sound and never changes your project.

### Banners

| Banner | Means |
| --- | --- |
| Viewing, not replaying | The timeline is a record of a past run. Nothing is playing. |
| Truncated | The ring wrapped, so the file starts at a later keyframe, not at Play. Earlier readings, including integrated loudness, may be missing; integrated loudness shows the live meter's value from that keyframe. |
| This capture was recorded with a different audio section than the open project's | The buses, snapshots, ducking or targets in the file differ from `project.json` now. The profiler shows the capture as recorded (bus names and the target come from the file). Warns only. |
| Babylon fallback: main-side events and keyframes only | The recording came from the Babylon backend: no CPU, underrun or loudness tracks. |
| Can't open `<file>`: ... | A refusal, with its code and what to do. See below. |

Refusals you may meet: **badMagic** (not a Myco capture), **newerFormat** (saved by a newer build: update the editor), **olderFormat** (saved by an older build: captures are not migrated, re-record), **wireMismatch** (recorded by an audio core of another major version: the message names both versions, re-record with this build; a capture or take from another minor version of the same major opens, since a minor only adds), **tooLarge** and **inflateOverrun** (bigger than 64 MiB once unpacked, or lying about its size), and a family for damaged or cut-short files (`sizeMismatch`, `truncatedRecord`, `badIndex` and others). A damaged file never opens partly: it is refused whole.

## File size and privacy

A saved minute of recording is roughly **0.27 MB at 64 live voices, 0.84 MB at 256 and 2.45 MB at 1,024** (compressed; ADR 0172). The measured files in the real core ran 12 to 19 % above those figures. A capture is capped at 64 MiB unpacked.

**A capture is not anonymous.** It holds the project's name and version, the project's whole `audio` section, and the **names of clips, buses, events, parameters, snapshots and loudness targets** your game used, plus any marker text you wrote. It holds no sound data. Treat a capture like a source file when you send it to someone, and check it before attaching it to a public bug report.

## See also

- [Audio takes](audio-takes.md): record what the game asked of audio and replay it in the Studio
- [Audio mixer](audio-mixer.md), [Live mixing and ducking](audio-mixing.md), [Loudness](audio-loudness.md) and [Playing sound](playing-sound.md)
- [Audio mix: API reference](audio-mix-api.md)
- [Editor](editor.md) for panels and docks
- [ADR 0171](../../decisions/0171-audio-profiler-loudness-metering-and-live-mixing.md) and [ADR 0172](../../decisions/0172-audio-mix-design-corrections-and-owner-decisions.md)
