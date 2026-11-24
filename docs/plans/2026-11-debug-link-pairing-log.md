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
  `M`–`Y` LAN room, `Z` hosted room. 0403's "the first character says what the rest holds" still holds. A LAN room
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

## W1b

| Task | Model | Agent time | Result |
|---|---|---|---|
| L9 glue crate | Sonnet | 9.0 min | `native/debug-link-tauri` (`DebugLinkListeners` state; `commands::{myco_debuglink_listen_range, myco_debuglink_listen, myco_debuglink_send, myco_debuglink_close}`), registered by `src-tauri` and `src-studio-tauri`; `src-tauri/src/debug_link.rs` moved into it |
| S0 integration smoke | Sonnet | 7.2 min | `src/plugins/audio/editor/debugLink/linkSmoke.test.ts`, 3 cases, passed 3 runs of 3 |

- **L9:** commands, not a plugin (C8). No capability changes: the shells use no app manifest, so app commands aren't
  gated (the editor listed none before either). `cargo check`: src-tauri 1 m 13 s, src-studio-tauri 56 s on the
  shared warm cache (`src-tauri/target` of the main checkout); after the merge, 3.6 s and 2.8 s. `ws-listener`:
  12 cargo tests pass (L9's report said 0; it read the doc-test line). The crate has no tests of its own; its
  commands are thin and need a real Tauri run (OP1). A `Cargo.lock` sits beside the crate, as beside `ws-listener`.
- **S0:** a headless Engine with the real `audio` topic and the capture tests' fake core backend:
  1. the build listens, a `ToolConnector` pairs by token, records a take over the link (start, mark, stop),
     uploads it, and the bytes equal `Audio.take.save()`'s;
  2. a tool listener and a build connecting out with a code;
  3. a tokenless same-machine build accepted by the tool.
  The take is 37,306 bytes: one chunk, one frame. **Multi-chunk uploads aren't in the smoke**, only in the unit tests
  (`upload.test.ts`, `takeRoundTrip.test.ts`); S1 (W2) uploads a real exported game's take.
  The helper yields with `setTimeout(0)` between rounds because `take.start` loads modules on macrotasks; the link's
  time stays on an injected clock.
- **Checks after both merges:** typecheck: the 2 baseline errors only; the debug-link, audio-link, player and plugin
  suites: 204 passed, 6 skipped, 3 failed (the baseline `plugins.test.ts` scans).
- Estimate drift: W1a + W1b planned 18 task-days (estimate); agents took 1.7 hours of wall time in all, plus
  coordinator merging and checks. Agent time doesn't map onto the plan's person-days; the estimates stay as written.

## W2

C7 (coordinator, `69d3db2aa`): `EditorDebugLink.connect()` (a lazily made `ToolConnector`, polled with the listener;
its peers join `builds` without a prompt) delegating to `connectFlow.ts`; `servePlay()` delegating to `playBuild.ts`;
`BuildsMenu` `onConnect` and `playSlot`; `ConnectDialog` props; `studioLink.ts` signals.

| Task | Model | Agent time | Result |
|---|---|---|---|
| U1 Connect dialog and flow | Sonnet | 8.4 min | 11 flow tests; 12 dialog stories and 3 menu stories with `play` (not run, below) |
| U2 player side | Sonnet | 4.9 min | listener start, overlay (F8), `?debug-code=` / `__mycoDebugCode` |
| U3 Play as a build | strongest | 10.1 min | choice (b): Play's own `startBuildListener` on 7791..7799 (the engine's listener refuses tool-role pairs); wired in `link.ts` |
| U4 Studio link | Sonnet | 5.8 min | its own link and preferences (`myco.studio.debugLink`), menu, prompt, a small settings dialog |
| U5 Studio Profiler and Take | strongest | 14.5 min | Follow build (remote `LiveHost`); Take: Start take, Mark, Stop, Save into takes/ |
| U6 export flags, vendored crates | Sonnet | 7.4 min | `--debug-listen`, `--debug-lan`, `--debug-port`; crates under `<out>/src-tauri/vendor/` |
| U7 OP1 walker | Sonnet | 8.6 min | 4 walker cases over a real WebSocket, full speed and paced; OP1 text |
| U8 Mixer on the link | Sonnet | 5.8 min | edits go local and remote; refusals in the Mixer's status bar |
| S1 browser smoke | Sonnet | 6.5 min | spec passed first time (8.5 s) |

**Coordinator fixes and additions after the merges.**
- `49cfeba0e`: S1's Node-side fixture imports the engine's debug-link client, which brings engine files into
  `tsconfig.node.json`; it gains the engine's libs (`DOM.Iterable`, `ESNext.Decorators`), `vite/client` and the
  css-tree parser declaration. Typecheck back to the 2 baseline errors.
- The editor's builds menu mounts U3's `PlayBuildSlot` in U1's `playSlot`.
- U4's `startStudioDebugLink` took options its own comment called "for tests"; removed. The tests register the
  loopback as the listening `websocket` transport and mock the platform check and the native module, so they run the
  app's path.
