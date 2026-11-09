
## Senior → architect (round 1)

Contracts `api-and-models.md` assumes from `architecture.md`; please confirm or change them:
- Status period: the worklet posts a STATUS block every 6 quanta (16 ms), independent of game frames. The ADR says "once per frame".
- Lookahead: two game frames of the writing frame, floored at 2 quanta. The ADR text is ambiguous.
- Arena: reserved at `myco_audio_init`, never grown in `process()`; clip memory is copied through a 1 MiB inbox, at most 256 KB per quantum.
- Replay after a rebuild: `RESET` then the main-thread voice table, with loop, stream and long voices resuming from the last status playhead.
- The core's adaptive cap demotes the lowest `score` voices and reports them as `demoted`; the main thread keeps virtual-voice selection otherwise.
- Pre-unlock queue: one-shots 32 / 1 s; `AudioSource`-owned and looping voices wait without a timeout (my issue 4 on the ADR).
- Still needed from you: preset values, arena and ceiling bytes, the clock-map filter, minimum browser versions, and whether `workUnits` is per voice and bus.

## Architect → senior (round 1)

Full answers are in `architecture.md` §11.2, and the contracts are in §11.3. In short:
- **Agreed:** STATUS every 6 quanta (slowed to 48 when no batch has arrived for 250 ms); RESET plus table replay; core demotion by `score`; your locked-voice rule (issue 4); arena never grown in `process()`.
- **Changed:** the lookahead floor is **8 quanta**, not 2: clamp(2 frames, 1,024 frames, 100 ms), on top of a burst-lead term Λ (§4.3). Two quanta is inside postMessage's p99 tail.
- **Values:** presets and memory in §5.1–5.3 (int16 default; default preset 128/4,096 voices, arena 16 MB growing to a 128 MB ceiling). `rampFrames` and the clock filter are in §4.3. Minimum versions in §9 are still "confirm in A0.6". Work units: totals per quantum (last and max); categories only on request.
- **Wire and ABI asks (C1–C11):**
  - imported memory plus `myco_audio_adopt_arena` (soft trap recovery that keeps clips);
  - `clip_chunk_ptr` (one copy instead of two);
  - STATUS fields `mixedCap`, `minSlackFrames`, `loadPermille`, `underrunFrames`, `traps` and arena bytes, plus clip-event and stream-event sections (the loader can't otherwise tell a clip is resident);
  - underruns counted from frames against `Date.now()` drift, since `currentFrame` never gaps;
  - direction instead of `pan` in voice records;
  - an `owner` World field in the voice table;
  - STREAM_OPEN `epoch` and `startFrame`, and a STREAM_CREDIT kind; worker-sourced clip chunks;
  - the first STATUS doubles as READY;
  - a clip-memory ceiling and clip-format setting;
  - the frame's rAF timestamp for stamping.
