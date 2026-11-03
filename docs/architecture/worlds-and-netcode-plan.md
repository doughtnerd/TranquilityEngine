# Plan: multiple Worlds and netcode

How to implement [0032](../decisions/0032-worlds-systems-and-bootstraps.md) (Worlds, systems, bootstraps) and [0033](../decisions/0033-server-authoritative-netcode.md) (netcode) with several agents working in parallel. Both records were accepted on 2026-11-02.

## How the work is run

- **One coordinator.** It holds the context, talks to the owner and splits the work. It writes the **contracts** for each wave (TypeScript interfaces and stub modules, with tests marked `todo`) before any implementer starts. Then it hands each task to an implementer agent in its own git worktree. As tasks finish, it reviews each branch, merges them in dependency order and runs the full suites (`npm run typecheck`, `npm test`, `npm run test:e2e`) after every merge. It updates `implementation-status.md` and brings questions to the owner. Implementers don't talk to each other; anything that crosses tasks goes through the coordinator, usually as a contract change.
- **Implementer agents.** Each owns one task's files (listed below) and doesn't edit files another running task owns. If it needs a contract change, it stops and asks the coordinator. Each task ends with its unit tests passing, plus e2e tests where it touches the editor. Each implementer commits only to its own branch.
- **Waves.** Tasks in the same wave run at the same time. A wave starts when the tasks it depends on are merged, or when it only needs a contract that has already landed.

## Wave 0: contracts (coordinator, sequential), done 2026-11-02

C1 and C2 landed as stubs: `core/worlds.ts` and the additions to `World`, `Engine`, `Component`, `systems.ts`, `settings.ts` and `registry.ts`; and `net/` (`Transport.ts`, `codec.ts`, `messages.ts`, `replication.ts`, `time.ts`). Stubs throw `notYet(task, …)`. Each task's done-when criteria are `it.todo` entries in `src/engine/tests/worlds.test.ts` and `net.test.ts`, for the implementer to turn into tests. The public index exports the core types and `NetworkTime`. T10 and T12 export `defineRpc` and `defineInput` when they implement them, and T11 registers `net.Replicated`.

