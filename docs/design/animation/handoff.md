# Animation build: handoff

## Where things are

- **Records:** `docs/decisions/0340`–`0347` (Accepted).
- **Build documents:** `docs/design/animation/`. [plan.md](plan.md) is the source for order and ownership, [ground-rules.md](ground-rules.md) holds every task's rules, and [decision-log.md](decision-log.md) and [build-log.md](build-log.md) record what happened.
- **Branch:** `ccr-d1d28632-2asa2r`.
- **Audio branch (gate A):** `origin/ccr-8460d665-umr8or`.

## Reading order

1. `CLAUDE.md`.
2. Records 0340, 0341, 0342, 0343 (then 0344–0347 as a task needs them).
3. `plan.md`.
4. `ground-rules.md`.
5. The latest entries of `build-log.md` and `decision-log.md`.

## Settled

All owner decisions are in the records and in the "Owner rules" section of `ground-rules.md`.

## Open

- **The WebGL2 skinning mechanism:** float textures with vertex pulling, or transform feedback. Spiked in T16.
- **Rapier's per-axis motors on spherical joints:** confirmed first in T43.

## Owner-only items

- Gate A: merging the audio branch.
- A later record for mixed-asset packages.
- A later shared expression language.
- A sample project with assets.

## Kick-off

1. Confirm the branch is at the plan commit, and that `npm ci`, the wasm target and wasm-bindgen 0.2.130 are installed (see build-log).
2. Start W0: T01, T02, T03 (strongest model) and T04, T05 (mid model), each in its own worktree with a brief pointing at `ground-rules.md`.
3. Merge in dependency order (T02, T03, T01, T04, T05), run the wave-end checks, then write T06 and log the pilot measures.
