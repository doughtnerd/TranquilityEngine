# Debug-link pairing: task tree

Plan: [waves](2026-11-debug-link-pairing-waves.md) (owns tasks, order and files). Rules: [ground rules](2026-11-debug-link-pairing-ground-rules.md).

## 1. Tiers

| Tier | Model | Owns |
|---|---|---|
| Coordinator | strongest (main session) | L0, R0, contracts review, single-writer files, merges, wave reviews, Playwright, docs |
| Lead | strongest for S tasks, Sonnet for M tasks | skeleton, hard core, glue, merging leaves, acceptance |
| Leaf | Haiku | one or two skeleton files filled to a quoted spec, with their tests |

## 2. Collision audit

| Wave | Hotspot or rework | Fix |
|---|---|---|
| W0 | New files would leak into release exports until the rule changes | **L0 first:** the `DEBUG_LINK` rule widens before any new file exists |
| W1a | A1, A2, A3 all hang off the audio topic | **Per-concern modules:** L1 stubs `upload.ts` and `mixCommands.ts` (C4); A1 owns `topic.ts` and the registration in `audio/runtime/index.ts` |
| W1a | L7 needs C6 config fields that L6 parses in the same wave | L1 declares the C6 types; L7 reads types only, L6 owns `config.ts` |
| W1a/W1b | L8 and L9 both touch the listening command | C8 fixes the command names and arguments; L8 (W1a) owns the crate's `lib.rs` and the moved `tauriListener.ts`; L9 (W1b, after L8 merges) owns every Cargo, capabilities and shell file |
| W1a | L7 and the pairing leaves | `pairing/*` stubs land in L1 (C2); L7 calls them through their interfaces and never edits them |
| W1a | `topics.ts` would be edited by L7 (channel option) | L1 adds `channel` in W0 (C3); single writer after |
| W1a/W1b | S0 needs L7, A1, A2 | S0 moves to W1b |
| W1/W4 | `tauriListener.ts` in `src/editor/` would be moved later (rework) | **Move it in W1a** (L8) to `src/engine/debugLink/`; R4 adds path routing there (additive) |
| W2 | U1 and U3 both need `editorLink.ts` | **Declare the surface early (C7):** the coordinator adds `connect()` (delegates to `connectFlow.ts`, U1's file) and `servePlay()` stubs; U3 owns `editorLink.ts` |
| W2 | U3 needs `BuildsMenu.tsx` (U1's) | C7 declares a slot; U1 renders it, U3's `playBuild.ts` fills it |
| W2 | U4, U5, U8 all need the Studio's link | **Interface stub:** `studioLink.ts` signal module committed in C7; U4 fills it, U5 and U8 read it |
| W2 | U2 overlay later extended by R5 | **Complete UI early:** U2 draws address and room states; R5 only wires the room flow (additive) |
| W2 | U1 dialog later extended by R5, D2 | U1 builds the room state and an empty discovered-list slot; R5 and D2 fill props (additive) |
| W2/W4 | export files: U6 (W2), R4 (W4) | sequential; R4 adds the `serve.mjs` rendezvous and LAN bind (additive) |
| W4 | R4 and R5 | R4 owns `link.ts`, `studioLink.ts`, `tauriListener.ts`, `webBuild.ts`, `vite/rendezvousPlugin.ts`; R5 owns `host.ts`, `client.ts`, `connectFlow.ts`, `debugOverlay.ts`, `editorLink.ts`; disjoint |
| W4 | the Vite plugin | R4 writes `vite/rendezvousPlugin.ts`; the coordinator adds one line to `vite.shared.ts` (single writer) |
| W5/W5b | D1 touches both shells' `lib.rs` and `desktop.ts`; D3's mobile plugin must be registered in the generated app | D1 alone in W5; in W5b D3 owns `desktop.ts` (registers its plugin, additive) and its plugin folder, D2 owns `discovery.ts` and the dialog slot |
| all | e2e fixtures | new fixture files per spec (`debugLinkFixture.ts`); `tests/e2e/fixtures.ts` stays the coordinator's |

Checked and left as they were: `session.ts` (only L7), `protocol.ts` (only L1), `ExportDialog.tsx` and `debugLinkLogic.ts` (only R7), studio `screens/mixer/` (only U8), `screens/profiler/` and `screens/take/` (only U5).

## 3. How a task runs

The lead commits the skeleton (types, signatures, stub bodies tagged with the leaf id, skipped tests), leaves fill
their files in their own worktrees from that commit, the lead writes the core at the same time, then merges and runs
the acceptance. **Dispatch: flat** (subagents here don't start subagents): the coordinator starts the lead; the lead
returns leaf briefs; the coordinator starts the leaves in one message; the coordinator continues the lead with the
leaf branches.

Leaf brief: the template in the plan-milestone-build skill's `task-tree.md`, with check command
`npm run typecheck && npx vitest run <your test file>` and the ground rules file linked.

## 4. Per milestone

### M1

| Task (days) | Lead | Lead keeps | Leaves (id: files; spec source) | Leaf days |
|---|---|---|---|---|
| L0 (0.5) | C | all | — | — |
| L1 (1.5) | S | every contract | none: interfaces are judgement | — |
| L2 (0.75) | — | — | single leaf L2: `code.ts`, `code.test.ts`; 0403 "Pairing code" + C2 | 0.75 |
| L3 (0.5) | — | — | single leaf L3: `gate.ts`, `gate.test.ts`; 0403 token rules + C2 | 0.5 |
| L4 (0.5) | — | — | single leaf L4: `address.ts`, `address.test.ts`; 0403 address completion | 0.5 |
| L5 (0.5) | — | — | single leaf L5: `path.ts`, `path.test.ts`; 0403 pair table | 0.5 |
| L6 (0.5) | — | — | single leaf L6: `config.ts`, `config.test.ts`; C6 key list | 0.5 |
| L7 (3) | S | lifecycle, reconnect, `pair`, token, prompt rules, both directions | L7a: `roles.test.ts` from the acceptance list | 0.5 |
| L8 (1.5) | M | all | unsplit: Rust socket code and a cross-module move | — |
| L9 (1.5) | M | all | unsplit: moves across crates and shells | — |
| A1 (2.5) | S | ring ownership, segment streaming | A1a: `topic.test.ts` from C4 | 0.5 |
| A2 (1.5) | M | chunking, abort | A2a: `takeReceiver.ts` reassembly + test (pure; chunk record from C4) | 0.5 |
| A3 (1) | M | all | unsplit: under the leaf floor once briefed | — |
| R2 (3) | S | peer lifecycle, channel rules, fragmentation | R2a: fake peer pair helper in `webrtc.test.ts` from the `RTCPeerConnection` subset used | 0.5 |
| S0 (1) | M | all | unsplit: integration across modules | — |
| U1 (2) | M | flow, errors | U1a: `ConnectDialog.stories.tsx` (one story per state) | 0.5 |
| U2 (1.5) | M | all | unsplit: player boot and key handling | — |
| U3 (2.5) | S | all | unsplit: roles on one listener | — |
| U4 (2) | M | all | unsplit: app wiring | — |
| U5 (3) | S | remote LiveHost, upload into `takes/` | U5a: `recordFromBuild` button + story | 0.5 |
| U8 (1.5) | M | all | unsplit: mixer wiring | — |
| U6 (2.5) | M | vendoring, generated Rust, flags | U6a: `export.test.ts` cases from the acceptance | 0.5 |
| U7 (1) | M | all | unsplit | — |
| S1 (1.5) | M | all | unsplit: e2e with a Node fixture | — |

### M2

| Task (days) | Lead | Lead keeps | Leaves | Leaf days |
|---|---|---|---|---|
| R0 (0.5) | C | the amendment record | — | — |
| R1 (2) | M | room lifetime, limits | R1a: protocol codec tests from C5 | 0.5 |
| R3 (1.5) | M | all | unsplit: bundling | — |
| R4 (2) | M | all | unsplit: four hosts, one routing rule | — |
| R5 (2) | M | all | unsplit: wiring across modules | — |
| R6 (1.5) | M | all | unsplit | — |
| R7 (1.5) | — | — | single leaf R7: two dialogs' fields, `debugLinkLogic.ts` preferences, stories; C6 and 0403 | 1.5 |

### M3

| Task (days) | Lead | Lead keeps | Leaves | Leaf days |
|---|---|---|---|---|
| D1 (2.5) | M | mdns-sd lifecycle | unsplit: native networking | — |
| D2 (1) | M | all | unsplit | — |
| D4 (1) | M | all | unsplit: prose readers see | — |
| D3 (3) | M | all | unsplit: cross-compiling and a mobile plugin | — |

## 5. What it changes (estimates)

- Days by tier, before the tree: coordinator 1.0 (L0, R0), S 15.5, M and leaf-sized tasks 39.25; total 55.75.
- After the split: Haiku 8.25 d across 14 leaves (6 single-leaf tasks, 8 test or UI leaves); S leads shed about
  2.0 d of test writing to leaves; Sonnet the rest. All **estimates** until the pilot reports.
- Critical path: same order; L7 and A1 may shorten by their test leaves (~0.5 d each, estimate).
- Pilot measures (W1a): leaf first-pass success for L2–L6 and the test leaves; lead time on skeletons and briefs
  (L1 especially); tokens by model; L7 and R2 against their 3 d. A leaf kind re-run more than once goes back to its
  lead.
