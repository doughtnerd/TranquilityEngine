# S2: stream throughput for M4 music stems

Status: built, correctness-checked and smoke-run only. **Every timing number below is a smoke number** (1 run, short, 4 shared vCPUs, other agents compiling): only p50 and p99 are trustworthy and the tables are labelled so. The coordinator's idle-machine run (`node run.mjs`) replaces them; its tables go into the "Full run" section.

## Question

M4 music plays stems: 4-8 layers of one piece streaming together, doubled briefly in a crossfade between two segments, plus stingers. Can the stream path (decoder worker -> 32,768-frame rings in the core) carry that, at which stream counts, in which codec, and does the "mixed/16 clamped 4..16" ring rule need a separate music allowance?

## What exists today (code read)

| Fact | Where |
|---|---|
| Streams are read as f32, 4,096 frames per `readF32`, all channels, into one scratch; the chunk is copied into a pooled buffer and posted to the worklet port | `src/plugins/audio/runtime/decoder/streams.ts:527`, `:549-560` |
| The worker is event driven (no timers): on open it fills the whole credit window (8 chunks) synchronously, then one chunk per credit (4,096 frames consumed) | `streams.ts:499-509`, `credit.ts:10-12`, `worklet/coreDriver.ts:827-835` |
| Chunk buffers go back to the worker with the next credit; pool of 16 buffers per size | `coreDriver.ts:794-851`, `streams.ts:116` |
| Ring: 32,768 frames + one 4,096 chunk tail + 1,536 seek-fade copy = 38,400 frames x 2 ch x f32 = **307,200 B** | `native/audio/crates/audio-core/src/stream.rs:104-108` |
| Ring count = `max_mixed / 16` clamped 4..16 (64 -> 4, 128 -> 8, 256+ -> 16; the editor allows `mixed` 8..512, so 16 is the ceiling) | `stream.rs:110-121`, `audioSettingsModel.ts:205,235-237` |
| A voice starts at `START_FRAMES` = 4,096 buffered, starves when it lacks the quantum + 5 ms fade (128 + 240 frames), resumes at 4,096; starvation is reported in STATUS `starved` and as stream event 1; a STREAM_OPEN with no free ring is stream event 3 | `stream.rs:20-36` (header), `:114`; `counters.rs:243,255-257` |
| Decoder: symphonia 0.6.1 (wav, pcm, flac, mp3, ogg, vorbis; AAC only in the separate `myco_audio_decode_aac.wasm`, +324 KB); **no Opus**; at most 64 decoders open | `native/audio/crates/audio-decode/Cargo.toml:16,25`, `lib.rs:62` |
| `streamOpen` carries the **whole encoded file**; the wasm keeps it for the stream's life (`Arc<OwnedBlock>`) | `lib.rs:270`, `core/streams.ts:266` (main fetches the full file) |
| Clips decode to **int16** by default (`audio.clipFormat` "i16"; "f32" doubles it); arena blocks round up to a size class, four per doubling from 4 KB | `settings.ts:237`, `clipRegistry.ts:303`, `coreDriver.ts:127-135`, `clips.ts:1-5` (decoder), `arena.rs:1-6` |
| Clip ceilings: 64 MB low, 128 default (the default arena), 256 MB high | `audioSettingsModel.ts:235-237`, `context.ts:26` |

## Method (what is real, what is simulated)

Code bundled from the repository with esbuild (`build.mjs`, nothing in `src/` is touched):

