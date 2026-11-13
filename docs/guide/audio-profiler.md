# Audio profiler and capture files (ADR 0171, amended by 0172)

The **Audio Profiler** panel shows what the audio core did while your game played: how busy it was, which voices were playing and why others were not, where it glitched, how loud each bus was. You can record in the editor's Play mode, record from an exported game with `Audio.capture`, save the take as a `.mycap` file, and open that file later in the editor (on your machine or a tester's). For the buses the profiler reports on, see [Audio mixer](audio-mixer.md); for a silent sound, [Why is there no sound?](why-no-sound.md).

The recorder is a separate chunk that loads on the first `Audio.capture.start()`. A game that never calls it loads no recorder and pays nothing.

## What the panel shows

Open **Audio Profiler** from the editor's panels. It has a timeline of tracks above a set of tables, a bar of buttons and a legend of keys. All of it reads one recording, either the live one (Play, with the panel open) or a file.

Timeline tracks:

- **CPU** (the window length is in its label) and **CPU estimated share**, how that load splits between sections of the core. The share is an estimate. Until the first window fills the track says "CPU not yet measured".
- **Voices**: playing, virtual, cap, HRTF and bed counts.
- **Underruns**, **Late commands**, **Min slack (frames)**: the glitch tracks. An underrun is the output running dry; a late command is one that reached the core after the time it was meant for.
- **Ladder and voice cap**, **Ladder steps**: when the core shed work (HRTF, beds, zones, metering) to keep up, and each step.
- **Bus levels** and **Bus gain**: each bus's level, and the gain factors on it.
- **Loudness** and **Loudness target**: see below.
- **Event instances**, **Parameters**, **State changes**, **Music state**, **Music transitions**: what [sound events](sound-events.md) and [interactive music](interactive-music.md) did.
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

Loudness tracks show momentary (M), short-term (S) and integrated (I) LUFS for every bus the project meters, the final output included, with LRA and true peak in the tooltip. If the project has a loudness target, its integrated level is drawn as a line and ticks mark where the mix went over or under it. The profiler **warns and never adjusts**: it does not touch a fader, a bus or the target. A reopened capture and the live meter agree, because both use the same statistics. A bus that is not metered reads "Not metered".

## Recording in the editor

1. Press Play. The panel records on its own while it is open in Play: the live view follows a ring of the most recent audio.
2. Press **Record** in the bar to start a take. **Stop** ends it. **Save** writes the take to a `.mycap` file.
3. The ring is bounded. If it wrapped over the start of your take, the file begins at a later keyframe and is marked **Truncated**.
4. The Mixer's Compare switches and owner joins drop markers into the take by themselves.

A take survives Stop of Play once, so you can press Stop and then Save. Save with nothing recorded fails with "nothing recorded: call Audio.capture.start() first".

Where the file goes: on the web a download; in the desktop and Android apps the app-data `cache` folder (the path is shown in the bar when it is saved).

## Capturing from a game script

```ts
await Audio.capture.start();          // loads the recorder, then records; rejects with a message if it can't
Audio.capture.mark("boss phase 2");   // a marker on the timeline (cut to 120 UTF-8 bytes); no-op while not recording
// ...play...
Audio.capture.stop();
const where = await Audio.capture.save("boss-fight");   // "boss-fight.mycap"; a file name on the web, a path in the app
```

- `Audio.capture.state` is `"idle"`, `"loading"`, `"recording"` or `"stopped"` (a take exists to save). `seconds` and `bytes` describe what the ring holds, `truncated` says it wrapped.
- `save(name?)` keeps letters, digits, `.`, `_` and `-` (other runs become `_`, 64 characters, `.mycap` added). Without a name the file is `capture-YYYYMMDD-HHMMSS.mycap`.
- A second `start()` while recording joins the take and writes a marker. A `start()` after `stop()` begins a new take; `save()` writes the **latest** take only.
- **Automatic file rotation:** auto-named files keep the newest 16 in the app's `cache` folder; the oldest are deleted. A file you named yourself is never deleted. A browser cannot delete a download, so its built-in trigger stops at 16 saves per session.
- On the Babylon fallback the take holds main-side events and keyframes only, and the file says so.

**Exported games can record too.** Export with the Audio capture option (`npm run export -- <dir> --audio-capture`, or the checkbox in Build / Export). In that game F9 starts recording and the next F9 stops and saves a `.mycap` file; on a touch screen, hold three fingers for one second. A toast says what happened. On desktop and Android it keeps the newest 16 auto-named files in the app's cache folder; a browser stops at 16 saves per page session.

## Opening a capture

Press **Open** and choose a `.mycap`, or drop the file on the panel. Only `.mycap` files are accepted; anything else, or a file larger than any capture can be, is turned away with a banner before it is read. Opening decodes in a worker, with a progress bar and a **Cancel**. A refusal leaves the capture you had open.

What a capture holds is decided by the file, not by your open project, so you see what the recorder saw. Opening never replays sound and never changes your project.

### Banners

| Banner | Means |
| --- | --- |
| Viewing, not replaying | The timeline is a record of a past run. Nothing is playing. |
| Truncated | The ring wrapped, so the file starts at a later keyframe, not at Play. Earlier readings, including integrated loudness, may be missing; integrated loudness shows the live meter's value from that keyframe. |
| This capture was recorded with a different audio section than the open project's | The buses, snapshots, ducking or targets in the file differ from `project.json` now. The profiler shows the capture as recorded (bus names and the target come from the file). Warns only. |
| Babylon fallback: main-side events and keyframes only | The take came from the Babylon backend: no CPU, underrun or loudness tracks. |
| Can't open `<file>`: ... | A refusal, with its code and what to do. See below. |

Refusals you may meet: **badMagic** (not a Myco capture), **newerFormat** (saved by a newer build: update the editor), **olderFormat** (saved by an older build: captures are not migrated, re-record), **wireMismatch** (recorded by a different audio build: the message names both versions, re-record with this build), **tooLarge** and **inflateOverrun** (bigger than 64 MiB once unpacked, or lying about its size), and a family for damaged or cut-short files (`sizeMismatch`, `truncatedRecord`, `badIndex` and others). A damaged file never opens partly: it is refused whole.

## File size and privacy

A saved minute of recording is roughly **0.27 MB at 64 live voices, 0.84 MB at 256 and 2.45 MB at 1,024** (compressed; ADR 0172). The measured files in the real core ran 12 to 19 % above those figures. A capture is capped at 64 MiB unpacked.

**A capture is not anonymous.** It holds the project's name and version, the project's whole `audio` section, and the **names of clips, buses, events, parameters, snapshots and loudness targets** your game used, plus any marker text you wrote. It holds no sound data. Treat a capture like a source file when you send it to someone, and check it before attaching it to a public bug report.

## See also

- [Audio mixer](audio-mixer.md) and [Playing sound](playing-sound.md)
- [Editor](editor.md) for panels and docks
- [ADR 0171](../decisions/0171-audio-profiler-loudness-metering-and-live-mixing.md) and [ADR 0172](../decisions/0172-audio-mix-design-corrections-and-owner-decisions.md)
