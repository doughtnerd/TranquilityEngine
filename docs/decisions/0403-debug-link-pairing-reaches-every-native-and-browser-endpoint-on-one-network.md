# 0403. Debug-link pairing reaches every native and browser endpoint on one network: either side listens, a short code pairs, WebRTC carries what a socket can't

- **Status:** Accepted, amended by 0404 (a room code carries its rendezvous's LAN address)
- **Date:** 2026-11-23
- **Deciders:** Chris Carlson
- **Supersedes:** 0376 in part (its **Endpoints** and **Remote devices** bullets: which side listens and how remote devices connect)
- **Related:** 0376 (the debug link), 0379 (desktop listener), 0333 (WebRTC datagram lane), 0348 (takes), 0341 (the Audio Studio), 0067 (paths on one port), 0041 (desktop export)

## Context

The Audio Studio needs a live link to running games and the editor: record a take from a game on another machine,
upload it, stream the live profile and adjust the mix (0348's open question). The debug link (0376) has the protocol,
topics and sessions; what it can't do is reach most of the places the Studio and games run.

**Endpoints to support**, each pair on one Wi-Fi network: the Studio (Tauri desktop, browser, Android) with a game
(Tauri desktop, browser, Android) or the editor (Tauri desktop, browser). Twelve pairs. By what they can do on a
network they are three kinds:

| Kind | Examples | Can listen? | Can open `ws://` to a LAN address? | WebRTC |
|---|---|---|---|---|
| **Native** | Tauri desktop and Android apps | Yes (`native/ws-listener`, 0379) | Yes | Yes, in the webview (WebView2, WKWebView, Android WebView); WebKitGTK builds often lack it |
| **Page on http** | `npm run dev`, an export's `node serve.mjs`, any LAN server over http | No | Yes | Yes |
| **Page on https** | A hosted browser Studio, a game on a web host | No | No: mixed content | Yes |

**What exists:**
- 0376 fixes the roles: the tool listens, the build connects out (`src/engine/debugLink/host.ts`, reconnecting every 2 s).
- Only the desktop editor listens (0379); the browser editor and every page can't.
- 0333's WebRTC lane rides beside a WebSocket: its signalling travels over that socket and reliable traffic never leaves
  it. It carries samples faster; it can't replace the socket.

**Constraints learned in discussion (2026-11-23):**
- A page can't accept connections, so two pages can never reach each other without something that listens.
- WebRTC needs an offer and an answer to cross before it connects; the code a person types (6–10 characters) is too
  small to carry either (about 100 bytes trimmed), so a short code can only name or locate the other side.
- Pages can't use mDNS, UDP or Bluetooth advertising. Web Bluetooth is Chromium-only and central-only.

## Decision

We will separate **who serves topics** from **who listens**, pair every connection with one short code, and pick the
transport from the two endpoints' kinds.

**Roles.**
- Topic roles stay as 0376 says: the build (a game or the editor's Play) serves topics; the tool (Studio, editor
  debugger) subscribes and commands.
- Connection roles are symmetric: **whichever side can listen does**. A native build listens and the tool connects, or
  a native tool listens and the build connects, as today. `DebugLinkSession` runs the same over either direction.
- Native endpoints with debugging on listen on `ws-listener`: the desktop editor and Studio (already, 0379), dev
  exports of desktop games, and Android builds (the crate has no Tauri dependency and builds for Android). The default
  port is 7790; when it's taken the listener tries 7791–7799, so the editor, the Studio and a game can share a machine.
- A game listens only when its export has debugging on (`game.json` `debug`), and on the LAN only with
  `debug.lan: true` (the export dialog's Debugging section, off by default), as 0376's security rules say.

**Pairing code.** One format everywhere: 10 characters of Crockford base32 in two groups (`3F9QK-7KD2X`), single use,
expiring after 5 minutes. The waiting side shows it: a game in a corner overlay while no tool is connected (F8 shows it
again), a tool in its Connect dialog. The first character says what the rest holds:
- **Address code**: the listener's private IPv4 address (its last two octets), its port offset (0–9) and a 30-bit
  token. The connecting side completes the address from its own private networks (a native endpoint's interfaces, an
  http page's own host) and tries each candidate; it can always type a full address instead.
- **Room code**: a rendezvous room and a token, for pairs where neither side can reach a listener on the other.
- The token is checked in the connection's first message. Five wrong tokens lock a listener's LAN connections for a
  minute. Connections from the same machine need no code, as today.

**Discovery.** Native listeners advertise `_myco-debug._tcp` over mDNS (DNS-SD) with their name, kind and platform;
native tools list what they find in the Connect dialog. Discovery fills in the address; a LAN connection still needs
the token from the code shown on the listening side. Android takes a multicast lock while advertising or browsing.
Pages can't use mDNS and type the code.

**Transports.**
- **WebSocket** when the connecting side can reach a native listener: native ↔ native, page on http → native. This is
  the existing `websocket` transport, unchanged.
- **WebRTC** otherwise: a new `webrtc` transport (`src/engine/net/transport/webrtc.ts`) with two data channels, one
  reliable and ordered (`myco-r`) and 0333's unreliable one (`myco-u`), on the page's own `RTCPeerConnection`. On one
  network it uses host candidates only (browsers' `.local` names included): no STUN or TURN. ICE servers are a
  setting for later use beyond the LAN.

**Rendezvous** (signalling for WebRTC). A small protocol: both sides connect out with the room code, the rendezvous
passes the offer, answer and candidates between them, and forgets the room once they connect or after 5 minutes. It
never carries debug traffic. One TypeScript implementation (`src/engine/debugLink/rendezvous/`) runs on any listening
`websocket` transport at path `/myco-rendezvous` (0067), served by:
1. any native Myco app listening on the LAN (editor, Studio, a debug game);
2. the server that served the pages: the Vite dev server (a plugin) and the `serve.mjs` of exports with debugging on, so
   an http page uses its own origin;
3. a hosted rendezvous at a URL in Preferences and `game.json` `debug.rendezvous`, the only path a page on https has.
   We ship it as a deployable Node service (the same code); none is configured by default.

**Which path each pair takes:**

| Pair | Path | Needs |
|---|---|---|
| Native ↔ native | WebSocket, either side listening; mDNS lists them | Nothing else |
| Page on http ↔ native | WebSocket to the native listener | Nothing else |
| Page on http ↔ page on http | WebRTC, signalled through the server that served the pages, or a native app's rendezvous | That server |
| Page on https ↔ anything | WebRTC, signalled through the hosted rendezvous | A hosted rendezvous |

For the twelve pairs: every pair works on one network with no internet when browser endpoints are served over http
from the LAN. A browser endpoint on https (a hosted Studio or game) needs the hosted rendezvous; without one it
exchanges takes as files (import, 0348).

**Code.**
- `src/engine/debugLink/pairing/`: code format, token check, address completion, path choice by endpoint kind.
- `src/engine/debugLink/rendezvous/`: server and client.
- `src/engine/net/transport/webrtc.ts`: the transport.
- `src/engine/debugLink/host.ts` gains listening; `src/editor/debugLink/` gains connecting and the Connect dialog,
  reused by the Studio (`src/studio/`), which starts a link of its own.
- `src-tauri` (and `src-studio-tauri`, and generated game apps): the 0379 commands, mDNS through the `mdns-sd` crate
  (pure Rust, MIT/Apache-2.0), the Android build of `ws-listener`.
- The player: the code overlay, in the debug-only chunks, so release exports still hold none of it.

## Alternatives considered

- **Keep fixed roles (0376).** A browser tool can never listen, so the browser Studio and browser editor reach nothing,
  and a game can't show a code for a tool to type.
- **The build always listens** (the first idea discussed). Browser games can't listen, and tool-listens already works
  between native endpoints.
- **A long code or QR carrying the WebRTC offer.** The answer still has to reach the offering side; the owner chose a
  short code and no scanner in the Studio.
- **Bluetooth for signalling.** Chromium-only, pages can only be centrals, native advertising differs on every OS, and
  many desktops have no Bluetooth.
- **WebTransport pinned to a certificate hash.** Lets an https page reach a native QUIC server, but the 32-byte hash
  makes a 55-character code, and support outside Chromium is uneven.
- **wss to a LAN address with a self-signed certificate** (accept the warning once) or **per-device public certificates**
  (Plex's `plex.direct`). The first is clunky and forgotten by some browsers; the second needs a domain and a hosted
  certificate service.
- **A relay that carries all debug traffic.** Takes and live samples would leave the LAN and cost bandwidth; the
  rendezvous carries only the handshake.

## Consequences

**Positive**
- Every Studio, game and editor pair on one network connects, with no internet when pages come from a LAN server.
- One code format and one Connect dialog everywhere; native tools find native builds without typing an address.
- The data path stays direct (socket or peer-to-peer); the rendezvous sees a few hundred bytes per pairing.

**Negative / costs**
- A second transport (`webrtc`) and a rendezvous protocol to version and test, plus listening on the build side.
- New native work: mDNS in three Tauri shells, `ws-listener` on Android, listeners in generated game apps.
- Listening in a game build exposes a port while debugging is on; mitigated by debug-only builds, LAN off by default,
  single-use tokens and lockout.
- A hosted rendezvous, if we run one, is a service to operate.
- Linux desktop builds whose WebKitGTK lacks WebRTC fall back to WebSocket only.

## Deprecates

- 0376's fixed roles (tool listens, build connects) and its use of 0333's lane for remote devices: replaced by symmetric
  listening and the `webrtc` transport. `--debug-link <address>` and `game.json` `debug.link` keep working as "connect
  to this listener".
- 0379's browser-editor "can't listen" message becomes "connect with a code".

## Open questions

- Whether Foxfire hosts a public rendezvous, and where.
- Uploading a whole take (up to 256 MiB) over the reliable path: chunk size against `ws-listener`'s 16 MiB message cap.
- Beyond one network (STUN/TURN): left to a later record.

## References

`src/engine/debugLink/`, `src/editor/debugLink/`, `native/ws-listener/`, `src-tauri/src/debug_link.rs`,
`src/engine/net/transport/datagramLane.ts`, `src/export/format.ts` (`serve.mjs`); 0333, 0348, 0376, 0379;
[`mdns-sd`](https://crates.io/crates/mdns-sd).
