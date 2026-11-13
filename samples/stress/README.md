# Audio Stress

The audio core's stress sample (ADR 0157 task C1; architecture 6.4 and 6.5). It reproduces the soak's content in a browser: a voice storm over about 64 MB of distinct clips, 32 buses with effects, streams, moving HRTF sources and bus churn, with a live readout of the core's counters and a 30-minute soak mode that ends in a report to copy. C3 runs the soak on the gate machines with this sample; the same content has a bench twin (below).

## Run it

```
npm run dev
# http://localhost:3000/editor.html?sample=stress      then press Play and click the game view
```

The click unlocks the audio context. Then the sample generates its clips (a few seconds), plays each one silently so the core has decoded them all, and starts the storm. The readout (top left) shows the phase.

Desktop: `npm run tauri:dev` and open the Audio Stress sample. A built game player works as well (`npm run export -- samples/stress`).

## What it plays

| Part | What |
|---|---|
| Hits | About 490 short mono clips (0.3 to 1.4 s, different pitch and timbre), played in a shuffled order that never repeats a clip before the whole deck is spent, at pitch 0.5 to 16 (log-uniform), random priority, 25% spatial. About 120 starts a second. |
| Beds | Six long mono clips (20 to 80 s) played quietly at pitch 0.5 to 2, 40% spatial. About 80 starts a second (a bed lives about 48 s), plus a fast prefill in the first 12 s. They keep the logical voices near the 4,096 limit (the readout shows `logicalVoices` there after a minute or so; at the limit the core steals, and `droppedPlays` counts plays it refused). |
| Emitters | 24 looping spatial sources orbiting the listener at 3 to 14 m (the HRTF candidates). |
| Streams | 8 looping streamed files (four clips, `stream: true` in their `.meta.json`), half orbiting. |
| Buses | 32: Master, `Mix0..3`, `Bus00..26`. Each but Master has a high-pass, a low-pass and a compressor; 8 leaves also send to the reverb. All plays are on the leaves. |
| Churn | A bus volume fades every 0.2 s, a leaf mutes for 0.75 s every 1.5 s, and the `Muffled` and `Quiet` snapshots alternate every 9 s, plus one ducking rule (`Mix0` ducked by `Bus01`, presence mode). Since ADR 0171 `Bus.volume` is a multiplier on the bus's authored volume (leaves 0.8, `Mix` buses 1), so `Stress.ts` divides its random target by `authoredVolume`: the heard levels, 0.3 to 1.2, are what they were before. |

**Why the clips are generated at runtime.** Architecture 6.5 asks for at least 64 MB of distinct clips played in shuffled order, so that the mixer's reads miss the cache. Committed, that is 64 MB in the repository and in every build; generated, it is nothing, and the generator is seeded so every machine plays the same bytes. `scripts/clips.ts` synthesises them (mono 16-bit PCM at 48 kHz, 64 MiB decoded) and serves them to the core through a runtime asset source (blob URLs), which the core fetches and decodes like any asset. The committed files (about 0.9 MB) are the emitters and the streams: `node samples/stress/tools/generate.mjs` rewrites them, the scene and the bus list. The sample stores mono; the bench's clips are stereo, so its arena reads are twice as wide per voice, and a 64 MB arena holds half as many seconds.

## Presets

`project.json` starts on the **high** preset (`voices` 256 mixed, 4,096 logical, 32 HRTF; `clipMemoryMB` 256). To run the others, change `audio.voices` and `clipMemoryMB` there to the numbers of Project Settings > Audio's preset buttons (default: 128 / 4,096 / 16 with `clipMemoryMB` removed; low: 64 / 1,024 / 4 with 64) and press Play again; the storm reads the cap the core starts with and picks its profile (the low preset gets 24 MB of clips and 50 starts a second, with a 1,024-voice target). `?profile=low|default|high` overrides that.

## Keys and URL flags

Keys (click the game view first): `1` pause or resume the storm, `2` cycle its rate (x1, x0.5, x0.25), `3` churn on or off, `4` a snapshot on or off, `H` hide the readout, `K` start or stop the soak.

URL flags (on the editor URL, e.g. `editor.html?sample=stress&soak=30`): `soak=<minutes>` (bare `soak` is 30) starts the soak when the storm does; `profile`, `clipMB`, `rate` (starts a second), `logical` (voice target), `seed`, `churn=0`.

## Readout

`Audio.debug()` counters, with the ones that count events shown since the storm started: `underruns`, `lateCommands`, `logicalVoices` (with its peak), `mixedVoices / mixedCap` (and the cap's range), `hrtfVoices`, `workUnits` (and max), `streamStarves`, `droppedPlays`, and the main thread's frames over 100 ms (a long frame is a stall the core's lookahead has to ride out; headless software rendering has one on every frame, a desktop GPU shouldn't).

## Soak (C3)

Start it with `K` or `?soak=30`. It logs one summary line a minute to the console (`[soak] ...`: the minute's underruns, late commands, dropped plays, starves, the last voice counts, the lowest cap, the highest work units, stalls and the JS heap) and after the last minute prints a report to the console and shows it in a text box with a Copy button: the machine (user agent, cores, sample rate), the plan, one row per minute, the totals, and the gate's verdict (0 underruns, 0 stream starves, no trap or rebuild). Keep the tab visible (a hidden tab goes to the background policy) and the machine otherwise idle. `globalThis.__stress.report()` returns the report text, `.stats()` the live numbers.

## Bench twin

`audio-bench` has the same content as scenes `stress` (the cap off, so the cost of the full load shows) and `stress-cap` (the adaptive cap acting). Informational; they gate nothing. The high preset's 256 mixed, 4,096 logical, 32 HRTF (turning), 8 streams, 32 buses with effects, the reverb, 64 MB of clips read in shuffled order, pitch 0.5 to 16, about 200 starts a second:

```
cd native/audio && cargo run --release -p audio-bench -- mode=scene name=stress,stress-cap seconds=60 runs=5
node tools/audio-bench/run.mjs mode=scene name=stress,stress-cap seconds=60 runs=5     # as wasm in Node (needs the wasm32 target)
```

The bench times only the audio thread's work per 2.667 ms quantum; the sample also loads main (selection, the mirror, decoding, rendering), so the two agree on the core's cost and not on underruns. Compare the sample's `workUnits` with the bench's `wuMean`.

## Spec

`tests/e2e/audio-stress.spec.ts` (`@slow`): opens the sample in headless Chromium, waits for the storm, runs it 60 s and asserts that it runs: no errors, logical voices in the thousands, HRTF voices, 8 streams open and none starving, the cap above its floor and not collapsed, and underruns bounded. `npm run test:e2e:slow -- audio-stress`.
