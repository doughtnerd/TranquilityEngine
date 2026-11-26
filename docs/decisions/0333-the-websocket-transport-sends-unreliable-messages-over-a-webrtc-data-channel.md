# 0333. The WebSocket transport sends unreliable messages over a WebRTC data channel when both ends can

- **Status:** Accepted, amended by [0334](0334-snapshots-split-into-datagram-sized-parts-each-acked-on-its-own.md) (a tick's snapshot is split into datagram-sized parts instead of being capped at one), [0398](0398-each-websocket-path-numbers-its-unreliable-messages-on-its-own.md) (each path numbers its unreliable messages on its own, so a message too big for a datagram isn't dropped as stale)
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0033, 0035, 0067, 0102, 0121

## Context

Netcode (0033) sends two kinds of traffic: **reliable** messages (RPCs, spawns acknowledgements, the handshake) and **unreliable** ones (snapshots, inputs, snapshot acks). The `unreliable` channel promises only that a message that arrives isn't older than one already delivered. It doesn't promise delivery: inputs repeat the last few ticks, and snapshots are delta-coded against acknowledged baselines, so a lost one costs nothing but the next tick's freshness.

The only network transport today is WebSocket (`src/engine/net/transport/websocket.ts`, server `src/server/websocketServer.ts`). WebSocket runs over TCP, so "unreliable" messages are carried reliably and in order. When a packet is lost, TCP holds every later byte until the retransmit arrives, usually one round trip or more (head-of-line blocking). Under 1–2% loss, snapshots and inputs stall in bursts, and the client's interpolation buffer runs dry. 0033 named WebRTC data channels as the fix and deferred them because "they need a signalling server".

What's available:

- **Browsers** (Chrome, Firefox, Safari) and the Tauri webviews on Windows (WebView2) and macOS (WKWebView) have `RTCPeerConnection`. A data channel created with `{ ordered: false, maxRetransmits: 0 }` behaves like UDP: each message is sent once and may be lost or reordered. On Linux, many builds of Tauri's webview (WebKitGTK) leave WebRTC out.
- **Node** has no WebRTC, including Node 26. Its only related modules are an experimental, flag-gated `node:quic` and `node:dtls`. **node-datachannel** 0.33 binds libdatachannel (C++, about 2 MB per platform), ships prebuilt binaries for Linux (glibc and musl), macOS and Windows on x64 and arm64 as optional per-platform packages (as esbuild does), and includes an `RTCPeerConnection` polyfill with the browser's API. A Node loopback connect plus one round trip took 180 ms here.
- **QUIC** reaches browsers only through WebTransport. That needs a TLS certificate, and Node's server side for it is experimental.

Signalling is less work than 0033 assumed for client-to-server play: the client already has a WebSocket open to the server, so the connection offer and network addresses can travel over that socket.

Size matters for a lossy channel. A data channel message bigger than one packet (about 1,200 bytes) is split into pieces, and losing any piece loses the whole message. The snapshot budget is 64 KiB (`DEFAULT_MAX_SNAPSHOT_BYTES`), which is about 55 packets. Under 2% loss, two thirds of full-size snapshots would never arrive.

## Decision

We will make the existing `"websocket"` transport open a WebRTC data channel beside its socket when both ends can, and send unreliable messages that fit one packet over it. Everything else stays on the WebSocket, and a connection whose data channel never opens works exactly as it does today.

**One transport, upgraded in place.** There's no new transport name: bootstrap links, `connect(url, "websocket")`, the editor, lobbies and the dedicated server keep working unchanged. Each connection has a **datagram lane** (`src/engine/net/transport/datagramLane.ts`, browser-safe) that owns one `RTCPeerConnection` and one data channel named `"myco-u"`, created with `{ ordered: false, maxRetransmits: 0 }`.

