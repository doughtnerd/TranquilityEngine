# 0417. The Studio speaks the audio debug-link topic through one client and one build session

- **Status:** Accepted
- **Date:** 2026-11-25
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0133, 0230, 0348, 0376, 0403, 0408, 0411, 0412, 0416

## Context

The build side of the `audio` debug-link topic is one module (`plugins/audio/runtime/debugLink/topic.ts`) dispatching to
`takeState`, `takeLive`, `upload` and `capture`. The tool side has no counterpart. Five Studio modules speak the wire
themselves: `screens/take/recordFromBuild.ts` (294 lines), `runtime/buildAudioSets.ts` (293), `runtime/liveTake.ts`
(141), `runtime/takePictures.ts` (77) and `screens/profiler/remoteLiveHost.ts` (319). Each calls
`peer.subscribe(AUDIO_TOPIC, …)` / `peer.request(AUDIO_TOPIC, method)` with an unchecked `as T` and decodes records itself.

- **Upload reassembly is written twice and has drifted.** `buildAudioSets.receiveUpload()` (a comment says it copies the
  recorder's) skips records that aren't `AudioLinkRecord.takeChunk`; `BuildTakeRecorder.receive()` decodes every record as
  a chunk, but is the only one that reports progress and can be aborted.
- **`take.frames` is sent from two places** (`BuildTakeRecorder.start()`, `sendTakePictureWidth()`), and take state arrives
  over two subscriptions (`take` in `BuildTakeRecorder.watch()`, `takeLive` in `followLiveTake`).
- **The per-build lifecycle is written four times.** `installBuildTakes`, `installProfilerLive`, `followLiveTake` and
  `installRecordingClock` are separate effects on `studioBuild`, each checking whether the peer changed, whether it closed
  (`linkClosed(closedReason)`), and keeping the old object when it failed or ended. "Is the build recording?" is tracked in
  `BuildTakeRecorder.state`, `liveTakeState`, `recordingSince` and `gameLink`. `lastBuildTake` lives in `buildTakes.ts`
  but `projectRecordings.ts` clears it. The Take (`index.tsx:302`, `:468`) and Profiler (`:111`, `:158`) screens repeat the
  live-or-file choice inline. The fixes in 3d8f4075 ("keep recorded takes open", "recorded levels on scrub") were here.
- **Take ownership on the build is one rule in five modules.** `capture/takeClaims.ts` (a global counter, 19 lines),
  `capture/takeControl.ts` (a global slot, 39), `debugLink/takeState.ts` (claims on open, decides when to back up),
  `topic.ts` (backs up only when `isTauri()`) and `capture/trigger.ts` (toasts "a copy is kept in app data" when
  `tauri && handedOff()`). The backup and the toast are decided apart: the toast can promise a copy that was never written.
- **A take is assembled from records twice.** `capture/takeFile.ts` goes through the capture reader and `readTakeMeta`
  (`engine/audio/take/reader.ts`), which checks every field. `debugLink/takeLiveStream.ts` (182) frames records itself
  (`CAPTURE_RECORD_HEAD_BYTES`, the length at offset 4) and builds `TakeMeta` by hand (`frames`, `seeded`, duration as
  `max(seconds, lastT)`). A rule added to `readTakeMeta` never reaches live takes.

## Decision

We will give the tool side of the topic one client, the Studio one session per connected build, the build one take
ownership module and both take readers one assembler.

- **Audio link client** (`plugins/audio/editor/debugLink/audioLinkClient.ts`). Made from a `DebugLinkPeer`. It offers typed
  take operations (start, stop, mark, frames), uploads as bytes with progress and abort, and follows for take state, the
  live take and live capture. It owns method names, record types, decoding and reassembly. Updates arrive through plain
  callbacks, each follow returning an unsubscribe function; the client uses no signals. A request the build refuses, or
  one cut by the link closing, rejects with one typed error carrying the reason. It absorbs `takeReceiver.ts` and owns
  `TakeLiveStream` (moved from the runtime half; only tools read live takes), whose follow hands out `Take` snapshots. The
  one upload checks the record type, reports progress and can be aborted for every caller. No Studio module imports
  `AUDIO_TOPIC` or `schema.ts` values after this. Tests use the existing loopback peers (`fakePeers.testSupport.ts`,
  `buildLinkTestSupport.ts`), so the seam has two adapters.
- **Build session** (`studio/runtime/buildSession.ts`). One effect on `studioBuild` creates it and disposes it when the
  build changes. It owns the audio link client, the take recorder, the live take, the capture follow, the take picture
  width and the recording clock, and exposes signals for one recording state (idle, recording since a time, ended) and the
  take on show (live or file), plus start, stop and mark. The Take and Profiler screens only read it. On dispose it hands
  its final take to `projectRecordings`, the one owner of kept takes (ADR 0412); `buildTakes.ts` no longer holds
  `lastBuildTake`.
- **Take ownership** (`plugins/audio/runtime/capture/takeOwnership.ts`). Replaces `takeClaims.ts` and `takeControl.ts`
  and answers: start or stop for a tool, whether saving is handed off, and the backup policy (Tauri only). The trigger and
  the topic both call it. The "a copy is kept" toast shows only once the backup write has succeeded; a failed backup gets
  its own toast. It value-imports no capture codec, so it stays out of `format-*.js` (ADR 0230); the existing static
  closure check in `audio-mix-d.spec.ts` guards that.
- **Take assembler** (`engine/audio/take/assembler.ts`). Takes start facts, decoded take records as they come, and an
  optional end section, and builds a `Take` by `readTakeMeta`'s rules. `takeFile.ts` feeds it from the capture reader;
  `TakeLiveStream` keeps only the link's concerns (offsets, holes, take ids) and splits bytes into records with a function
  from the capture format (`capture/format.ts`) instead of its own offsets. The engine imports no plugin code.

Glossary: **Audio link client**, **Build session**, **Take ownership**, **Take assembler**.

## Alternatives considered

- **Put the client in `src/studio/runtime/`** — the topic's schema lives in the Audio plugin; a client away from it leaves
  the format's owner with no tool-side counterpart. An editor half may import its runtime half (ADR 0133).
- **Client covers takes only** — `remoteLiveHost`'s capture follow would keep speaking the wire, and the next topic change
  would touch two places again.
- **Client exposes signals** — couples the client to the Studio's reactivity and makes its tests need it; the build
  session is the reactive seam.
- **Keep the effects, share a helper for the peer-changed / link-closed check** — removes lines but not the four copies of
  the recording state.
- **Toast as soon as saving is handed off (today)** — simpler, but can claim a copy that doesn't exist.
- **Assembler in the plugin's `capture/`** — it would sit beside the framing, but META rules belong with `readTakeMeta` in
  the engine, which the player and Studio both read.

## Consequences

**Positive**
- A schema change touches the build's `topic.ts` and the client only.
- Locality for the ADR 0408/0411/0412 rules: one session, tested without React or e2e.
- Two shallow singletons go; the toast and the backup can't disagree.
- META rules have one owner for file and live takes; `TakeLiveStream` loses about 60 lines.

**Negative / costs**
- A cross-module move: about seven Studio modules and their tests change, and `TakeLiveStream` moves halves.
- Visible change: the "copy kept" toast now waits for the backup write.

## Deprecates

- `plugins/audio/editor/debugLink/takeReceiver.ts` (into the client), `buildAudioSets.receiveUpload()`, the wire code in
  `recordFromBuild.ts`, `liveTake.ts`, `takePictures.ts` and `remoteLiveHost.ts`.
- `installBuildTakes`, `installProfilerLive`, `followLiveTake`, `installRecordingClock` (into the build session).
- `capture/takeClaims.ts`, `capture/takeControl.ts` (into take ownership).
- `TakeLiveStream`'s own framing and `TakeMeta` assembly (into the assembler and the format).

## Open questions

- None at proposal. Decided in review with the owner, 2026-11-25.

## References

- Architecture review, 2026-11-25 (candidates 1, 4, 5, 6).
- `src/plugins/audio/runtime/debugLink/topic.ts`, `schema.ts`; `src/engine/debugLink/topics.ts`.