- MIXOP origin `debugLink: 5` (A3 and U8 recommended it): a tool's `mix.op` applies inside
  `withMixOpOrigin("debugLink")`. The out-of-range fuzz case moves to 6; the 0171 design's record table names the
  value. Test fails before.
- The Take screen's empty copy mentions recording from a connected build (within its 90-character line).
- `docs/wiki/guide/debug-link.md`: flags, pairing, the Studio's use, the network checklist and OP1 with the real labels.

**Wave-end checks** (against the baseline).
- Vitest: 6 failed, 12,038 passed, 16 skipped (1,159 files): all baseline.
- Typecheck: the 2 baseline errors.
- `build:editor` passes. `files.json` `debug`: 6 chunks (overlay, host, records, the Tauri listener, two topics).
- e2e (Chromium): 5 failed, 266 passed: the 4 baseline specs and `three-d` model import settings, which passed 7 of 7
  on a rerun (flaky). S1 (`@slow`) passed separately.
- **Stories not run.** `npm run test:stories` can't start on this machine: Vitest's browser server binds port 63315,
  inside a Windows excluded TCP range (63278–63377, `netsh interface ipv4 show excludedportrange protocol=tcp`), and
  overriding `browser.api.port` didn't move it. The excluded range is a system setting (Hyper-V/WinNAT reserves it,
  it moves after `net stop winnat` or a reboot); left to the owner. U1's and U5's stories' `play` functions are
  unverified until then.

**Open for M1's exit and later.**
- OP1 on real machines (the first real Tauri run of the listener, the shared commands crate and a vendored debug export).
- The editor and Studio have no source for this machine's network addresses (`interfaces: () => []`), so a native
  tool completes codes from the 192.168 fallback, and Play shows no LAN code. Interfaces need a small native command
  (D1 touches the same crate in M3).
- No UI prompt for a tokenless tool reaching Play from another machine (it's refused with `no-token`).
- A paused Play answers no tool until it resumes (U3).
- `captureLost` reason, the capture queue's limit, `plugins.test.ts`' scans on Linux/CI: still open from W1a.

## M2 (waves 3 and 4) and N1

R0 (coordinator): ADR 0404, Accepted under owner decision O7; 0403 marked amended.

| Task | Model | Agent time | Result |
|---|---|---|---|
| N1 network interfaces (an M1 fix) | Sonnet | 12.0 min | `myco_debuglink_interfaces` (std only: the default-route adapter plus loopback); wired into the player, `EditorDebugLink` connect and Play, debug desktop exports |
| R1 rendezvous server and client | Sonnet | 8.7 min | 53 tests; limits as §7a, plus a 10 s join deadline |
| R3 deployable rendezvous | Sonnet | 5.7 min | `startRendezvous` (attach to an http.Server or standalone), `dist/rendezvous/rendezvous.mjs` 159 KB |
| R7 settings | Haiku | 6.2 min | Rendezvous URL and ICE servers preferences; Export dialog Listen and LAN |
| R4 rendezvous on every host | Sonnet | 22.4 min | dev-server plugin; debug `serve.mjs` carries `rendezvous.mjs` and binds 0.0.0.0 with `--debug-lan`; native listeners route `/myco-rendezvous` on their own port (a small Rust change: accept events carry the path); `--debug-rendezvous` |
| R5 room-code flow | strongest | 20.6 min | `rooms.ts`: a page that can't listen opens a single-use room and shows the room code; tools join by code; one token checked by the rendezvous and again by the build's gate; the reverse (`offerRoom`, `?debug-code=`) |
| R8 Offer a room (added) | Sonnet | 5.1 min | the builds menu's Offer a room dialog (editor and Studio) |
| R6 two-browser e2e | Sonnet | 4.5 min | spec written; coordinator fixed and moved it (below); OP2 text |

**Owner-facing fix before OP1.** Nothing passed native endpoints their own network address, so a listening desktop
game would have shown "type the address" instead of a code (found while starting M2). N1 fixes it. Limit: without a
new crate only the default-route adapter is seen; a second adapter or a VPN can put the wrong prefix in the code
(typing the full address always works).

**Coordinator work after the merges.**
- R7's browser-editor message applied to `editorLink.ts` (it lives there, not in R7's files).
- `native/debug-link-tauri/.gitignore` (its `target/` showed as untracked).
- Wiring R4 left to the single-writer files: `vite.config.ts` mounts the rendezvous plugin and serves the bundle;
  `vite.editor.config.ts` copies it beside the editor (`rendezvousFile()` in `vite.shared.ts`); `build:editor` builds
  it first; `build:rendezvous` script.
- Desktop games host the rendezvous: `startBuildListener` makes its own transport, so the player names
  `TAURI_HOSTING_TRANSPORT` (registered beside "websocket") instead of wrapping one. Test added.
