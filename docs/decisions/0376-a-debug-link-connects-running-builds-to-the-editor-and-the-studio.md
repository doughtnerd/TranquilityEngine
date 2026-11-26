# 0376. A debug link connects running builds to the editor and the Studio over the engine's transports, separate from game traffic

- **Status:** Accepted, amended by 0378 (export `debugLink` options, lazy topics; no shipped editor listens yet); partly superseded by 0403 (Endpoints and Remote devices: either side listens, short-code pairing, a WebRTC transport)
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0033, 0333, 0373; audio 0341 (the Studio has no live link in v1), audio 0348 (takes)

## Context

Animation's live debugger (0373) needs to inspect a running build: a browser tab, a Tauri app, or a game on another machine. The Audio Studio (audio 0341) was built with "no live link" in v1 for the same reason.

**What exists:**
- The engine's transports (`src/engine/net/Transport.ts`: loopback and WebSocket, polled once per frame, reliable and unreliable channels).
- A WebRTC data-channel transport for unreliable messages (0333).
- The game session (0033) carries replication, RPCs and inputs under packet budgets.

The owner expected a dedicated debug channel and noted WebRTC could help over a network.

## Decision

We will add a **debug link**: its own protocol and session, built on the engine's transport interface, never inside a game session.

- **Endpoints:**
  - the editor, and the Studio when it runs, **listen** (WebSocket on `localhost`, and on the LAN when enabled in Preferences);
  - a running build **connects** when it was exported or launched with debugging on (`game.json` `debug: { link: "ws://host:port" }`, a `--debug-link` flag for desktop builds, or the editor's own Play).
- **Remote devices:** when WebSocket can't reach (NAT), the link uses the WebRTC transport (0333) with the same signalling path the game uses. The protocol doesn't change.
- **Protocol:**
  - a versioned envelope `{ topic, kind, payload }`;
  - topics are owned by plugins and registered through the runtime and editor contexts (`ctx.debugLink.topic("animation", …)`);
  - **subscriptions are pulled:** the tool subscribes to what it shows (one Animator's graph, one bus's meters), and the build sends only those, rate-limited per topic. Nothing is sent without a subscriber;
  - requests and replies use the reliable channel, live samples the unreliable one;
  - samples reuse each feature's capture and take records (audio 0348, 0373), so the link, captures and takes share one encoding.
- **Commands from the tool** (set an animation parameter, travel a state, solo a bus) are topic messages applied at the build's next frame start, like any input.
- **Security:**
  - the link exists only in builds with debugging on, and a release export without it contains none of its code;
  - LAN listening is off by default;
  - a connecting build shows its name, and the tool asks before accepting a non-local connection.
- **Code:**
  - `src/engine/debugLink/`: session, envelope, topic registry; it uses `net/transport/`, never `net/session.ts`;
  - `src/editor/debugLink/`: listener, accept prompt, connected-builds menu;
  - the Studio reuses both.

## Alternatives considered

- **Inside the game session.** Debug traffic would compete with replication budgets, exist only in networked games, and follow the server-authoritative topology. A tool needs to reach every build, networked or not.
- **Chrome DevTools protocol or a custom HTTP server.** Doesn't reach Tauri builds on other machines uniformly, and is a second networking stack.
- **Takes only (offline).** Already available (audio 0348, 0373), but they can't answer live questions or tune values in a running game.

## Consequences

**Positive**
- One live link for animation, audio and future tools, on transports already maintained.
- Live tuning on real devices, including remote ones through WebRTC.

**Negative / costs**
- A second protocol on the transport layer to version and test.
- Builds with debugging on are larger and expose a port, mitigated by being off in release exports.

## Deprecates

Audio 0327's "v1 has no live link" becomes a choice the Studio can revisit on this link.

## Open questions

None.

## References

`src/engine/net/Transport.ts`, `src/engine/net/transport/`, 0333 (WebRTC), audio 0348 (take records).
