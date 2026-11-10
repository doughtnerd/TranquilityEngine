// The hard rebuild (ADR 0157; architecture §3.6, §3.7, §7's failure table). Contract K6, committed before MS5 wave 2 so
// A3.4a (which fills it: trap catch, a new node and Memory in the same context, RESET 0, clips re-sent by priority, the
// stamped REPLAY in chunks, 3 per 60 s then Failed) and A3.4b (whose `devicechange` / stall / rate-change classification
// calls it) build against one signature.
//
// The sequence (§3.6): the shell catches the trap (silence, one `trap` event, `coreDriver.ts`); `watchForTraps` counts
// it and calls `rebuildHost`, which takes one from the rate limit (`rateLimit.ts`: 3 per sliding 60 s) or else makes
// the host Failed and silent with one warning (no switch to "babylon" mid-session, §2.1). Otherwise the host enters
// Recovering (`onRebuildStart`: the core backend queues new plays), replaces its node in the same context
// (`AudioHost._replaceCore`: a new Memory, init with the running preset, so the limiter look-ahead is set again), and on
// the new core's first STATUS leaves Recovering (`onRebuilt`: the backend's `Replayer` sends RESET 0, BUS_CONFIG,
// BUS_MIX, MASTER, has the registry re-send the clips by priority, and replays the voices as their clips return).
import { currentAudioHost, type AudioHost } from "./context";
import { RateLimit, RECOVERY_LIMIT, RECOVERY_WINDOW_MS } from "./rateLimit";

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
 * - `"unavailable"`: nothing to rebuild (no host, or the host is closed or already Failed), or the new core never
 *   answered (the host is then Failed and silent too, with the same one warning).
 */
export type RebuildOutcome = "rebuilt" | "limited" | "unavailable";

/** @internal What the rebuild needs of the host (`AudioHost`; tests may pass a fake). */
export type RebuildableHost = Pick<AudioHost, "closed" | "recoveryHasFailed" | "health" | "link" | "_beginRebuild" | "_replaceCore" | "_endRebuild" | "_markRecoveryFailed">;

/** @internal Per host options: the rate limit's clock and numbers, and the warning (tests inject them). */
export interface RecoveryOptions {
  /** ms; default `performance.now`. */
  readonly now?: () => number;
  readonly limit?: number;
  readonly windowMs?: number;
  /** The single warning when recovery gives up; default `console.warn`. */
  readonly warn?: (message: string) => void;
}

interface RecoveryState {
  readonly limit: RateLimit;
  readonly warn: (message: string) => void;
  inFlight: Promise<RebuildOutcome> | null;
  /** A trap that arrived while a rebuild was in flight: rebuild again once it settles. */
  again: RebuildReason | null;
  warned: boolean;
}

const states = new WeakMap<RebuildableHost, RecoveryState>();

function stateOf(host: RebuildableHost, options: RecoveryOptions = {}): RecoveryState {
  let state = states.get(host);
  if (!state) {
    state = {
      limit: new RateLimit(options.limit ?? RECOVERY_LIMIT, options.windowMs ?? RECOVERY_WINDOW_MS, options.now),
      warn: options.warn ?? ((message: string) => console.warn(message)),
      inFlight: null,
      again: null,
      warned: false,
    };
    states.set(host, state);
  }
  return state;
}

/**
 * @internal Arms trap recovery on `host` (the `myco.audio` service calls it once the host starts): every `trap` shell
 * event (the shell's catch, or `processorerror`) counts in `host.health.traps` and starts a rebuild. `options` set the
 * host's rate limit and warning the first time a host is seen. Returns the disarm.
 */
export function watchForTraps(host: RebuildableHost, options: RecoveryOptions = {}): () => void {
  stateOf(host, options);
  return host.link.onShellEvent((event) => {
    if (event.type !== "trap") return;
    host.health.traps++;
    void rebuildHost(host, "trap");
  });
}

/**
 * @internal K6: rebuild the page's core after `reason`. Never throws. Concurrent calls share the rebuild in flight.
 * Resolves `"unavailable"` when the page has no live host.
 */
export function rebuild(reason: RebuildReason): Promise<RebuildOutcome> {
  const host = currentAudioHost();
  return host ? rebuildHost(host, reason) : Promise.resolve("unavailable");
}

/** @internal `rebuild` for a given host (tests, and `watchForTraps`). Never throws. */
export function rebuildHost(host: RebuildableHost, reason: RebuildReason): Promise<RebuildOutcome> {
  if (host.closed || host.recoveryHasFailed) return Promise.resolve("unavailable");
  const state = stateOf(host);
  if (state.inFlight) {
    // A trap in the new core: once this rebuild settles, rebuild again (taken from the limit like any other). A core
    // that trapped before its first STATUS will never send one, so its start fails now instead of after the timeout.
    if (reason === "trap") {
      state.again = reason;
      host.link.fail(new Error("the new core trapped before its first STATUS"));
    }
    return state.inFlight;
  }
  if (!state.limit.take()) {
    giveUp(host, state, `audio core: more than ${state.limit.limit} recoveries within ${state.limit.windowMs / 1000} s (the last: ${reason}); audio stays silent ("failed") for this session.`);
    return Promise.resolve("limited");
  }
  const run = async (): Promise<RebuildOutcome> => {
    host._beginRebuild(reason);
    try {
      await host._replaceCore();
    } catch (error) {
      if (host.closed) return "unavailable";
      // The new core trapped while starting: the retry below decides (the limit makes a crash loop end Failed).
      if (state.again) return "unavailable";
      giveUp(host, state, `audio core: the rebuild after a ${reason} failed (${error instanceof Error ? error.message : String(error)}); audio stays silent ("failed") for this session.`);
      return "unavailable";
    }
    if (host.closed) return "unavailable";
    if (reason === "trap") host.health.recoveries++;
    else host.health.rebuilds++;
    host._endRebuild();
    return "rebuilt";
  };
  const inFlight = run().finally(() => {
    state.inFlight = null;
    const again = state.again;
    state.again = null;
    if (again && !host.closed && !host.recoveryHasFailed) void rebuildHost(host, again);
  });
  state.inFlight = inFlight;
  return inFlight;
}

/** Failed for the session: silence, `status` "failed", and the one warning (§2.1). */
function giveUp(host: RebuildableHost, state: RecoveryState, message: string): void {
  host._markRecoveryFailed();
  if (state.warned) return;
  state.warned = true;
  state.warn(message);
}