**Negotiation never confuses an older peer.**
- A client that has `RTCPeerConnection` (and wasn't given `webrtc: false`) adds `myco-rtc=1` to the query of the URL it opens. The server's router already ignores the query (0067).
- A server that has WebRTC enabled and sees that query sends the **offer**; the client answers. A plain server never offers, and a plain client never asks, so neither ever sees a frame it doesn't know.
- Signalling travels over the WebSocket as **signal frames**: header flag `0x02`, a JSON payload `{ "t": "offer" | "answer", "sdp" }` or `{ "t": "candidate", "candidate", "mid" }`. The server sends signal frames only to a client that asked, and the client sends them only after receiving an offer.

**Sequenced unreliable frames.** Once a connection is negotiated (the server sent an offer, or the client received one), every unreliable message carries a 32-bit sequence number. On the WebSocket it rides in a frame with flag `0x04`: header, then the 4-byte big-endian sequence number, then the payload. On the data channel a message is the sequence number then the payload. The receiver drops an unreliable message whose sequence number isn't newer than the newest it has delivered, whichever path it came by. This is the rule the loopback already follows (one sequence per connection). Header bits not named here stay reserved, and a peer that sees one still closes the connection.

**Which path a message takes, per message, at each end on its own.**
- **Reliable:** always the WebSocket. TCP is already reliable and ordered. A second reliable path would need its own ordering against the first.
- **Unreliable:** the data channel when it's open, the message plus its sequence number fits `maxDatagramBytes` (default **1,100**, under one packet on an IPv6-minimum 1,280-byte path), and the channel's send buffer holds less than the unreliable backlog limit. Otherwise it goes over the WebSocket as today, with today's latest-wins backlog dropping. A message over the size limit is late, but never lost to fragmentation.
- Each end decides from its own lane's state. No message coordinates a switch.

**Fallback is silent.** A lane that hasn't opened within `connectTimeoutMs` (default 5 s), or whose peer connection fails, is closed, and its unreliable traffic stays on the WebSocket. The connection itself never closes because WebRTC failed, and closing the WebSocket closes the lane. The causes are corporate firewalls that block UDP, a webview without WebRTC, or a server without UDP ports open.

**Netcode sizes snapshots to one packet.** `TransportConnection` gains `readonly maxDatagramBytes?: number`: while set, an unreliable message up to that many bytes travels as one lossy datagram. The WebSocket connection sets it while its data channel is open, net of the sequence number. Replication (`net/replication/server.ts`) caps each connection's snapshot budget at the smaller of `maxSnapshotBytes` and that size, net of the session's message header. Its existing prioritisation sends unacked spawns first, then the ghosts unsent longest, and the rest next tick. A snapshot always carries at least one ghost, so one ghost bigger than the budget goes alone, over the WebSocket.

**The Node side uses node-datachannel.** `src/server/websocketServer.ts`, which is Node-only (0035), loads `node-datachannel/polyfill` lazily on the first connection that wants a lane. It hands the polyfill's `RTCPeerConnection` to the lanes of both its listening and its connecting connections, so a Node client (a bot, a test) gets WebRTC too. If the native module can't load, it logs once and every connection stays on WebSocket. Nothing under `src/engine/` imports it.

**Server options.** The transport option `webrtc` is `false` (off) or an object; the server default is on, with ephemeral UDP ports:
- `udpPort`: every connection's data channel on this one UDP port (libdatachannel's ICE UDP mux), for firewalls and containers. Default: an ephemeral port per connection.
- `publicIp`: the address put in the server's ICE candidates in place of its interface addresses, for hosts behind one-to-one NAT (AWS, GCP).
- `bindAddress`, `iceServers` (STUN/TURN URLs) and `maxDatagramBytes`.

The dedicated server gets `--udp-port N`, `--public-ip ADDRESS` and `--no-webrtc`. These apply to every server World, including those created at runtime (0067's listen defaults). Its periodic stats line counts the connections that have an open data channel.

**Client options.** `webrtc: false` turns the lane off. `{ iceServers }` sets STUN/TURN servers; none are needed for client-to-server play, because the server's address is public and the client makes the outgoing checks. Clients without `RTCPeerConnection` (Node's global `WebSocket` client, Linux webviews without WebRTC) just don't ask.

