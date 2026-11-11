# Why is there no sound?

Start with what the engine says about itself. In a script, or the browser console while the game runs:

```ts
console.log(Audio.debug());
```

In the editor, the **Audio Debug** panel (Window menu) shows the same, four times a second, while the game plays: the status, the backend, the underrun count, every bus with its gain, peak level and voice count, and every sound with its state. The panel says "Not playing" outside Play. Also read the console: the audio code warns once, in words, for most failures, and the warning is usually the answer.

Look at three things, in this order.

1. **`status`**: `"locked"`, `"running"` or `"failed"`.
2. **`core.backend`**: `"core"`, `"babylon"` (the fallback) or `"pending"` (still loading).
3. **`voices`**: each sound's `state`, which is the sound's `reason` when it isn't audible.

## 1. status is "locked"

Browsers don't let a page make sound until the player has clicked, tapped or pressed a key in it. Until then `Audio.status` is `"locked"` and every sound reads `reason` `"locked"`. Nothing is wrong; it starts with the first gesture.

What waits and what doesn't:

- An `AudioSource` and any looping sound wait and start when the sound unlocks, however long that takes.
- A one-shot waits only if it was started within a second before the unlock, and only the last 32. A footstep played ten seconds before the first click is dropped, on purpose. `debug().counters.queuedPlays` counts the waiting sounds and `droppedPlays` the dropped ones.
- `at` times are ignored while locked.

So a title screen with music needs a "Press any key" or a Play button before it; the click that unlocks the sound can also start the music. In the editor, click the game view once.

## 2. status is "failed"

The audio core crashed or stalled more than 3 times in a minute, and gave up for this session. The console says `audio core: more than 3 recoveries within 60 s … audio stays silent ("failed") for this session`. Every sound ends with `reason` `"failed"`. Reload the page. `debug().counters.traps` and `debug().core.recoveries` show how often it crashed. A core that fails to load or start at all is different: that case switches to the Babylon fallback (next section) and plays on.

A single crash is not a failure: the core rebuilds itself within a moment and replays what was playing, with a small gap.

## 3. core.backend is "babylon"

The Babylon fallback plays when:

- `audio.backend` is `"babylon"` in `project.json` or Project Settings > Audio (the macOS desktop app defaults to it), or
- the engine can't run the audio core. The console shows one warning, for example `Audio core unavailable: this engine lacks WebAssembly simd128 …`, or `audio core couldn't load (…)`, or `audio core couldn't start (…)`. The browser versions the core needs are in [audio-minimum-versions.md](audio-minimum-versions.md): Chrome and Edge 91, Firefox 89, Safari 16.4, Android System WebView 91.

