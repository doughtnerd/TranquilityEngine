# Debug-link pairing: build log

Plan: [waves](2026-11-debug-link-pairing-waves.md). Findings, numbers and estimate drift per wave review.

## Baseline (2026-11-23, `feat/debug-link-pairing` at `8fd4045af`, Windows 11, this worktree)

Failures that exist before any task of this build; wave reviews compare against them, not against zero.

- `npm run typecheck`: exit 2, from `vitest.stories.config.mts` (TS2345, TS2769 on the config call).
- `npx vitest run`: 8 failed, 11,812 passed, 10 skipped (1,137 files, 147 s), plus two thread test files that fail to load
  (`loudnessSource.thread.test.ts`, `profilerSource.thread.test.ts`):
  - `src/editor/uiDocumentEdits.test.ts` (Create menu);
  - `src/export/export.test.ts` (desktop project includes the gamepad module: the checked-out `Cargo.toml` has CRLF line
    endings, so the expected substring isn't found);
  - `src/plugins/plugins.test.ts` × 3 (import-direction scans return nothing on this checkout);
  - `src/engine/tests/babylonPreviewRouting.test.ts` (effect preview);
  - `src/engine/tests/webrtcTransport.test.ts` (one UDP port with `udpPort`);
  - `src/engine/localisation/message/check.test.ts` (plural categories).
  These look like Windows checkout effects (line endings, path separators, network), not code faults. Not fixed here.
- `cargo test` in `native/ws-listener`: 10 passed.

## W0

- **L0** (coordinator) `a866bfc37`: `DEBUG_LINK` covers `src/engine/debugLink/**` but the top-level `topics.ts`,
  `net/transport/webrtc.ts` and `src/player/debugOverlay*.ts`; new case in `src/player/debugStrip.test.ts` (5 passed).
- **L1** (strongest model) `dc99fa369`, merged `b2651986b`: contracts C1–C6. Protocol v2 with `pair` (10) and
  `paired` (11); a listener treats a `hello` before `pair` as a tokenless build, so the existing direction keeps
  working. `DebugTopic.channel`; `BuildListener`/`startBuildListener` (`host.ts`), `ToolConnector` (`client.ts`);
  pairing, rendezvous and webrtc stubs; the audio topic's `schema.ts` with working codecs, `upload.ts`/`mixCommands.ts`
  stubs; C6 config types with an `// L6:` marker. 1,444 lines added across 21 files. About 16 minutes of agent time.

### W0 review

- Typecheck after the merge: only the two baseline errors (`vitest.stories.config.mts`). Touched tests: 42 passed,
  45 skipped (the stubs' named cases for W1a), 0 failed.
- **Interpretation to note (code layout):** a whole first character can't hold the kind in 10 characters
  (16 + 3.3 + 30 bits for an address code), so the first character's *value range* is the kind: `0`–`K` address,
  `M`–`Y` LAN room, `Z` hosted room. 0380's "the first character says what the rest holds" still holds. A LAN room
  code's token is 20 bits (rendezvous address, port index and room take the rest); with single use, 5-minute expiry
  and the 5-tries-a-minute lockout, a guesser gets about 25 tries at a million values.
- **For L7 and A2:** upload throughput is the topic rate × 64 KiB (about 1.9 MB/s at 30 Hz) unless a sample may go out
  as several messages. A 32 MB profile ring uploads in about 17 s; the 256 MiB cap in about 2.3 minutes. L7 decides
  whether a reliable topic sends several messages a frame.
- `mix.op` carries its own name and bus tables, because interned ids differ between builds (A3 and U8 follow it).
- Estimate drift: none measured yet (L1 took one agent run; the pilot measures start in W1a).

## W1a (pilot)

Merged into `feat/debug-link-pairing` in this order: L6, L4, A2, L5, A3, L2, L3, L8, A1, R2, L7, then two coordinator
fixes. Every task branched from `adb05e55c`; every merge was clean.

| Task | Model | Agent time | Result |
|---|---|---|---|
| L2 code format | Haiku | 6.3 min | 11 tests, first pass |
| L3 token gate | Haiku | 7.4 min | 14 tests, first pass |
| L4 address completion | Haiku | 4.5 min | 9 tests, first pass |
| L5 path choice | Haiku | 5.5 min | 10 tests, first pass |
| L6 config parse | Haiku | 3.9 min | 15 tests, first pass |
| L7 either side listens | strongest | 19.3 min | 22 roles tests (20 ran only after L2/L3/L6 merged; all pass) |
| L8 port range, listener move | Sonnet | 7.9 min | 3 cargo tests (12 in the crate), listener tests |
| A1 audio topic | strongest | 9.5 min | capture, take control, dispatch |
| A2 take upload | Sonnet | 4.5 min | 23 tests; one rule break fixed (below) |
| A3 mix commands | Sonnet | 5.7 min | 10 tests |
| R2 webrtc transport | strongest | 9.9 min | 30 tests on a fake peer pair |

**Pilot measures.** Leaf first-pass success 5/5 (L2–L6), so no leaf kind goes back to its lead. Simplification for
this wave: the leads wrote their own tests instead of splitting test leaves, to keep the brief count down; it cost
nothing visible. Every agent started at `4caf082db` and reset to the brief's base as told: worktree agents don't
start at the integration branch. Briefs keep that instruction.

**Coordinator fixes.**
- `9270ad5e8`: A2's `upload.test.ts` (runtime) imported the editor's `takeReceiver`, which `plugins.test.ts` forbids.
  The runtime test now checks chunks directly; the round trip moved to `editor/debugLink/takeRoundTrip.test.ts`.
- `09da45c9b`: L7 tried ports one by one and assumed the one it asked for, but L8's native listener scans 7790–7799
  itself, so on the desktop a build's code could name the wrong port. `host.ts` reads the bound port
  (`tauriListenerPort`, which gains its real caller, so it is no longer a test-only export). Test fails before.
  `topics.ts` documents L7's reliable multi-sample rule (`RELIABLE_SAMPLES_PER_FRAME` = 8: about 15.7 MB/s at
  30 Hz; the 256 MiB take cap uploads in about 17 s).

**Wave-end checks** (against the baseline above).
- Vitest: 6 failed, 11,977 passed, 16 skipped (1,150 files): all in the baseline list. The `uiDocumentEdits` and
  `babylonPreviewRouting` baseline failures passed this time (flaky).
- `cargo test` in `native/ws-listener`: 12 passed.
- `npm run build` stops at its typecheck on the baseline `vitest.stories.config.mts` error. Cause: this worktree's
  `node_modules` and the parent checkout's both resolve vitest types. `build:editor` and `build:engine` pass.
  `dist/player/files.json` `debug`: 4 chunks (host, records, two topics); the pairing modules sit in the host chunk.
- e2e (Chromium): 6 failed, 266 passed. The same specs on `master` (`4caf082db`, temporary worktree) fail
  `audio-rhythm-latency`, `input-mapper`, `scene-tools` snap and `shadergraph` every node, so these are baseline.
  `selection` and `sound-lab-touch` fail differently from run to run (flaky); they pass on master. None touch the
  debug link.
- **R2 probe** (two real `WebRtcTransport` peers in one page, hand-carried signals, Vite dev server):
  - Chromium: both open; a 300 KB reliable message (fragmented on `myco-r`) and an unreliable one arrive intact;
    126 ms in all.
  - Playwright WebKit on Windows has no `RTCPeerConnection`: the transport refuses with its message. **R6 runs in
    Chromium only**; WebKit/Safari is signed on a Mac when wanted (the plan's risk, now confirmed).

**Open items for later tasks.**
- MIXOP origin: debug-link mix ops record as `editor`; a `debugLink` origin needs a capture-format enum value (A3's
  note). Decide in U8.
- `captureLost` carries no reason. A1 proposes an optional UTF-8 reason (empty = evicted); a `schema.ts` change, coordinator.
- A1's capture queue has no limit if capture data outruns the reliable rate. Revisit when S0 measures real rates.
- When Play stops, the capture feed just stops, with no record sent (A1). U5 should show it.
- `plugins.test.ts`' editor-half scan finds nothing on this Windows checkout (baseline), so it can't check the new
  `src/plugins/audio/editor/debugLink/` files. Run it on Linux/CI before M1's PR.
- A typed full address without a port takes the URL default (80 or 443), as `debugLinkAddress` already does (L4).
