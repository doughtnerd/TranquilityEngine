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
