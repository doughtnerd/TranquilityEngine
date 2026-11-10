// The hard rebuild (ADR 0157; architecture §3.6, §3.7, §7's failure table). Contract K6, committed before MS5 wave 2 so
// A3.4a (which fills it: trap catch, a new node and Memory in the same context, RESET 0, clips re-sent by priority, the
// stamped REPLAY in chunks, 3 per 60 s then Failed) and A3.4b (whose `devicechange` / stall / rate-change classification
// calls it) build against one signature.

/** @internal Why a rebuild was asked for (architecture §7: `traps`, `rebuilds`). */
export type RebuildReason =
  /** The core trapped in `process()` (the shell's catch) or the node raised `processorerror`. */
  | "trap"
  /** No STATUS for 1 s while running and visible (a worklet stall). */
  | "stall"
  /** The output device changed and the classifier (§3.7) decided the node must be rebuilt. */
  | "device"
  /** The context's sample rate changed. */
  | "rate";

/**
 * @internal What a rebuild ended as:
 * - `"rebuilt"`: a new node runs, clips and live voices restored;
 * - `"limited"`: refused by the rate limit (the 4th within 60 s); the host is now Failed and silent, with one warning;
 * - `"unavailable"`: nothing to rebuild (no host, or the host is closed or already Failed).
 */
export type RebuildOutcome = "rebuilt" | "limited" | "unavailable";

/**
 * @internal K6: rebuild the core after `reason`. Never throws. Concurrent calls share the rebuild in flight.
 * Stub until A3.4a: resolves `"unavailable"` and does nothing.
 */
export function rebuild(reason: RebuildReason): Promise<RebuildOutcome> {
  void reason;
  return Promise.resolve("unavailable");
}
