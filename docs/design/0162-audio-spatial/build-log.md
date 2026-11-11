# Spatial audio M3: build log

The coordinator's log of each wave review ([waves plan, "Wave reviews"](../../plans/2026-11-audio-spatial-m3-waves.md#wave-reviews)): what landed, the numbers measured, deviations from the design, decisions taken while the owner was away, and reserve days used. Tickets are GitHub issues #112–#163. Work merges into the M3 integration branch, and each milestone goes to master only with the owner's approval.

**Integration branch:** `claude/inspiring-euler-5qf03k` on origin (this build session may push only that branch; locally it's also called `claude/audio-spatial-m3`). It started at `origin/master` `918171a`.

## For the owner (summary, newest first)

The owner asked (2026-11-11, evening): "Go through each of the waves as instructed until the milestone is complete. If any decisions need to be made, use your judgement … and I will review everything in the morning." The coordinator reads that together with the earlier standing rules, which it keeps: **no merge to master, no draw on the 14-day reserve and no default change outside the plan's flips without the owner.** Milestones are left ready on the integration branch, with their checks run, as proposals.

**Needs you:**
- Merges to master as each milestone becomes ready (none yet).

**Decisions taken (each with its revert):** see "Decisions" below, D1 onwards.

## Decisions

Numbered; superseded entries are marked, not rewritten.

- **D1 (W0) master's `./eventTree` imports.** `918171a` ("Fixed bad imports") merged `eventTree.ts` into `EventTree.tsx`, but 11 imports still say `./eventTree`. They resolve on a case-insensitive filesystem (macOS) and fail on Linux: typecheck, the build and five test files failed at baseline. Fixed on the integration branch (`76bbec4`) by importing `./EventTree`. *Revert:* `git revert 76bbec4` (only if the file is renamed back instead).
- **D2 (W1, A6a) unknown `occlusion.defaultMaterial` falls back to `concrete`.** §2.1 says "the first plus problem", and the first material is `none`, which would silently turn occlusion off for a typo. The fallback is the key's own default (`concrete`), as every other §2.1 key falls back to its default; if `concrete` was removed from the table, the first material. *Revert:* one line in `resolveDefaultMaterial` (`occlusionMaterials.ts`).
- **D3 (W1, D0) D0 edited physics files outside its list.** `backend.ts`, `core/PhysicsWorld3D.ts` and `physics-rapier/runtime/rapier3d.ts`: Rapier's predicate filter lives in the backend plugin and the collider-to-node map in the shared core, so the query can't exclude nodes inside the listed files alone. Accepted (no audio file touched, boundary test green). Design names to update at write-back: `groupsFor` is `rayGroupsFor(world, layers?)` (undefined for every layer), `excludeNodes` a `ReadonlySet<GameObject>`.
- **D4 (W1, B1) B1 edited `decoder/decoderClient.ts` and `decoder/handler.ts`** (a few lines each) to carry `convention` from the registry to `decoder/clips.ts`; nothing else owns them in W1 (B4 takes `handler.ts` in W3). Accepted.

## Wave 0 (2026-11-11, base `origin/master` `918171a`)

**Baseline** (clean `918171a`, before any M3 change):
- `npm ci`: ok.
- `npm run typecheck`: **fails** (the `./eventTree` imports, D1). After D1: green.
- `npm test`: 6 files failed. Five are the `./eventTree` imports (green after D1); `piratesSample.test.ts` timed out (a known flake). After D1 and K0: 416 of 417 files passed, 4,343 tests; `navigation.test.ts` failed once in the full run and passed alone (flake, added to the list).
- `npm run build`: failed at its typecheck step (D1); green after D1 and K0.
- `cargo test` in `native/audio/`: green.
- `npm run check:audio-metered`: pass (every scene within ±1.6%; `all` −0.22%).
- `npm run test:e2e`: not run at W0 (it changes no decision before the first wave end; first run at the W1 wave end). Known from master: `selection.spec.ts:77`.
- Rust toolchain as `native/audio/rust-toolchain.toml`; `wasm-opt` not installed. Clippy not installed.

**Known flakes** (rerun alone once before treating as a failure): navSample, selectionBench, server.test, piratesSample, hrtfLoopback, streamRebuild, gltf.test, e2e codefiles, audio-core.spec beside other specs (from the plan), plus `navigation.test.ts` (seen at W0).

**Landed**
- D1 import fix (`76bbec4`).
- **K0** (`f331840`, #162): `backend.ts` gains every M3 `PlayRequest` field (all optional), `AudioVoice.setVelocity?`/`setOcclusion?`/`setDopplerRate?`, `AudioPanner`, `SendCurve`, `DEFAULT_SEND_CURVE`, the `AudioDebugInfo` additions (`beds`, `zones`, `occlusion`, `memory`, the §1.6 and C24 counters, bus and voice columns) and the `ZoneIrService` interface. `decoder/protocol.ts` gains `prepareIr`, `generateIr`, `releaseIr`, `irPrepared`, `irFailed` (C9), and `convention` on `decodeClip` and `streamOpen`; `handler.ts` routes the IR messages to the new stub `decoder/irPrepare.ts` (it refuses until C2b). Additions beyond the plan's text: `releaseIr` (the service's `release` needs a message), `convention` on `decodeClip` (B1 passes it; the plan has it on streams only), `ZoneIrService.reprepareAll?` (architecture §2.2 rate change). Typecheck and decoder tests green.

## Wave 1 (pilot)

Leads started 2026-11-11: A1 (+K1/K2) strongest; A6a + C6, B1, D0 mid; after A1's first commit (`20781e6`, merged as `88cf6b6`), B2 and C1 strongest.

**Merged so far**
- A1 phase 1 (`88cf6b6`): `InitParams` gains `max_beds`, `max_zone_slots`, `zone_max_frames`, `max_wide` and a `Default` (48 kHz, 4,096 logical, 128 mixed, 32 buses, 16 MiB arena; M3 regions 0); every literal uses `..InitParams::default()`; the twelve new modules declared as doc-comment files.
- B1 (`a84b427`, #127): `ambisonic` sidecar key, the §2.4 registry rules, `convention` carried to `decoder/clips.ts` (B2 applies it). Not split (the lead judged the brief would cost as much as the work).
- D0 (`1774eef`, #142): `raycastInto` and `rayGroupsFor` in `worldServices.ts`; 3D physics and Rapier implement them with node exclusion inside the query, sensors and layers filtered, no allocation in engine code (Rapier's own `castRay` allocates a hit wrapper internally); a structural allocation test.

**Lessons for later briefs**
- Leads used their own session's attribution trailer, not the one in the brief: fine (it names the model that did the work). Briefs now say "use your session's trailer".
- Concurrent vitest runs collide on `node_modules/.vitest-cache` (ENOTEMPTY); a rerun passes.