- **Q1** (`q1_decode.mjs`): the real `DecoderWasm` and `myco_audio_decode.wasm` (AAC: the aac wasm) in Node 22, one stream, read exactly as `streams.ts` does (4,096 frames, f32; the int16 clip read is timed alongside). Content: `samples/flappy/music/town.mp3` (82 s, real music) transcoded with ffmpeg to 48 kHz stereo: MP3 CBR 192 / VBR (-q:a 2) / CBR 128, Vorbis q5 / q3, FLAC, WAV (s16), AAC 192 (`fixtures.mjs`). Correctness: every output compared with ffmpeg's decode of the same file (frame count and SNR): all frame counts equal (AAC differs by 417 frames, the encoder priming); SNR 122 dB (MP3), 137 dB (Vorbis), 133 dB (AAC), bit-exact (FLAC, WAV).
- **Q2** (`q2_concurrency.mjs`): the real `createDecoderHandler`/`StreamDecoder` in a `worker_thread` (as in the browser), N streams opened together. The worklet side is a **simulation** of `CoreDriver` + the core's rings driven by the wall clock: it parses the real wire messages, returns chunk buffers with real STREAM_CREDITs every 4,096 consumed frames, and applies the core's states (wait for 4,096, starve below 368, resume at 4,096). Metrics: worker busy % (event-loop utilisation = fraction of one core), credit-to-chunk response time ("refill"), start wait, minimum ring level. A second scenario adds a whole-clip decode of the same file in the same worker every 3 s.
- **Q3** (`q3_chromium.mjs`, `src/page.ts`): Chromium 153 headless; the **real** `decoder.worker.ts` bundle, the **real** `processor.ts` + `CoreDriver` + `myco_audio.wasm` in an `AudioWorkletNode`, the worker->worklet `MessageChannel`, real credits. Only main's `CoreBackend`/`CoreLink` is replaced by a minimal driver (~60 lines): preset in `processorOptions`, `streamPort`/`connectWorklet`, N `streamOpen`s, one BATCH with N PLAY records (flags stream|mixed|wantsPlayhead|loop, `clip` = stream id), STATUS read + RECYCLE. The context is a **real-time `AudioContext`** (the race is real-time only) on Chromium's null sink; no device in the container. Counters: STATUS `starved` list, stream event 1, the shell's underrun probe. Output is checked non-silent with an AnalyserNode. A **negative control** (`--control`: terminate the worker 3 s in) must make the core report starvation; it does (8 of 8 voices, below). A set larger than the ring count must be refused; it is (event 3).
- **Q4** (`q4_memory.mjs`): deterministic, load independent: wasm memory growth for 32 open streams per codec; ring constants; the core's memory after init per preset; the clip arena's size classes.

