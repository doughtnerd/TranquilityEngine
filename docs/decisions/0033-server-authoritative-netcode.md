# 0033. Server-authoritative netcode between client and server Worlds

- **Status:** Accepted, amended by [0062](0062-links-to-spawnable-worlds.md) (links apply whenever both Worlds exist)
- **Date:** 2026-11-02
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0005, 0011, 0013, 0016, 0017, 0024, 0032

## Context

0032 lets an Engine run isolated Worlds that communicate only through a transport. The owner wants multiplayer modelled on Unity's Netcode for Entities: server Worlds run on the server, client Worlds run on the client, and a host can run both in one process.

### How Netcode for Entities works (summary)

- **Worlds.** `ClientServerBootstrap` creates a server World, one or more client Worlds, and optional thin-client Worlds (input only, no rendering) in a single process, for hosting and testing. Systems choose Worlds with `WorldSystemFilter` (`ClientSimulation`, `ServerSimulation`, …). Recent versions make a client host default to a **single-world host**, one World acting as server and local client, with separate "binary" Worlds still available.
- **Server authority, fixed ticks.** The server simulates at a fixed `SimulationTickRate` (60 Hz by default) and sends at its own `NetworkTickRate`. `NetworkTime` gives each client its server-tick estimate, interpolation tick and RTT.
- **Ghosts.** Entities replicated from server to clients. A `GhostAuthoringComponent` marks a prefab, and `[GhostField]` marks replicated fields, with quantization and smoothing options. The server builds per-connection **snapshots**: delta-compressed against acknowledged baselines, prioritized by importance, filtered by relevancy, and fitted to a packet budget. Ghosts placed in scenes ("pre-spawned") are matched by a hash of the scene.
- **Two client timelines.** **Predicted** ghosts (usually the player's own) run gameplay code ahead of the server at the predicted tick. When a snapshot arrives, the client rolls back to it and re-simulates up to the present. **Interpolated** ghosts (everyone else) render a little in the past between received snapshots, by RTT/2 plus an interpolation buffer, and extrapolate briefly when data is late.
- **Inputs and RPCs.** Player input is a per-tick command stream (`IInputComponentData`, `ICommandData`). Each packet also carries recent ticks, so a lost packet doesn't lose input. RPCs (`IRpcCommand`) are reliable one-off messages that arrive as entities and are consumed by systems. Connections are entities with a `NetworkStreamConnection`.
- **Extras.** Lag compensation (a physics history the server can rewind for hit tests), host migration (via Unity Gaming Services), PlayMode tools (simulated latency, jitter and loss; thin-client count) and a network debugger.
- **Transport.** Unity Transport over UDP, plus IPC in-process for hosting and the editor.

### What's different for us

- We run in browsers and Tauri, so UDP isn't available to browser clients. The options are WebSocket (TCP, reliable and ordered), WebRTC data channels (unreliable or unordered available, needs signalling) and, later, WebTransport.
- We have no event system (0017): communication is data (components and buffers) or method calls.
- Gameplay code is mostly GameBehaviors (0007), not systems. Rolling back and re-running arbitrary behavior code is hard, because behaviors hold references and do side effects.
- Scene nodes already have stable ids (0013), which gives pre-spawned matching for free.
- The engine already runs headless in Node (the unit tests do), so a dedicated server can be Node or Deno with no browser.

## Decision

We will build server-authoritative netcode on Netcode for Entities' model, with these changes:

1. **Multiplayer is a layout of Worlds.** Client and server are Worlds tagged `client` and `server` (0032), joined by a link in the Worlds graph. A host is a server World and a client World in one Engine over a **loopback transport**: Unity's "binary worlds" host. A "Host" button in a game's menu creates the server World at runtime (0032's World handles), as Unity's `CreateServerWorld` does. This also gives multiplayer play mode in the editor (one server World plus N client Worlds, tiled). A single-world host is a later optimization.
2. **Transports behind one interface.** It offers reliable-ordered and unreliable-sequenced channels. Implementations, in order:
   - **Loopback**, in-process, with simulated latency, jitter and loss for testing.
   - **WebSocket**, which works everywhere; a Node server for dedicated hosting.
   - **WebRTC data channels**, unreliable, for browser-to-browser hosting and lower latency. Two browsers can't open a WebRTC connection to each other until they've exchanged connection offers and network addresses through a third party (**signalling**, usually a small WebSocket server). So WebRTC hosting needs a signalling server, and both arrive later, with matchmaking.
   The engine core never sees sockets.
3. **Replication is opt-in where data is declared.**
   - A `Replicated` component on a prefab or scene node makes it a ghost.
   - Data components (0017) are replicated by schema: their numeric typed-array fields serialize and delta-compress cheaply. A `quantize` option is available per field.
   - GameBehavior fields replicate when marked `@field(Number, { replicate: true })`, with the same options.
   - Spawning sends the prefab path. Scene-placed ghosts match by their scene node id.
   - **Per-World components**, after Netcode's client-only and server-only variants. The same scene loads into client and server Worlds (0032). Any component (a behavior, a data component, or an engine one like an AudioSource) can be limited to Worlds with given tags: `@behavior("game.EnemyAI", { worlds: ["server", "local"] })`, or a per-instance setting in the Inspector. In other Worlds, the component isn't created when the scene loads.
4. **RPCs are buffers, not callbacks.** `defineRpc("game.Chat", schema)` declares a message type. Sending pushes a record. On the receiving World it arrives in a buffer that systems and behaviors read each frame, tagged with its connection. This keeps 0017's "no event system". Connections appear as nodes with a `Connection` data component, created and destroyed by the netcode systems, so "a player joined" is a query, not an event.
5. **Input is a per-tick data stream.** `defineInput("game.PlayerInput", schema)` declares a per-tick input component for the local player's node. The client writes it each fixed tick. Packets carry the last few ticks redundantly, and the server applies each input at its tick.
6. **Two client timelines, phased in.**
   - **Interpolation** is the default for every replicated node. Clients render remote ghosts between snapshots with an interpolation buffer (`interpolationMs`) and short extrapolation when data is late.
   - **Prediction** comes second and starts in the data layer only. Data components marked `predicted` on owned ghosts are rolled back to each snapshot. Then the client re-runs the `fixedUpdate` systems tagged `predicted` from that tick to the present. GameBehaviors aren't re-simulated in this phase; they see the reconciled state. Predicting physics (Rapier snapshot and restore) is a later step.
7. **Ticks and time.** Networked Worlds run their `fixedUpdate` at the project's simulation tick rate. Each World's clock gains `tick`. Client Worlds also get `serverTick`, `interpolationTick` and `rtt`, readable as `Time.network` and `ctx.time.network`.
8. **Dedicated servers run on Node.** A headless server entry (`tranquility-server`) runs a project's server-tagged Worlds in Node with the WebSocket transport. Deno and Bun aren't targeted for now. It runs with no renderer, audio or input. Building and packaging it ties into game builds of projects (O14).
9. **Tools early.** Alongside replication, not after it:
   - Multiplayer play mode: a server plus N clients and thin clients.
   - Latency, jitter and loss sliders on the loopback.
   - A network stats panel: bandwidth per ghost type, snapshot size, RTT, mispredictions.

### Deferred

Lag compensation, relevancy and priority, host migration, single-world host, client-authoritative modes, the WebRTC transport with its signalling server, and (v2) matchmaking and lobbies.

## Alternatives considered

- **Peer-to-peer lockstep.** Low bandwidth, but it needs bit-exact determinism, and JavaScript floats with Rapier across browsers don't guarantee that. It also stalls on the slowest peer.
- **Client-authoritative state sync.** Simple, but easy to cheat and inconsistent under latency. It could be an opt-in mode for co-op games later.
- **Prediction of GameBehaviors from the start.** Matches Unity's ambition, but rolling back arbitrary scripts (references, side effects, audio, spawns) is the hardest part of netcode. Starting with data components and predicted systems keeps it tractable.
- **RPC callbacks (`onRpc(...)` methods).** Familiar, but it's an event system by another name (0017).

## Consequences

**Positive**
- One mental model: multiplayer is Worlds plus links in the Worlds graph, and the same project runs hosted, as a dedicated server or in editor play mode.
- Browser-friendly transports, with a loopback that lets every netcode feature be tested headless in Vitest.
- Data components get replication nearly for free.

**Negative / costs**
- A large amount of work, depending on 0032 landing first.
- Predicted gameplay must live in data components and systems at first, which is less "Unity scripting" than the rest of the engine.
- WebSocket's head-of-line blocking hurts under packet loss until WebRTC lands.

## Deprecates

Nothing.

## Open questions

- Should replication need a `Replicated` component, or be inferred from any replicated field?
- Interest management: per-connection relevancy by distance, or explicit groups?

## References

- Netcode for Entities prediction (1.6): https://docs.unity3d.com/Packages/com.unity.netcode@1.6/manual/prediction-n4e.html
- Netcode for Entities interpolation (1.8): https://docs.unity3d.com/Packages/com.unity.netcode@1.8/manual/interpolation.html
- Host migration (1.5): https://docs.unity3d.com/Packages/com.unity.netcode@1.5/manual/host-migration.html
- Upgrade guide (single-world host): https://docs.unity3d.com/Packages/com.unity.netcode@7.0/manual/upgrade-guide.html
- Netcode for Entities 1.9.0 release notes: https://discussions.unity.com/t/netcode-for-entities-1-9-0-released/1685077/1
- Glenn Fiedler, "Networked Physics" and "Snapshot Compression" (gafferongames.com)