| Id | Task | Output |
|---|---|---|
| C0 | Accept 0032/0033 with the owner. Settled 2026-11-02: keep the name `Engine`; Worlds can be created at runtime (handles, as in Unity's `CreateServerWorld`); the dedicated server runs on Node; matchmaking is v2; Worlds step in one loop with their own rate managers, and scenes load into whichever World asks, as in Unity | Records marked Accepted |
| C1 | Write the core contracts | `Engine` additions: `createWorld`, `findWorld`, the `WorldHandle` and `WorldConfig` types, `Bootstrap`. Additions to `World`: name, tags, own clock, `addSystem`/`removeSystem`. `SystemDef.worlds`. The `project.json` `bootstrap` schema in `settings.ts`. Stubs compile; tests are `todo` |
| C2 | Write the netcode contracts | `net/Transport.ts` (channels, `send`, `receive`, connection lifecycle), `net/codec.ts` interface, `defineRpc`/`defineInput` signatures, the `Replicated` component and field `replicate` options, the `Time.network` shape |

## Wave 1: multi-World core (after C1), done 2026-11-02

T1–T4 ran in parallel from 73c3762 and merged in order (T1, T2, T3, T4) with one conflict-free merge each. At merge, templates passed in `EngineOptions.bootstrap` were found to be ignored (fixed), and the wave 0 placeholder tests were replaced by an end-to-end client+server bootstrap test. A review then fixed ten issues (ADR 0034): system membership follows tags, the view and input pass to the next World when theirs is destroyed, bad configs leave the Engine unchanged, parents and `this.instantiate` keep async code in its World, physics events go to their own World, and `timeScale: 0` is valid. Carried into wave 2: one RenderBackend per rendering World for tiled views (T5).

| Id | Task | Owns | Depends on | Done when |
|---|---|---|---|---|
| T1 | **Several Worlds per Engine, each with its own clock**: the Engine loop steps each World with its own accumulator, tick rate and time scale; current-world context; facades throw outside frames; `Engine.create()` runs a bootstrap and `engine.world` is the default World; `createWorld`/`findWorld` and World handles at runtime; `this.time` on behaviors | `core/Engine.ts`, new `core/WorldHandle.ts`, `core/World.ts` (clock, context), `core/Time.ts`, `core/Component.ts` | C1 | Two Worlds at 30 and 60 Hz step independently in a headless test; a World created and destroyed at runtime through a handle; all existing tests pass unchanged |
| T2 | **System catalog and membership**: `defineSystem` only registers; per-World system lists; built-ins as catalog entries; `worlds` filters; per-World scheduler | `core/systems.ts`, the scheduler part of `core/World.ts` (coordinate with T1: T2 touches only `scheduler` wiring) | C1 | A system added to one World doesn't run in another; the default bootstrap reproduces today's order |
| T3 | **Global singleton audit and isolation**: Input devices at Engine level, routed to Worlds; `SceneManager`, `GameObject` statics and `Physics2D` act on the current World; Storage and Assets at Engine level; cross-World reference and reparent guards | `input/`, `scene/SceneManager.ts`, `scene/GameObject.ts`, `physics/Physics2D.ts`, `platform/Storage.ts`, `render/RenderBackend.ts` (ownership only) | C1 | A test with two Worlds in one Engine shows no leakage; assigning a node from another World throws |
| T4 | **Bootstraps**: default, declarative (`project.json` `bootstrap`, including templates for runtime Worlds), code (`bootstrap(engine)` from a project script); validation with readable errors | new `core/bootstrap.ts`, `core/settings.ts` | C1 (T2 for system selection, against the contract) | A client+server config builds two Worlds with the right systems; bad configs report what's wrong |

T1 is the critical path. T2–T4 build against the C1 contract and merge after T1.

## Wave 2: editor (after wave 1) and networking foundations (after C2), done 2026-11-02

T5–T9 ran in parallel from 138d6ef (each editor agent ran Playwright on its own `E2E_PORT`). T5, T6, T7 and T8 merged cleanly. T9 (WebSocket) merged after ADR 0035 (the `ws` dependency for the Node server) was accepted. A review then fixed: WebSocket message, flooding and send-buffer limits with latest-wins dropping of unreliable data; transports closed with their World (`createWorldTransport`, which T10 should use); play mode leaving `scenes: []` Worlds empty; the game view surviving errors; input focus keeping held keys; and a Worlds panel save race. Not done from the T5 row: a World picker in the hierarchy while playing (the runtime World isn't inspectable yet).

These two tracks don't touch the same files and run side by side.

**Editor track**

| Id | Task | Owns | Depends on | Done when |
|---|---|---|---|---|
| T5 | **Play mode builds an Engine** from the project's bootstrap; tiled game views for several rendering Worlds, including ones created at runtime; a World picker in the hierarchy while playing; the Editor World becomes a World in the editor's Engine | `editor/playMode.ts`, `editor/session.ts` (play parts), `ui/ScenePanel.tsx` | T1–T4 | Playing a client+server project shows the client view, and the hierarchy can switch to the server World |
| T6 | **Worlds graph panel**: start-up Worlds and templates as nodes, links as edges; add, rename and remove Worlds; tags, tick rate, renders and input; a per-World system checklist explaining why each system is in or out; undoable edits saved to `project.json` | new `editor/worldsConfig.ts`, `ui/WorldsPanel.tsx`, `ui/worlds.css`, layout registration | T4 (config schema) | Building a client+server layout in the panel writes the expected `project.json` and plays |

**Networking track**

| Id | Task | Owns | Depends on | Done when |
|---|---|---|---|---|
| T7 | **Loopback transport** with simulated latency, jitter and loss; channel semantics | `net/transport/loopback.ts` | C2 | Ordered and unreliable channels behave as specified under simulated loss |
| T8 | **Codec**: schema-driven binary encoding, quantization, delta against a baseline | `net/codec.ts`, `net/bits.ts` | C2 | Round-trip and delta tests; size checks on sample schemas |
| T9 | **WebSocket transport** for browsers, plus a Node server side | `net/transport/websocket.ts`, `server/` (socket only) | C2 | A headless Node test connects a client World to a server World over a real socket |

## Wave 3: replication (after T1–T4, T7, T8), done 2026-11-02

T10 ran first; T11 and T12 then ran in parallel against T10's internal message API. Merging T11 after T12 needed only combined exports and system-order expectations. A review then fixed: timelines reset on reconnect, handshake/idle timeouts and a connection cap, field shapes in spawns (unknown components are skipped, not fatal), spawn parents that are plain scene nodes, bounded state history, `Move.of(playerNode)` through `ownerId`, and single encoding of over-budget snapshots. Known gaps carried forward: node activity and reparenting aren't replicated, spawn layouts aren't string-tabled, and asymmetric links can make inputs arrive late (the slack assumes RTT/2 each way).

| Id | Task | Owns | Depends on | Done when |
|---|---|---|---|---|
| T10 | **Connections, ticks and RPCs**: connection handshake; `Connection` nodes; fixed simulation ticks; server-tick estimate and RTT on clients; `defineRpc` buffers both ways | `net/connection.ts`, `net/time.ts`, `net/rpc.ts` | T1, T7, T8 | Over loopback with 100 ms latency, clients agree on the server tick within a tick; RPCs arrive as buffer rows |
| T11 | **Ghost replication and interpolation**: `Replicated`; data components and marked behavior fields; spawn and despawn by prefab; scene ghosts matched by node id; per-World components (`worlds` tags on component declarations and instances, skipped at load in other Worlds); per-connection snapshots with acks and delta compression; client interpolation buffer and extrapolation | `net/replication/*` | T10 (handshake contract), T8 | A server-moved node appears smoothly on two clients under simulated loss; spawns and despawns match |
| T12 | **Input streams**: `defineInput`; per-tick input on the owned node; redundant sends; the server applies inputs at their tick | `net/input.ts` | T10 | Server-side movement driven by client input matches the client's input history under loss |

T11 and T12 can run at the same time once T10's handshake and tick contract is merged.

## Wave 4: prediction, server runtime and tools (after wave 3), done 2026-11-02

T13, T14 and T15 ran in parallel from wave 3's review fixes and merged in order T14, T13, T15 without conflicts. At merge, T15's lookup of `predictionStats` (written before T13 existed) became a direct import, so the Network panel shows prediction counters for client Worlds. Not done from the T15 row: bandwidth per ghost type (the panel shows bytes per message kind and snapshot size). A review then fixed: the dedicated server takes listen addresses only from `websocket` links and logs server Worlds created at runtime as not served (O15); play mode's simulated conditions reach the handshake; input streams go with their scripts. After it, the dedicated server runs server-tagged templates when the bootstrap has no server Worlds.

| Id | Task | Owns | Depends on | Done when |
|---|---|---|---|---|
| T13 | **Client prediction**: `predicted` data fields on owned ghosts; rollback to the snapshot; re-run of `predicted` fixedUpdate systems; misprediction stats | `net/prediction.ts`, the predicted group in `core/systems.ts` (contract from the coordinator) | T11, T12 | The owned player responds instantly at 150 ms latency and converges on the server state |
| T14 | **Dedicated server entry**: `myco-server <project>` runs server-tagged Worlds headless in Node over WebSocket | `server/`, a package script | T4, T9, T10 | A Node server and a browser client play the multiplayer sample |
| T15 | **Multiplayer play mode and network tools**: server plus N clients and thin clients on loopback; latency, jitter and loss sliders; a stats panel (bandwidth per ghost type, RTT, mispredictions) | `editor/netPlay.ts`, `ui/NetworkPanel.tsx` | T5, T7, T11 | Play with 2 clients plus 1 thin client from the editor, with stats updating live |

## Wave 5: proof (after wave 4), done 2026-11-02

T17 is done (2026-11-02): user guides in `docs/guide/` ([Worlds](../guide/worlds.md), [Multiplayer](../guide/multiplayer.md)), the 0032–0035 rows of `implementation-status.md` checked against the code (rows added for 0034 and 0035), and the READMEs and overview updated. It ran beside T16; the guide's paragraph on `samples/arena/` was checked against the sample at merge.

T16 is done: `samples/arena/`, a 2D arena following Unity's frontend pattern (the bootstrap starts only `Client` on a menu; Host creates the `Server` template at runtime and connects over loopback, P adds `Client 2`, Join connects to a dedicated server by address). Predicted movement, server-spawned shots, server-authoritative scores. It needed `WorldHandle.connect(address, …)` (ADR 0036, proposed), `myco-server` running server-tagged templates, and a fix to the replication layout cache across script reloads. Not yet reviewed.

| Id | Task | Owns | Depends on | Done when |
|---|---|---|---|---|
| T16 | **Multiplayer sample** (`samples/arena/`, for example): two players moving and shooting, with a score; Worlds graph configured; a Host button creates the server World at runtime; plays hosted and with a dedicated server | `samples/arena/` | T11–T15 | Listed on the start screen; e2e tests play it hosted |
| T17 | **Docs**: implementation status, a user guide for Worlds, bootstraps and multiplayer, and updated READMEs | `docs/` | all | Coordinator review |

## Later (not scheduled)

Lag compensation, relevancy and priority, host migration, single-world host, WebRTC transport with a signalling server, physics prediction. v2: matchmaking and lobbies.

## Order at a glance

```
C0 → C1 → T1 ─┬─ T2 ─┐
              ├─ T3 ─┼─→ T5 ─────────────┐
              └─ T4 ─┴─→ T6              │
C2 ─┬─ T7 ─┐                             │
    ├─ T8 ─┼─→ T10 ─┬─ T11 ─┬─→ T13      ├─→ T16 → T17
    └─ T9 ─┘        └─ T12 ─┘   T14      │
                                T15 ─────┘
```

At most about four implementers run at once, in waves 1 and 2. The critical path is C1 → T1 → T10 → T11 → T13 → T16.
