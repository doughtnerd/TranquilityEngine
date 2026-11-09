# RFC 0149 review: architect

**Verdict: approve with changes.** The direction is sound and the spike work is unusually thorough: an engine-owned core in an AudioWorklet is the only path that gives open-source, identical-everywhere audio with a later native route, and the threading split (audio thread mixes, main thread decides, decoder worker streams straight to the worklet) is right. But the RFC commits to deleting a working system at the end of M1 on evidence gathered on one high-end CPU, in containers without audio devices for two of the three desktop webviews, with a cache-warm synthetic voice. Top 3 concerns: (1) the record has no worklet → main feedback channel and no recovery model, although 0098's `AudioVoice.playing` is synchronous and a wasm trap kills the processor; (2) clip memory has no design: without a SAB, every decoded clip must be copied into the worklet's own wasm heap, which contradicts "never allocates after start"; (3) the budgets are set on averages from an idealised mixer (linear interpolation, 4 one-second clips), so they say little about the worst case on real content or weaker hardware.

## Issues

1. **blocking: no feedback channel or state ownership.** The RFC is one-way ("Nothing ever waits on the audio thread"). 0098's `AudioVoice.playing` (`src/engine/audio/backend.ts:29`), end-of-clip, playback position, virtualisation state, meters (M5) and underrun counts all need worklet → main data. The spike's core also ranks virtual voices *inside* the worklet (`core/src/lib.rs` `pick_real`, every 8 quanta), while the RFC ranks them on the main thread, so it's unclear who owns play position. *Change:* add a "State and feedback" subsection. The main thread owns the authoritative voice table (intent). The worklet owns playhead and voice lifetime and posts a compact status block each render period (ended voice ids, playheads, counters). `playing` reads a main-side mirror that may be up to one frame stale, and the record says so.

2. **blocking: clip memory and loading.** Without a SAB, the worklet's `WebAssembly.Memory` is private, so decoded PCM must be `memcpy`'d into it on the audio thread, and `memory.grow` happens there. 48 kHz stereo f32 is 384 KB/s, so 5 minutes of clips is about 115 MB in a wasm32 heap that never shrinks. *Change:* specify a reserved-and-pooled clip arena, chunked copies under a per-quantum byte budget (for example 256 KB), growth outside `process()` (in `onmessage`), and unload/compaction rules for the editor's play/stop cycles. Add a memory budget per preset and an int16 storage option for clips.

3. **blocking: macOS and Linux go/no-go comes after Howler is deleted.** Tauri ships WKWebView (macOS) and WebKitGTK (Linux). Neither was run in real time on hardware (RFC Open questions; README "Still unverified"). *Change:* make M1 exit criteria include a 30-minute real-device soak with zero underruns on Windows/WebView2, macOS/WKWebView and Linux/WebKitGTK, plus one low-end machine. Keep `howlerBackend.ts` behind 0098 until that passes.

4. **major: sample-accurate clock is unspecified.** postMessage applies within 1 quantum at p50 but 3–5 at the tail and up to about 70 ms in the echo maximum (`messaging/README.md` §2–4). "Play-at-time" needs a defined time base. *Change:* the command format carries an audio-frame timestamp. The main thread maps game time to audio frames with `getOutputTimestamp`/`currentTime` plus a fixed scheduling lookahead (about 2 frames), and late commands run at once and are counted.

5. **major: the voice cost is optimistic.** The spike uses linear-interpolation resampling and 4 one-second sources (`core/src/lib.rs:148–160`), so all 256 voices read about 750 KB of hot data on a CPU with a very large L3. Real content reads hundreds of distinct clips; a quality resampler (polyphase/sinc) costs 3–10× linear. *Change:* re-measure M1's budget with a windowed-sinc or 4-point resampler and at least 64 MB of distinct clip data before freezing 0.35 ms.

6. **major: the size budget can't hold M3.** The core is "≤ 300 KB", but `spatial/` wasm is already 309–406 KB, "mostly rustfft's planners". SADIE II HRIR data (hundreds of directions × 256 taps × 2 ears) is not in any budget. *Change:* split budgets (mixer ≤ 150 KB; spatial module, lazy; HRTF data as an asset with its size stated) or plan a fixed-size hand-rolled FFT.

