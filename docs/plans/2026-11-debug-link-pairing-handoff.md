# Debug-link pairing: handoff

## 1. Where things are

- Records: ADR 0403 (Accepted 2026-11-23), 0376 (partly superseded), 0379 (amended), 0348 (takes).
- Plan files: [waves](2026-11-debug-link-pairing-waves.md) (task table, milestones, contracts, ownership, review
  fixes in §12), [tree](2026-11-debug-link-pairing-tree.md), [ground rules](2026-11-debug-link-pairing-ground-rules.md).
- Base: `master` at `4caf082db`. Nothing of the build is started; no integration branch exists yet; the plan files
  are committed (O8).

## 2. Read in this order

1. ADR 0403, then 0376 and 0348's **Decision** sections.
2. The waves plan §2 (state), §8 (contracts), §10 (tasks), §11 (decisions and owner items).
3. The tree's collision audit.
4. The ground rules.

## 3. Settled

- Either side listens; topic roles stay build-serves, tool-subscribes.
- One 10-character code, address or room kind; no QR, no Bluetooth.
- WebSocket where a socket reaches; the `webrtc` transport otherwise; rendezvous in native apps, page servers, or a hosted service.
- The audio topic: `capture` subscription (reliable channel), `take.start|stop|mark|upload` requests, `mix.op` commands.
- The connecting side sends a `pair` envelope first (protocol v2); a valid token skips the accept prompt.

## 4. Open

| Item | Recommendation | Deadline |
|---|---|---|
| O1 The Studio on Android (no build, no record); Android games are in scope (D3) | **decided 2026-11-23: later, outside this plan** | — |
| O2 Debug desktop exports write the two crates' sources into the generated Tauri project, compiled by the developer's `tauri build` like `gamepad.rs`; players get only the compiled app | **decided 2026-11-23: write the sources in** | — |
| O3 A public hosted rendezvous | **decided 2026-11-23: none; R3 ships the deployable service only** | — |
| O4 Hardware for OP1–OP3 | **decided 2026-11-23: desktop, laptop, Android phone** | — |
| O5 64 KiB bulk messages | **decided 2026-11-23: the WebRTC lane's existing ceiling** | — |
| O6 Build-side code entry by `--debug-code` / `?debug-code=` only | **decided 2026-11-23: accepted** | — |
| O7 A room code also carries the rendezvous's LAN address (amend 0403, R0) | **decided 2026-11-23: accepted**; R0 writes the record | before W4 |
| O8 Commit the plan files | **decided 2026-11-23: committed** | — |

Owner-only: OP1–OP3 on real machines.

## 5. Starting the build

1. Create `feat/debug-link-pairing` from `master`; run `npm run typecheck`, `npm test`, `cargo test` in `native/ws-listener` as the baseline.
2. W0: the coordinator does L0; start L1 (strongest model) with the waves plan §8 as its spec; review both before W1a.
3. W1a (pilot): start the L7, A1, R2 leads (strongest), the L8, A2, A3 leads (Sonnet) and leaves L2–L6 (Haiku) in one message; at most 3 running cargo or browser-mode tests at once.
4. W1b after W1a merges: L9 and S0. Provide one shared `CARGO_TARGET_DIR` for L9 (SDL3 builds from source; needs cmake).
5. At W1 end, run R2's real-peer Playwright probe in Chromium and WebKit; first review logged in `docs/plans/2026-11-debug-link-pairing-log.md`.
6. Disk: W1a runs about 12 worktrees; Rust tasks need a `target/` of a few GB each unless shared.
