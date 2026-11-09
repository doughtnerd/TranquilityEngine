// `AudioHandle` (ADR 0157; api-and-models §1, §3 "Handle encoding"): one sound started with `playOneShot`. It holds
// the voice's id and the voice table, and reads the table's mirror; it never allocates after construction. A1.6
// exposes this class through the public `AudioHandle` interface (§1) without adding to it.
import type { VoiceTableHandleApi } from "./voiceTable";

/**
 * @internal §1: "Why a sound isn't audible right now; null while it is." Declared here until A1.6 declares the
 * public surface (K10) and re-exports it from `src/myco.ts`.
 */
export type AudioReason = "virtual" | "stolen" | "busMuted" | "locked" | "failed" | "waitingForData";

/**
 * @internal §1's `AudioReason` for each `VoiceReason` code (index = code); `null` for NONE (0).
 * Codes: 0 none, 1 virtual, 2 stolen, 3 busMuted, 4 locked, 5 failed, 6 waitingForData.
 */
export const REASON_NAMES: readonly (AudioReason | null)[] = [null, "virtual", "stolen", "busMuted", "locked", "failed", "waitingForData"];

/** @internal §1: `fade`'s `to` is linear, 0..4. */
export const MAX_FADE_GAIN = 4;

/**
 * @internal §1 `AudioHandle`: "A value, safe to keep: once the voice ends or its slot is reused, every call is a
 * no-op." No method throws; each clamps and warns once (§1 "Semantics").
 */
export class AudioHandle {
  /** The reason the voice ended with, cached the first time this handle sees it ended (see `reason`). */
  private finalReason: AudioReason | null | undefined = undefined;

  /**
   * `table` may be null only for an inert handle (`id` 0). `id` is `encodeVoiceId(index, gen)` (`ids.ts`) of the
   * voice this handle names, or 0 for an inert handle (a refused or failed play), which always reads `playing`
   * false and `reason` null (or the reason it was given, see `inert`).
   */
  constructor(
    private readonly table: VoiceTableHandleApi | null,
    readonly id: number,
  ) {}

  /**
   * @internal A handle for a play that never got a voice (§1: "refused or failed plays give an inert one with
   * `playing` false"). `reason` is what it reads (e.g. "stolen" when every candidate outranked it, "failed" when the
   * clip failed), or null. Allocates one object per call, like any `playOneShot`.
   */
  static inert(reason: AudioReason | null = null): AudioHandle {
    throw new Error("not implemented: A1.1-L2");
  }

  /**
   * §1: "True from the call to `playOneShot` until the sound ends or is stopped. Virtual, bus-muted, locked and
   * waiting-for-data sounds are playing (they exist and keep time). Stolen and failed sounds are not. Natural ends
   * are seen up to one frame late."
   *
   * True when the id is current (valid, `gen[index]` matches, state not FREE), the state is LOCKED, PLAYING, VIRTUAL
   * or WAITING_FOR_DATA (not STOPPING or ENDING), and the reason is neither STOLEN nor FAILED.
   */
  get playing(): boolean {
    throw new Error("not implemented: A1.1-L2");
  }

  /**
   * §1: "Why it isn't audible (while `playing`) or why it ended early ("stolen", "failed"); null when audible, or
   * finished or stopped normally."
   *
   * While the id is current and not STOPPING or ENDING: `REASON_NAMES[reason[index]]`. While STOPPING or ENDING:
   * "stolen" or "failed" if that is the slot's reason, else null. Once the id isn't current: the table's
   * `endedReason(id)`, of which only "stolen" and "failed" show (anything else reads null); the first answer read
   * after the end is cached and returned from then on, so a later reuse of the slot can't change it.
   */
  get reason(): AudioReason | null {
    throw new Error("not implemented: A1.1-L2");
  }

  /**
   * §1: "Stop now, or fade to silence over `fadeSeconds` (default 0) and stop. A second call is a no-op."
   *
   * No-op unless the id is current and not STOPPING or ENDING. A non-finite or negative `fadeSeconds` becomes 0 with
   * a one-time warning. Then `table.requestStop(id, fadeSeconds)`; `playing` reads false at once (§1 "Semantics":
   * `stop()` updates the mirror at once).
   */
  stop(fadeSeconds = 0): void {
    throw new Error("not implemented: A1.1-L2");
  }

  /**
   * §1: "Ease this sound's own gain multiplier to `to` (linear, 0..4) over `seconds` (0 = at once)."
   *
   * No-op unless the id is current and not STOPPING or ENDING. A non-finite `to` is ignored (no-op) with a one-time
   * warning; a finite one is clamped to 0..`MAX_FADE_GAIN`, warning once if it was out of range. A non-finite or
   * negative `seconds` becomes 0 with a one-time warning. Then `table.requestFade(id, to, seconds)`.
   */
  fade(to: number, seconds: number): void {
    throw new Error("not implemented: A1.1-L2");
  }
}

/**
 * @internal Warns once per `key` for the page (§1 "each clamps and warns once"), with the `[myco]` prefix as
 * `mixer.ts` does. Tests reset it with `_resetHandleWarningsForTests`.
 */
export function warnOnce(key: string, message: string): void {
  throw new Error("not implemented: A1.1-L2");
}

/** @internal Tests: forget which warnings were given. */
export function _resetHandleWarningsForTests(): void {
  throw new Error("not implemented: A1.1-L2");
}
