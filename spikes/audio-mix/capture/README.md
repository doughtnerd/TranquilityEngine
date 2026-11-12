# S3: profiler capture (data rate, main-thread cost, file saving)

Question: what does a capture stream cost in bytes, main-thread time and editor time, and how does an exported game save it?
Method: `codec.mjs` (candidate binary record stream, preallocated ring, reader, file header), `sim.mjs` (synthetic scenes that write **real wire STATUS bytes** through `writeStatus`, `wire.generated.ts`), `run.mjs` (checks, sizes, timing, editor costs).
Run: `node --experimental-strip-types --expose-gc spikes/audio-mix/capture/run.mjs` (full, 5 runs, est. 3-4 min on an idle machine; `--smoke` about 6 s). Writes `results.json`.

## What is synthetic (the real core was NOT run)
The loopback host (`src/plugins/audio/runtime/testing.ts:518`) needs the vitest/TS pipeline, and the `stress` sample has only a README. Scenes are synthetic at 64/256/1,024 live voices (life 3/2.5/2 s, so 21/102/512 voice starts per s; 25-30% looping voices feed the playheads section; 8/12/16 buses). Item counts follow the caps in `wire.generated.ts` (playheads <= 256 per block, peaks <= 32). Real scenes will differ in churn and loop mix: **the byte rates are scene-dependent estimates (est.)**; the per-record formats and costs are not.

## Facts read from code
- STATUS every 6 quanta = 16 ms = 62.5/s (`audio-wire/src/schema.rs:75`, `wire.generated.ts:37`); idle every 48 quanta after 250 ms (`:39-41`). Header 176 B; the wire block is variable (176 + ended/demoted/starved 4 B each + playheads 8 B each, up to 256 + peaks 8 B x buses...), worst case 16,192 B.
- STATUS carries counts, not the voice table: `ended`, `demoted`, `starved` ids, round-robin playheads, peaks of 32 buses. The per-voice table (state, priority, gain, audibility) exists only on main (`Audio.debug()`, `backend.ts:137-162`), hence a main-side keyframe and main-side events.
- The core's reader reuses one block (`core/statusReader.ts:73,120`), so a recorder must copy or encode inside the callback.
- Storage: `Storage.save(key, Uint8Array, "cache")` writes `<appDataDir>/cache/<key>.bin` through `TauriStorage` (`platform/TauriStorage.ts:7-9,23-31`); namespaces are only saves/settings/cache (`platform/Storage.ts:5`). Capabilities already allow app-data write (`src-tauri/capabilities/default.json:12-13`). Android uses the same path, app-private (ADR 0155:15, 58).
- Web exports are served by a generated `serve.mjs` (`src/export/webBuild.ts:262-289`): static files only, no upload endpoint.

## Record stream (codec.mjs)
`KF` (voice-table keyframe, resets the delta chain, 1/s) | `STATUS` (delta vs previous: bitmap of changed header fields + zigzag varints; id lists delta-coded; playheads 1 byte when the id gap is small and the pitch-1 prediction holds; peaks quantised to 0.01 dB, or lossless f32; rare sections tagged empty/same/new) | `EVENT` (type, delta-us, 4 varints [+f32]). Event vocabulary: voice start/stop(reason)/steal(by, reason)/virtualise(reason), event-instance start/stop, parameter, music transition, bus mix. Keyframe row: id, clip, bus, state, priority, gain f32, pitch u12.12, audibility u16, playhead (about 19 B). Ring: power-of-two `Uint8Array`, tail always on a keyframe, eviction drops whole keyframe segments.

## Results (smoke run, 30 s captures; sizes do not depend on load; timings below DO and are indicative only)
Per minute of capture:
| live voices | STATUS raw | STATUS delta(q) | events (ev/s) | keyframes 1/s | TOTAL raw | TOTAL delta(q) | delta lossless peaks | JSON total |
|---|---|---|---|---|---|---|---|---|
| 64 | 1.58 MB | 0.38 | 0.05 (92) | 0.07 | 1.70 | **0.51** | 0.68 | 8.4 |
| 256 | 3.66 | 1.17 | 0.13 (269) | 0.28 | 4.08 | **1.59** | 1.85 | 18.7 |
| 1,024 | 9.18 | 3.37 | 0.55 (1,175) | 1.12 | 10.85 | **5.04** | 5.39 | 49.4 |

Compressed (60 s window, gzip = deflate-raw within 20 B; `CompressionStream('deflate-raw')` output equals zlib byte for byte; 10 s independent chunks cost +0-4%):
| voices | raw stream | delta(q) | delta lossless |
|---|---|---|---|
| 64 | 0.27 MB/min | **0.08** | 0.18 |
| 256 | 0.84 | **0.15** | 0.27 |
| 1,024 | 2.45 | **0.25** | 0.31 |

Ring for "the last N minutes" (uncompressed delta(q); compress only at save): N=5: 2.6 / 8 / 25 MB; N=10: 5 / 16 / 50 MB (64 / 256 / 1,024 voices). Saved 10-minute file, gzip: about 0.8 / 1.5 / 2.5 MB (est. from the per-minute figures).