- R6: its first run timed out in cleanup. The test's own rendezvous stand-in waited on upgraded WebSocket sockets that
  `closeAllConnections` leaves open; the pairing itself had worked (screenshots: "1 build", the overlay hidden). Then
  the stand-in was removed and the spec runs on the export's own `serve.mjs` rendezvous on a free port of 7790..7799
  (`exportAndServe` takes a port).
- Running it that way found a real bug: a listen-only export wrote the default `debug.link`, so the page dialed
  `ws://localhost:7790` every 2 s beside its room. Listen-only exports now write no link (the manifest type's `link`
  is optional); two export tests updated to the intended behaviour.
- The builds menu showed a room build's address with its token (`…#room=174&token=136029`); labels now say
  "<host>, through a room". Test added.

**Checks.**
- Vitest: 6 failed, 12,117 passed (1,165 files): all baseline. Typecheck: the 2 baseline errors.
- `build:editor` passes and ships `rendezvous/rendezvous.mjs`. `files.json` `debug`: 7 chunks (adds `rooms`).
- e2e (Chromium): 7 failed, 264 passed: the 4 baseline specs; `statuslog`, `editor` scene-camera icon and `selection`
  passed or failed a different case on rerun (flaky).
- `@slow`: `debuglink-webrtc.spec.ts` (two real Chromium pages, a room code over WebRTC through the export's own
  rendezvous, a wrong code refused) 37.9 s; `debuglink-audio.spec.ts` 7.8 s. Both pass.
- `cargo check` src-tauri and src-studio-tauri; `cargo test` ws-listener and debug-link-tauri: pass.

**Not verified / open.**
- OP1 and OP2 on real machines.
- A take over WebRTC end to end in a browser (S1 covers the upload over a WebSocket; the units cover the WebRTC
  transport and rooms). WebKit/Safari WebRTC (Playwright's Windows WebKit has none).
- Stories (U1, U5, R7, R8): `test:stories` can't start here (Windows excluded port range).
- `captureLost` reason; the capture queue's limit; `plugins.test.ts` scans on Linux/CI; a prompt for tokenless tools
  reaching Play; a paused Play answers no tool.
- M3: discovery (D1, D2), Android games (D3), the guide's final pass (D4).

## M3 review (2026-11-23): discovery and Android games

**Run.** A discovery contract (`tauriDiscovery.ts` types and stubs, `949c65c9f`) let D1, D2 and D3 run in parallel on
Sonnet, each in its own worktree, all merged without conflicts. The coordinator wired D3's plugin into the export
(D1 owned `desktop.ts` that wave) and wrote D4.

**Built.** D1: `native/debug-discovery` (mdns-sd 0.22), four `myco_debuglink_*` discovery commands, both shells, the
crate vendored into debug desktop exports, listening desktop games with LAN on advertise. D2: Nearby builds in the
Connect dialog (`discovery.ts`); a picked build connects to its own address with the typed code's token. D3:
`native/tauri-plugin-myco-multicast` (Android Wi-Fi multicast lock, no-op on desktop); the listener crates and the
plugin `cargo check` for `aarch64-linux-android` unchanged. Coordinator: the plugin vendored with its Android files
(`DEBUG_MULTICAST_PLUGIN`), its Cargo line and `.plugin(...)` in debug exports; the player reports `android` on a
phone; guide sections for Nearby builds, Android and OP3.

**Found in review.**
- mdns-sd removes a service on a goodbye or when its PTR record expires (75 minutes; the TTL setter is crate-private),
  and Tauri doesn't drop managed state on exit, so a closed game would have stayed listed for over an hour. The
  advertise command now withdraws the advert when its window is destroyed, and `unadvertise` waits up to 500 ms for
  the goodbye. A crashed game still lingers (noted in the guide).
- `ConnectDialog.tsx` had a Windows-1252 ellipsis byte (0x85) that broke `build:editor` ("stream did not contain
  valid UTF-8"). Typecheck and Vitest don't read it that way; only the build caught it. Fixed.
- D1's guide text said the editor and Studio advertise; only listening games do. Corrected in the guide.

**Checks.**
- Vitest: baseline failures only (once with cargo running: several timing and hash tests failed and passed when rerun
  alone; `loudnessSource.test.ts` timed out under load, passes alone twice). Typecheck: the 2 baseline errors.
- `cargo test`: ws-listener 13, debug-discovery 7 with `--include-ignored` (advertise, browse, goodbye on this
  machine's multicast: passes on Windows), debug-link-tauri 3. `cargo check` src-tauri, src-studio-tauri, and a
  generated debug desktop export of `samples/flappy` (vendored crates and plugin compile together, 2 min 27 s).
- `build:editor` passes; player `files.json` `debug`: 9 chunks (adds `tauriDiscovery`, `config`).
- No e2e change in M3 (discovery is native-only; the dialog's browser case renders no section).

**Not verified / open.**
- OP1, OP2, OP3 on real machines. A Gradle build of the plugin (its AGP/Kotlin versions were written from memory),
  the lock on a phone, and the export's SDL3 gamepad module for Android.
- Stories for the dialog's new states (`test:stories` can't start here).
- A reloaded game page advertises again beside its old advert until the window closes.