Sound still plays there, but without bus effects, priorities, HRTF, beds or reverb zones, with walls that only lower the volume, and the browser decodes the files. If a sound is missing only on the fallback, check [the limits](audio-mixer.md#limits): a streamed clip plays flat, a snapshot's low-pass does nothing, and `maxVoices` stops the oldest sound. To stay on the core, update the browser or webview.

## 4. A sound's reason

Each entry in `Audio.debug().voices` has a `state`; `handle.reason` (from `Audio.playOneShot`) is the same word. `null` means audible. A sound that's `playing` with a reason is alive but silent for the moment.

| `reason` | What it means | What to do |
| --- | --- | --- |
| `"locked"` | No user gesture yet (section 1) | Wait for a click or key |
| `"busMuted"` | Its bus is silent: muted, volume 0, another bus is soloed, or a snapshot or duck took it to 0 | Check the bus rows: `gain` and `effectiveGain`; `Audio.bus("SFX").mute`, `.solo`, `.volume`; `Audio.clearSnapshot()` |
| `"virtual"` | Alive and keeping time, but not mixed: the mixed-voice limit is full and this one is quieter than the rest, it is too quiet to hear (far away, or volume near 0), it is paused, or its World doesn't have the view | Raise **Voices > Mixed**, raise its `priority`, or look at `volume`, `maxDistance` and the listener position |
| `"occluded"` | Alive but silent for the moment: a wall (an `AudioOccluder` collider) between the sound and the listener took it below what can be heard | Walk round, open the door (`openness`), pick a thinner material, or turn off `occlusion` on the source (section 9) |
| `"stolen"` | Ended early: a limit was hit and a higher-priority sound took its place (`handle.playing` is false) | Raise its `priority`, raise `maxVoices` on its bus, or play it less often |
| `"waitingForData"` | A streamed file isn't keeping up (slow disk or network, or a seek) | It fades back in when data arrives; check the network tab for the file |
| `"failed"` | It could not play: the file failed to load, its format isn't supported, AAC is off, or the core failed (section 2) | Read the console warning naming the file (below) |

`debug().counters` helps with the aggregate story: `mixedVoices` against `mixedCap`, `logicalVoices`, and `droppedPlays`. If many sounds are `virtual` at once, the mix is full; a bus with `maxVoices` shows `voices / maxVoices` in the panel.

## 5. The file is the problem

Each of these gives one console warning naming the file, and the sound reads `"failed"`:

- **AAC with the setting off.** `"music/theme.m4a" is AAC (.m4a), which the audio core decodes only with audio.codecs.aac set to true`. Turn on **AAC** in Project Settings > Audio (`"codecs": { "aac": true }` under `audio`), or convert the file to MP3, Ogg Vorbis or FLAC. The Babylon fallback plays AAC wherever the browser can.
- **An unsupported format.** `can't be decoded: its format (.opus) isn't one the audio core reads. Supported: …`. The core reads WAV, FLAC, MP3, Ogg Vorbis and (opted in) AAC. Opus and AIFF are not supported; re-encode them.
- **A damaged file, or a wrong path.** `audio: clip "…" failed to load (…)` with the reason, such as a failed fetch or truncated data. Check the path and open the file in a player.
- **Too much audio loaded.** `failed to load (over the clip memory ceiling)`. Decoded clips are kept in memory (the **Clip memory** setting, 16 to 1024 MB; left blank it follows the voices preset, 64 MB on `low`). Turn on **stream** for long files, or leave **Clip format** at 16-bit, which halves the memory.
- **A streamed file that stops** warns `audio: streaming "…" failed`.

## 6. The decoder worker

The core decodes on a worker (`myco_audio_decode.wasm`). If it crashes, the engine restarts it and retries the loads in flight, up to 3 times a minute. Past that, loads fail with one warning each until the minute is over, and a file that crashes the worker every time can use up the retries and delay other clips. If the worker can't start at all (no `Worker`, a blocked or corrupted wasm file, or a wasm that doesn't match the engine build), clips fail to load, one warning each. Check that the game's `myco_audio_decode.wasm` (and `myco_audio_decode_aac.wasm` with AAC) is served with the right MIME type (`application/wasm`) and wasn't altered by a proxy or a stale cache. A hard reload fixes a stale one.

## 7. The tab is hidden

What a hidden tab does is the project's **In background** setting (`audio.background`):

- `"mute"` (default): the sound fades to silence and keeps time; it fades back in when the tab is visible.
- `"pause"`: the audio is paused and resumes where it stopped.
- `"play"`: nothing happens (browsers may still throttle).

`Audio.debug().background` shows the mode and `debug().core.pageHidden` whether the core thinks the page is hidden. If a tab seems to lose its sound for good, check that it is visible, not just unfocused. An interruption such as a call, or another app taking the output, is retried for about two seconds, then the engine rebuilds the core; sound resumes on its own, or after the next touch where the OS needs one.

## 8. Master, mute and volume

Rule out the plain things: `Audio.muted`, `Audio.volume` (or `masterVolume`), the bus `Master` and the clip's import `volume` and the source's `volume`. The effective gain of every bus is in `debug().buses[i].effectiveGain`. The browser's tab can be muted, the OS output device may be the wrong one, and a device change makes the engine rebuild the core (a brief gap, then sound again).

## 9. A spatial sound that's missing

A spatial sound beyond `maxDistance` is silent, and one far from the listener is very quiet. Check where the `AudioListener` is (without one the main camera listens), `minDistance`, `maxDistance` and `rolloff`. Walls count: a sound behind a thick wall (a `concrete` occluder takes 30 dB) can fall to nothing and read `reason` `"occluded"`. The voice row's `occlusion` shows the gain and cutoff, how many walls it crossed and which collider, and the Occlusion section of the panel shows the rays; the **Beds** and **Zones** sections answer questions about beds and reverb. A World that has no view doesn't play; only the World that renders is heard. If the HRTF data failed to load, the panel says `(HRTF data failed to load)` and spatial sounds stay equal-power; that's a quality change, not silence.

## Crackling instead of silence

`debug().counters.underruns` counts the times the audio thread missed its deadline, the usual cause of clicks and crackle. A few are normal while the editor is busy. If it climbs during play, lower **Voices > Mixed** or choose the `low` preset, turn off HRTF, or remove effects from busy buses. `lateCommands` and `droppedPlays` also count.

## Still stuck

Copy `JSON.stringify(Audio.debug(), null, 2)` when reporting a problem; it has everything above and nothing private.