Main-thread cost, microseconds per call (smoke, shared VM: p50 only roughly right; timer overhead 0.06 us):
| operation | 64 | 256 | 1,024 | note |
|---|---|---|---|---|
| STATUS raw copy | 0.7 | 1.4 | 6 | memcpy of 0.4-2.4 KB |
| STATUS delta (binary) | 3-4 | 18-20 | 8-9 | noisy; about 0.1% of a 16 ms block |
| STATUS JSON.stringify | 6 | 13 | 30 | 2.4 / 4.7 / 10.7 KB allocated per block |
| event binary / JSON | 0.2 / 0.6 | 0.3 / 0.6 | 0.13 / 0.5 | about 100 B / 500 B allocated |
| keyframe binary / JSON | 5 / 22 | 18 / 111 | 65 / 371 | JSON at 1,024: p99 2.5 ms, 19 GCs in 300 calls |

Allocation (child process, heapUsed delta): binary STATUS about 370-475 B/op, event about 100 B/op, keyframe 16 B/op (64 voices: 1 KB, warm-up residue). So "no per-block allocation" is **not yet met**: the remainder is the changed-section copy (`sc.slice`, zones change every block in my synthetic scene) and probably boxed 53-bit heap numbers for ring positions. JSON is 6-30x worse. Fixable with per-section preallocated buffers and Float64Array positions [U: not tried].

Editor side (smoke, 30 s capture; full-decode figures scale linearly, x20 for 10 min = est. 0.35 / 0.55 / 0.9 s):
| voices | gunzip | header-scan index (no footer) | full decode + overview | reconstruct at random t p50 / p99 |
|---|---|---|---|---|
| 64 | 1 ms (30 s) | 0.11 ms | 17 ms | 0.2 / 0.8 ms |
| 256 | 2 | 0.33 | 27 | 0.46 / 1.2 ms |
| 1,024 | 6 | 0.88 | 43 | 0.64 / 2.0 ms |
Reconstruction = binary search keyframe, rebuild the voice table, replay at most 63 STATUS and the events of that second, so it does not grow with capture length. The 10-minute index is 600 keyframes; a footer index makes opening free.

Checks that passed (load independent): 376k field comparisons round-trip (64 and 1,024 voices, quantised and lossless; quantised peak error <= 0.005 dB, `dateMs` kept to 1 us); an evicted 1 MiB ring decodes cleanly from a keyframe to the end; the header refuses a different schema hash, bad magic and a newer format.

## Saving
| platform | write | get it out | status |
|---|---|---|---|
| web export | `Blob` + `a[download]` (any browser); `showSaveFilePicker` in Chromium desktop only | the browser's download folder | Blob path standard; picker availability on Android Chrome [U], WebKit/Firefox lack it |
| desktop (Tauri) | `Storage.save(key, bytes, "cache")` gives `<appDataDir>/cache/<key>.bin` via `tauri-plugin-fs` (no new capability); optional "reveal in folder" with the already-granted `opener:allow-reveal-item-in-dir` (editor capability file) | the folder | design from code; not run [U] |
| Android (Tauri 2 mobile) | same call; app-private storage | debug build: `adb exec-out run-as <package> cat files/cache/<key>.bin > x.bin` [U, path and run-as unverified]; release build: no adb access, needs a share-sheet plugin or a write to shared storage (new capability and plugin, +risk) [U] | gap; recommend capture upload-free: a debug-build adb path in M5, share intent deferred |
Recording triggers (options, not a decision): `Audio.capture.start({ minutes })`/`stop()`/`save()` API; a debug-only export flag (exports already have `--debug`, ADR 0155:141) that enables the recorder module and a key combo/touch gesture; a `?audioCapture=1` query on web; a project setting. Release exports should not ship the recorder (lazy `import()` behind the flag), so it costs players nothing.

## File header proposal (codec.mjs `writeFileHeader`)
`"MYCAP\0" 0x01 0x1A` (8) | format u16 | flags u16 (bit0 peaks quantised) | wire schema hash 16 B (`SCHEMA_HASH`, `wire.generated.ts:7`, checked by `wire.schemaHash.test.ts`) | wire major, minor u16 x2 | sample rate u32 | quantum frames u16 | status-every-quanta u8 | preset u8 | start date f64 | keyframe interval us u32 | string-table length u32 + JSON (clip names, bus names, event assets, parameter names: ids in the stream are meaningless without it) | records, then an optional keyframe-index footer. Policy: any hash mismatch refuses cleanly (STATUS cannot be decoded); an old capture is not migrated (no compatibility work, per the goal).

## Not measured / unverified
Real core scenes; real Android/WebView costs (Pixel 8 emulator floor); idle STATUS cadence (cheaper); Safari/Firefox; the adb path; footer index; a Worker doing the gzip at save time (compression of 60 s took ms in Node; browser cost [U]).
