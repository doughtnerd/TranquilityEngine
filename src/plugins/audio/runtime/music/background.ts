/**
 * Music across a hidden tab, a context rebuild and a worker crash (ADR 0166 api-and-models §10 P9; architecture §2.1
 * "Recovering", §3.7, §3.8; ADR 0167 §3 owner decision 5: `play` and `mute` both commit a segment ahead).
 *
 * Owner: **P9** (W5); it also edits `core/recovery.ts` (and `core/background.ts`, `core/replay.ts` if the hand-off needs
 * them). Q2 wrote the skeleton; `core/musicOps.ts` `reopenGroups` (the hook `reopenStreams` calls) lands here.
 *
 * - **Hidden:** not a state; while hidden the players tick from the STATUS handler (`musicSystem.ts` `tickPlayer` with
 *   `hiddenFrame`), committing a segment ahead under both `play` and `mute`.
 * - **Rebuild, crash, rate change:** `Replayer.restore` hands music groups to the player, never to `reopenStreams`
 *   (C16): each group is re-primed at the heard position and stamped, as a group. A group the core gave up on (1 s)
 *   re-plans; the recovery limit stops the player.
 */
import type { AudioBackend } from "../backend";
import type { MusicPlayer } from "./musicSystem";

/** P9: the page became hidden or visible (from the background controller). */
export function noteHidden(hidden: boolean): void {
  void hidden;
  // STUB(P9)
}

/** P9: a STATUS block arrived while hidden: tick every player from the handler (architecture §3.8). */
export function tickHidden(backend: AudioBackend): void {
  void backend;
  // STUB(P9)
}

/**
 * P9: after a hard rebuild (or a new decoder worker), reopen every live music group as a group: re-prime at the heard
 * position and stamp. Called by `core/musicOps.ts` `reopenGroups`.
 */
export function recoverGroups(backend: AudioBackend, cause: "rebuild" | "crash" | "rate"): void {
  void backend;
  void cause;
  // STUB(P9)
}

/** P9: the core gave up on a group (abandon after 1 s): re-plan, or stop at the recovery limit. */
export function groupAbandoned(player: MusicPlayer, group: number): void {
  void player;
  void group;
  // STUB(P9)
}