Not done on purpose: no timed run (coordinator's), no phone, no network fetch of the encoded file.

## Smoke results (NOT for the record)

### Q1 decode cost, one stream, f32 reads of 4,096 frames (us per chunk; 1 run, shared VM)

A chunk is 85.33 ms of audio. Real-time factor = 85,333 us / mean.

| codec | kbps | p50 | p99 | p99.9 | max | RTF (x) | % of 1 core | int16 clip read p50 | open (us) |
|---|---|---|---|---|---|---|---|---|---|
| MP3 CBR 192 | 192 | 138.9 | 207 | 1102 | 1102 | 635 | 0.16 | 190 | 1306 |
| MP3 VBR | 134 | 123.5 | 208 | 1000 | 1000 | 708 | 0.14 | 176 | 989 |
| MP3 CBR 128 | 128 | 130.3 | 218 | 1037 | 1037 | 679 | 0.15 | 185 | 894 |
| Vorbis q5 | 115 | 136.7 | 199 | 258 | 258 | 598 | 0.17 | 191 | 2992 |
| Vorbis q3 | 86 | 133.1 | 288 | 745 | 745 | 584 | 0.17 | 184 | 3445 |
| FLAC | 1098 | 128.9 | 281 | 934 | 934 | 660 | 0.15 | 180 | 7096 |
| WAV s16 | 1536 | 31.7 | 58 | 1250 | 1250 | 2603 | 0.04 | 84 | 9744 |
| AAC 192 (aac wasm) | 194 | 127.0 | 255 | 1198 | 1198 | 632 | 0.16 | 181 | 1737 |

All lossy codecs and FLAC cost the same, about 0.13 ms per chunk (0.15% of a core). Codec choice is not a CPU decision on this VM. p99.9 / max are cold-start and shared-VM spikes: not trustworthy.

### Q2 concurrency (Node worker thread, simulated worklet; smoke: 5-8 s, 1 run)

| codec | N | worker busy % | start p50 (ms) | start spread max-min (ms) | refill p50 / p99 / max (ms) | min ring (frames) | starves |
|---|---|---|---|---|---|---|---|
| MP3 CBR 192 | 4 | 2.6 | 5 | - | 4.1 / 8.3 / 8.6 | 28,416 | 0 |
| MP3 CBR 192 | 8 | 3.4 | 8 | 0 | 4.4 / 6.5 / 6.6 | 28,544 | 0 |
| MP3 CBR 192 | 16 | 6.9 | 53 | - | 3.8 / 5.5 / 7.9 | 28,544 | 0 |
| MP3 CBR 192 | 32 | 13.4 | 64-85 | 91 | 3.8 / 10.1 / 11.4 | 28,416 | 0 |
| MP3 CBR 192 | 64 (= MAX_DECODERS) | 29.7 (clip run) | 155 | - | 4.0 / 9.2 / 13.1 | 28,416 | 0 |
| Vorbis q5 | 16 | 8.3 | 59 | - | 3.7 / 6.9 / 12.1 | 28,544 | 0 |
| FLAC | 16 | 8.1 | 227 | - | 3.8 / 6.6 / 8.2 | 28,544 | 0 |
| MP3 + clip decode every 3 s | 8 | 10.7 | 8 | - | 4.5 / 6.3 / 6.4 | 28,544 | 0 |
| MP3 + clip decode every 3 s | 16 | 13.3 | 27 | - | 4.1 / 7.9 / 13.7 | 28,288 | 0 |

(Worker busy includes the startup burst, which is 8 chunks per stream decoded on open, so it overstates steady state in a short window. The refill floor of about 4 ms is the harness's 1 ms timer; the real credit path is faster.) No starvation anywhere up to 64 streams. The refill time is milliseconds against a slack of 590 ms (below).

### Q3 Chromium, real worker + real worklet (smoke)

| preset | rings | streams | codec | run | starved | refused (event 3) | underruns | output peak |
|---|---|---|---|---|---|---|---|---|
| high | 16 | 16 | MP3 192 | 10 s | 0 | 0 | 0 | 0.068 |
| low | 4 | 8 | MP3 192 | 6 s | 0 | **4** | 0 | 0.082 |
| default, control (worker killed at 3 s) | 8 | 8 | MP3 192 | 8 s | **8** (8 events) | 0 | 0 | 0.109 |

The control proves the counter fires; 8 streams on the low preset's 4 rings leaves 4 refused (stream event 3: "a full set fails new streams").

### Q4 memory (deterministic; these are final, not smoke)

| item | value |
|---|---|
| Ring per stream | 307,200 B. Region: low 4 rings 1.17 MB, default 8 rings 2.34 MB, high 16 rings 4.69 MB. The worker's chunk-buffer pool is at most 16 x 32,804 B = 0.50 MB. |
| Core memory after init (all fixed regions, no clips) | low 28.1 MB, default 30.3, high 32.8 (memory maximum 86.5 / 150.6 / 278.8 MB) |

Decoder worker memory per open stream (wasm growth over 32 opens of the 82 s file; **includes the stream's own copy of the encoded file**; the warm-up's freed block makes totals about one file / 32 low):

| codec | 82 s file (MiB) | per stream total (MiB) | decoder state beyond file + 32 KB scratch |
|---|---|---|---|
| MP3 CBR 192 | 1.89 | 1.96 | 39 KB |
| MP3 VBR / CBR 128 | 1.32 / 1.26 | 1.40 / 1.35 | 58 / 61 KB |
| Vorbis q5 / q3 | 1.12 / 0.84 | 2.77 / 2.58 | **1.65 / 1.74 MB** (codebooks, windows) |
| FLAC | 10.78 | 10.6 | ~0 |
| WAV s16 | 15.08 | 14.7 | ~0 |
| AAC 192 | 1.90 | 2.03 | 98 KB |

Scaled to a 3-minute track, the file a stream holds is 4.3 MB (MP3 192), 2.5 MB (Vorbis q5, plus 1.7 MB state), 24 MB (FLAC), 34 MB (WAV).

Decoded 3-minute track as the arena stores it (int16; MiB, the engine's "MB"):

| format | bytes | arena block | fits in low 64 / default 128 / high 256 (registry count / block count) |
|---|---|---|---|
| stereo 48 kHz int16 | 32.96 | 40.00 (+21%) | **1** / 3 / 7 (6 by blocks) |
| stereo 44.1 kHz int16 | 30.28 | 32.00 | 2 / 4 / 8 |
| mono 48 kHz int16 | 16.48 | 20.00 | 3 / 7 / 15 (12) |
| stereo 48 kHz f32 (`clipFormat: f32`) | 65.92 | 80.00 | 0 / 1 / 3 |

Answer to "how many 3-minute stems fit in the low 64 MB if decoded": **one** stereo 48 kHz stem (two at 44.1 kHz), three mono. A 4-stem stereo piece decoded is 132 MB (160 MB in blocks): beyond even the default 128 MB.

## Full run (idle machine, coordinator: `node run.mjs --only q1,q4`)

Q1 and Q4 are timed/measured on an idle machine (`results/summary.md`, `q1.json`, `q4.json`). **Q2 and Q3 timing was not re-run and stays at smoke level** (the smoke tables above remain labelled as such): the smoke already shows at least 570x real-time decode headroom and no starvation up to 64 streams, so the binding limits are memory and ring count (deterministic), and a timed run would not change a decision.

### Q1 (idle, 5 runs; median over runs of per-run p50/p99/p99.9, max = worst run; us per 4,096-frame chunk)

| codec | kbps | p50 | p99 | p99.9 | max | RTF (x) | % of 1 core | int16 read p50 | open (us) |
|---|---|---|---|---|---|---|---|---|---|
| MP3 CBR 192 | 192 | 137.0 | 213.9 | 625.6 | 1580 | 645 | 0.16 | 189.5 | 348 |
| MP3 VBR | 134 | 124.0 | 241.2 | 627.3 | 3452 | 673 | 0.15 | 180.5 | 243 |
| MP3 CBR 128 | 128 | 129.4 | 188.3 | 451.2 | 6357 | 687 | 0.15 | 180.4 | 227 |
| Vorbis q5 | 115 | 138.2 | 253.4 | 721.9 | 13283 | 569 | 0.18 | 190.9 | 1669 |
| Vorbis q3 | 86 | 130.5 | 230.4 | 475.1 | 2277 | 613 | 0.16 | 182.4 | 1627 |
| FLAC | 1098 | 129.0 | 256.0 | 810.7 | 4217 | 633 | 0.16 | 181.5 | 1822 |
| WAV s16 | 1536 | 31.3 | 61.0 | 194.5 | 1319 | 2667 | 0.04 | 83.0 | 2548 |
| AAC 192 (aac wasm) | 194 | 126.0 | 223.9 | 450.5 | 2216 | 631 | 0.16 | 179.3 | 670 |

Correctness unchanged (frame counts equal ffmpeg's; SNR 122 / 137 / 133 dB; FLAC and WAV bit-exact). Max values are single-run outliers (scheduler, GC), not decode cost.

**Open cost matters for priming:** opening a Vorbis stream costs about 1.7 ms (codebook setup) against 0.2-0.35 ms for MP3. Priming 8 stems is about 13 ms (Vorbis) vs about 2-3 ms (MP3), on top of each stream's 8-chunk window decode (about 1 ms): small, but it adds to the start spread (finding 3). WAV/FLAC open is 1.8-2.5 ms, mostly the copy of the large file.

### Q4: the deterministic tables above are the final numbers.

## Findings (smoke-based where marked)

1. **Decode is cheap and codec-neutral.** About 0.13 ms per 4,096-frame chunk for MP3, Vorbis, FLAC and AAC (about 600-700x real time on this VM), 0.03 ms for WAV. One stream is about 0.15% of a core; the worker's all-in cost (message, copy, post) is about 0.3-0.45% of a core per stream (smoke).
2. **The worker did not come close to failing.** 64 streams (the `MAX_DECODERS` cap) used about 30% of one core, with a worst credit-to-chunk time of 13 ms. The latency slack is the ring: after a credit the ring holds at least about 28,500 frames (measured minimum 28,288), and starvation begins below 368, so the worker may be late by about **590 ms** (28,500 - 368 frames at 48 kHz). N credits arrive together (stems started together stay in lockstep), so the burst service time is N x about 0.26 ms: 16 streams 4 ms. With a phone factor k (est., below) the binding limit is sustained CPU of the one worker thread (about 1/(0.0031 k) streams, 320/k, i.e. about 40 at k = 8 (est.)), then `MAX_DECODERS` = 64, never the 590 ms slack (burst limit about 2,270/k, i.e. 280 at k = 8 (est.)).
3. **Starts are not aligned.** A voice starts when its own ring holds 4,096 frames, and the worker decodes each stream's whole 8-chunk window on open, one stream after another: at N = 32 the first stem sounds about 40 ms before the last (spread 91 ms in the smoke; 144 ms max start), FLAC opens take longer (p50 227 ms at 16). Stems of one piece that start with an asap PLAY therefore drift apart by up to tens of ms, permanently. M4 needs a start barrier (all rings at START_FRAMES, then PLAY stamped at one frame), which is a core/wire change, not a tuning. This confirms the "no aligned starts" row in goal.md.
4. **A stream holds the whole encoded file in the worker's wasm memory** (`lib.rs:270`), per stream, even for stems of the same piece. 8 stems of a 3-minute WAV is 270 MB of worker memory, FLAC 190 MB, MP3 192 about 35 MB, Vorbis q5 about 20 MB + 14 MB state. The wasm never returns memory. Lossless stems are not viable on the low preset; the main thread also fetches the whole file before the first sound (not measured: fetch time of 4 MB, est. 0.1-1 s on mobile).
5. **Rings are not the cost; the count is the limit.** A ring is 0.3 MB, so even 32 rings are 9.8 MB. The rule `mixed/16` gives 4 on low: not enough for even one 4-stem piece crossfading (8), and 8 on default fits one 4-stem crossfade only if nothing else streams. The ring count is also the only thing that refuses a stream: a 5th stream on low is refused (verified in Chromium, event 3).
6. **Decoding stems into the arena does not work on low:** one 3-minute stereo stem fills 40 of 64 MB (arena class rounding wastes 21%); short loops (about 20-30 s) decode fine (30 s stereo 48 kHz int16 = 5.5 MB, 8 stems = 44 MB) and then need neither ring nor decoder.

## Recommendations

**Stream counts.** Keep `mixed/16` (clamped 4..16) as the general streaming allowance for ambience/VO, and give music its **own allowance of rings on top**, because music needs are a function of the piece (stems x 2 for a crossfade), not of the mixed-voice count:

| preset | today (rings) | music allowance | total rings | covers |
|---|---|---|---|---|
| low | 4 | +8 | 12 | 4 stems x 2 (crossfade) |
| default | 8 | +12 | 20 | 6 stems x 2 |
| high | 16 | +16 | 32 | 8 stems x 2 |

Memory cost is trivial (+2.4 / +3.7 / +4.9 MB of rings); CPU on the one decoder-worker thread (all-in 0.3-0.45% of a core per stream, smoke): on a low-end phone at k = 8 (est.) 12 streams are 30-43% of a core (est.); on default/high-class devices at k = 2-4 (est.) 20 streams are 12-36% and 32 streams 19-58% (est.), so the high allowance should be re-checked against the full run (and, if needed, a second decoder worker); the cap `MAX_STREAMS` (stream.rs:111, 16) and `MAX_DECODERS` (64, `lib.rs:62`) both need raising to 32 / 64. Stingers should be **decoded clips** (short, in the arena), not streams. To keep the crossfade double down, release a stem's ring once its fade reaches silence. If a ceiling must hold on low, 3-4 stems x 2 = 8 is the minimum; if even that is too much, author 2-3 stems and cross-fade by gain on the same rings (no doubling) when the two segments share stems.

**Codec for stems on low.** Ogg Vorbis (q5 about 115 kbps, 2.5 MB per 3 minutes) as the primary: native sample-exact gapless loops and seeks (no encoder-delay tag to trust), same decode cost as MP3, and its 1.7 MB state per stream is small next to the ring count budget. MP3 (CBR/VBR) is the accepted import format (state 40-60 KB, but gapless only if the LAME header is present; the engine reads it, `mp3_has_length_header`). Not FLAC/WAV for streamed stems on low (4 x 3-minute WAV stems = 132 MiB of worker memory). AAC stays optional (opt-in wasm). Android CPU: **(est.)** k = 5-10x slower than this VM for the wasm decode on an entry-level ARM core (not measured; no phone); at k = 8 (est.) decode alone is about 1.2% of a core per stream (12 streams 15%), all-in about 2.5-3.5% per stream (12 streams 30-43%).

## Unverified [U]

- [U] Every timing number: only smoke runs on a shared VM. Full set pending.
- [U] Android/phone CPU: k = 5-10 is an assumption. Chromium WebView worker scheduling, thermal throttling and big.LITTLE placement are untested.
- [U] The Q2 worklet is a simulation; Q3 is the real chain but the main side is a stub and the sink is Chromium's null/fake device (the clock is still real time: audio s / wall s = 1.0 in the smoke).
- [U] Fetch time and main-thread memory of the whole encoded file before a stream starts.
- [U] Whether starts misalign in the real browser by the same spread (Q2's N = 32 spread is Node + simulated worklet; Q3 does not measure start offsets).
- [U] Gapless MP3 for arbitrary composer files (only ffmpeg/LAME files were decoded; all frame counts matched).
- [U] AAC (opt-in wasm) memory and CPU on Android; Opus is not in the decoder at all.
- Per-stream decoder-state figures have an error of about one file size / 32 (allocator reuse from the warm-up).

## Reproduce

```
node run.mjs            # full timed set, idle machine, about 55 minutes -> results/summary.md
node run.mjs --smoke    # about 2 minutes, numbers not for the record
node run.mjs --only q4  # or q1 | q2 | q2clip | q3
```
Needs ffmpeg (libmp3lame, libvorbis, aac), `/opt/pw-browsers/chromium`, Node 22. `build.mjs` bundles the real engine modules into `build/`; fixtures are made into `fixtures/`.