### Deferred

- Browser-to-browser hosting. It needs STUN, often TURN, and the lobby server (0068) relaying signal frames between two clients.
- WebTransport and QUIC, as a later transport behind the same interface.
- Splitting large snapshots into datagram-sized parts that each decode on their own, so one tick isn't capped at one packet.

## Alternatives considered

- **A separate `"webrtc"` transport.** Every place that names `"websocket"` (bootstrap links, the dedicated server's listen, editor fields, lobbies, 0102's in-page rule) would need to learn a second name, and the WebSocket fallback would still have to be built inside it. Upgrading the connection keeps one name and makes the fallback the default.
- **Reliable traffic on a second, reliable data channel.** Then reliable messages would have two paths that need ordering between them, and losing the data channel mid-stream would need a resend protocol. TCP already does this job.
- **werift** (pure TypeScript WebRTC). No native binaries, but several times the CPU per connection for SCTP and DTLS in JavaScript, and a smaller user base. It stays an option if a platform lacks a node-datachannel binary.
- **@roamhq/wrtc** (Chrome's full WebRTC stack). Audio and video we don't need, a much larger binary, and fewer prebuilt platforms.
- **WebTransport datagrams.** A simpler model than WebRTC (no connection offers or candidates), but Node's server side is experimental, it needs a valid TLS certificate or a pinned short-lived one, and WebKitGTK lacks it.
- **Keeping 64 KiB snapshots on the data channel.** Fragments make loss multiply: one lost piece in 55 loses the snapshot. Packet-sized snapshots are what Netcode for Entities and Glenn Fiedler's snapshot model send.
- **A new frame protocol version instead of flags.** The reserved bits exist so that a flag a peer doesn't know closes the connection loudly; with the query-string ask, the new flags are sent only to a peer that announced it understands them.

## Consequences

**Positive**
- Snapshots and inputs stop stalling behind lost packets for browser and macOS/Windows desktop players, with no change to game code, project files or the editor.
- Every connection keeps working where WebRTC can't: the fallback is the transport that runs today.
- The netcode's loss handling (input redundancy, acked baselines, latest-wins) finally gets the delivery model it was built for. The loopback's loss slider and real play now behave alike.

**Negative / costs**
- The dedicated server gains a native dependency (node-datachannel, about 2 MB per platform). A platform without a prebuilt binary falls back to WebSocket.
- Deployments must open UDP: one port with `--udp-port`, or ephemeral ports without it. Hosts behind NAT need `--public-ip`.
- On a data channel, one tick's snapshot is capped at about 1.1 KB per client. Worlds with many changing ghosts converge over more ticks, as the existing budget prioritisation already does at 64 KiB. Spawn bursts that don't fit go over the WebSocket.
- Each connection holds a peer connection (a DTLS session and SCTP state), which costs memory and some CPU on the server.

## Deprecates

0033's plan for a separate WebRTC transport with its own signalling server, for client-to-server play. The WebSocket transport's header comment ("truly unreliable delivery comes with the WebRTC transport") is updated.

## Open questions

- Should the editor's network panel and `Connection` nodes show which path a connection's unreliable traffic takes?
- Snapshot splitting (Deferred): is one packet per tick enough for the first games with large crowds?

## References

- `src/engine/net/Transport.ts`, `src/engine/net/transport/websocket.ts`, `src/server/websocketServer.ts`, `src/engine/net/replication/server.ts`
- node-datachannel: https://github.com/murat-dogan/node-datachannel (libdatachannel: https://github.com/paullouisageneau/libdatachannel)
- RFC 8831 (WebRTC data channels), RFC 8832 (DCEP), RFC 8445 (ICE)
- Node `node:quic` (experimental): https://nodejs.org/api/quic.html
- Glenn Fiedler, "Snapshot Compression" and "Packet Fragmentation and Reassembly" (gafferongames.com)
