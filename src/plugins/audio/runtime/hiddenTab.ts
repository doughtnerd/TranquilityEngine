// The hidden-tab policy (`audio.background`, ADR 0157 A3.4b; architecture §3.8; api-and-models §2), shared by both
// backends behind the seam (ADR 0179). It decides what a hide does; each backend says how:
//
//   mute   the master to 0 (`MUTE_RAMP_MS`), restored when the page shows again.
//   pause  the master to 0 (`PAUSE_RAMP_MS`), then the context is suspended once the fade has had time to finish
//          (`PAUSE_SUSPEND_DELAY_MS`), if the page is still hidden under `pause`; resumed when it shows.
//   play   nothing.
//
// The mode is read at the hide and remembered, so the show undoes what was done even if the setting changed meanwhile.
// What differs by design stays with each backend: the core (`core/background.ts`) ramps MASTER through its command
// writer, frees ended voices from STATUS and ticks the music while hidden, and on a show waits for the resume and
// re-anchors its clock map before it unmutes; the Babylon fallback sets its engine's volume at once and suspends only a
// context it made itself.
import type { AudioBackground } from "./backend";

/** §3.8: MASTER ramp when muting or unmuting for `mute`, ms. */
export const MUTE_RAMP_MS = 50;
/** §3.8: MASTER ramp before a `pause` suspend, ms. */
export const PAUSE_RAMP_MS = 30;
/** §3.8: the suspend follows the fade after this long (ms), a little more than the ramp. */
export const PAUSE_SUSPEND_DELAY_MS = 40;

/** How a backend carries out the policy. */
export interface HiddenTabHooks {
  /** `audio.background` as last set, read at each hide (a change applies at the next one). */
  mode(): AudioBackground;
  /** Mute the master for a hidden page over `rampMs` (`mode` is "mute" or "pause"). */
  mute(rampMs: number, mode: AudioBackground): void;
  /** `pause`: suspend the context now (the fade is done and the page is still hidden under `pause`). */
  suspend(): void;
}

/** One per backend. `hide` and `show` are the page's visibility changes; the backend unmutes and resumes after `show`. */
export class HiddenTabPolicy {
  private appliedMode: AudioBackground | null = null;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly hooks: HiddenTabHooks) {}

  /** The mode the current hide applied, or null while the page shows. */
  get applied(): AudioBackground | null {
    return this.appliedMode;
  }

  /** The page went hidden: apply the mode in force and return it. Null when a hide is already applied (nothing done). */
  hide(): AudioBackground | null {
    if (this.appliedMode !== null) return null;
    const mode = this.hooks.mode();
    this.appliedMode = mode;
    if (mode === "mute") {
      this.hooks.mute(MUTE_RAMP_MS, mode);
    } else if (mode === "pause") {
      this.hooks.mute(PAUSE_RAMP_MS, mode);
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = null;
        if (this.appliedMode === "pause") this.hooks.suspend();
      }, PAUSE_SUSPEND_DELAY_MS);
    }
    return mode;
  }

  /**
   * The page shows again: cancel a suspend still waiting and return the mode the hide applied, so the backend resumes
   * ("pause") and unmutes ("mute", "pause") in its own order. Null when no hide was applied.
   */
  show(): AudioBackground | null {
    const mode = this.appliedMode;
    if (mode === null) return null;
    this.appliedMode = null;
    this.clearTimer();
    return mode;
  }

  /** The backend is going away: cancel a suspend still waiting (the master is left as it is). */
  dispose(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.suspendTimer !== null) clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
  }
}