7. **major: 0074 is called "in force" but it is titled and decided "with Howler".** *Change:* list 0074 and 0098 as *amended* in the header (0098's open question about event-style playback is answered by M2), and update `implementation-status.md` rows.

8. **minor: "Identical output in every browser engine, and on native."** Only RMS was compared. Native uses the platform's `libm`, wasm a compiled-in one. *Change:* "bit-identical across wasm engines; within a tolerance on native"; golden tests use a tolerance.

9. **minor: 0133 placement is left open but affects layout now.** Occlusion depends on Rapier, which is physics' concern. *Change:* decide now. `AudioSource` and the core stay in the engine; occlusion takes a ray-query interface, not Rapier.

## Failure modes and resiliency

- **Wasm trap or panic in `process()`.** Chromium fires `onprocessorerror` and the node goes silent permanently. *Handling:* `panic = "abort"` plus a trap counter. On error, recreate the node and core, then replay from the main-side voice table (which is why issue 1's ownership matters). Rate-limit to N restarts, then fall back to silence and report.
- **Device change or loss** (headphones unplugged, Bluetooth switching to a 16/24 kHz profile, sample-rate change). The context may change `sampleRate` or go `"interrupted"` (WebKit). *Handling:* state the context-rate policy (run at the device rate and resample clips at load, or force 48 kHz), and handle `onstatechange`/`devicechange` by rebuilding.
- **Tab backgrounding and minimised Tauri windows.** rAF stops, so command batches stop; ramps freeze mid-flight, and one-shots queued for "next frame" never fire. *Handling:* a project setting (mute, pause or keep playing in the background); the worklet completes ramps to target on starvation; streams pull-driven by the worklet, not by worker timers.
- **Underruns are invisible.** There's no worklet clock. *Handling:* compare `currentFrame` progress against `Date.now()` per render period, count underruns and late commands, and surface them in the M5 profiler from M1 on.
- **Decode errors and corrupt or truncated streams.** symphonia errors mid-stream. *Handling:* decoder posts typed errors; the voice fades out; a warning names the asset path once.
- **OOM or a failed `memory.grow` on the audio thread.** *Handling:* refuse the load, keep playing, report.
- **The 250–490 ms first-`AudioContext` cost on a user gesture.** It's a visible hitch on a click. *Handling:* create the context on `pointerdown` and keep the core warm; measure this on WebView2 specifically.
- **Multiple Worlds and editor previews.** *Handling:* one `AudioContext` and one core per page; Worlds are namespaces in it, so clips aren't decoded twice.

## Performance and load

- **Single-run, high-end, busy-machine data.** `messaging/` states "One run per cell on a busy desktop"; budgets come from averages on a Ryzen AI Max+ 395. Report p99/p99.9/max over ≥ 5 runs, and run on a 4-core laptop CPU on battery.
- **The "≥50% headroom" premise fails at 2–3× slower CPUs.** 1.3 ms × 2.5 is over the 2.667 ms quantum. Chromium on Windows renders about 4 quanta back to back per 10 ms callback (`messaging/README.md` §2), so a spike in one quantum eats the others' slack. Define presets by *measured device class*, and add runtime adaptation: lower the mixed-voice cap when work units per quantum exceed a threshold.
- **Worst case aligns.** Non-uniform convolution maxima reach 1.67 ms in Node wasm (README round 2). Two reverbs whose tail work lands in the same quantum could be about 3.3 ms. Require phase-staggered tail scheduling across convolvers, and budget the worst case, not the average.
- **GC.** postMessage caused a 0.55–0.86 ms scavenge on the worklet at 1,024 voices (`messaging/README.md` §6). Ping-pong the transferred buffers back to main to cut main allocation; accept that worklet deserialisation still allocates, and prefer the SAB ring whenever isolation is available (Tauri can always set COOP/COEP).
- **Unbudgeted items:** limiter, LUFS metering, Doppler pitch, per-voice occlusion filters, M2 layered/blend containers (which multiply voices), and M4 stems. Add a line for each, or an explicit reserve.
- **Main-thread 1 ms occlusion is loose** against a 16.7 ms frame that rendering already contests; at 120/144 Hz it's 12–14%. Express it as a fraction of frame time.
- **The CI benchmark at 20%** on shared runners is noise-prone. Use instruction counts (a work-unit counter, or `wasmtime` fuel) instead of wall time.

## Cheaper alternatives or simplifications

- **M1 on plain Web Audio, the core from M3.** `AudioBufferSourceNode.start(when)` and `AudioParam` automation *are* sample-accurate, contrary to the Alternatives text, and virtual voices and priority are main-thread bookkeeping that works over any backend. This would ship M1's user-visible features at far lower risk. Honest assessment: it defers, not avoids, the rewrite, and it would build the bus graph twice. I'd still recommend the core, but correct the Alternatives claim and justify it on HRTF consistency, custom DSP, determinism and the native path.
- **Drop M6 from this record.** Exclusive mode takes the device from every other app (`wasapi/README.md`); it's a niche. Keep it as a note, not a milestone.
- **Ship `simd128` only.** Every target engine accepts it (`spatial/README.md`); no dual build.

## Design refinements

- The command format is a versioned, fixed-layout struct (opcode, voice id, frame timestamp, payload), shared by postMessage and the SAB ring, and generated from one Rust definition.
- Parameter ramps use the measured frame dt as their length, so 30 Hz or hitchy frames don't zipper.
- Pass a compiled `WebAssembly.Module` to the worklet where supported, instead of synchronously compiling bytes on the audio thread.
- When the editor (Tauri) can set COOP/COEP, it uses the ring, and the web export documents the headers as recommended.

## Questions for the author

1. Who owns playhead and voice lifetime, and how does `AudioVoice.playing` stay correct?
2. What is the clip memory ceiling per preset, and what happens at it?
3. Context sample rate: forced 48 kHz or device rate?
4. Which low-end machine defines the "low" preset, and when is it measured?
5. Is there a rollback point if macOS real-time playback fails after Howler is deleted?
6. Why keep the `decodeAudioData` fallback if it can't stream or seek: is a two-path loader worth 840 KB?
