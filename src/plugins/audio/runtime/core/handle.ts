// `AudioHandle` (ADR 0157; api-and-models §1, §3 "Handle encoding"): one sound started with `playOneShot`. It holds
// the voice's id and the voice table, and reads the table's mirror; it never allocates after construction. A1.6
// exposes this class through the public `AudioHandle` interface (§1) without adding to it.
import { VoiceReason, VoiceState } from "./voiceTable";
import type { VoiceTableHandleApi } from "./voiceTable";

import type { AudioReason } from "../backend";

export type { AudioReason };

/**
 * @internal §1's `AudioReason` for each `VoiceReason` code (index = code); `null` for NONE (0).
 * Codes: 0 none, 1 virtual, 2 stolen, 3 busMuted, 4 locked, 5 failed, 6 waitingForData.
 */
export const REASON_NAMES: readonly (AudioReason | null)[] = [null, "virtual", "stolen", "busMuted", "locked", "failed", "waitingForData"];

/** @internal §1: `fade`'s `to` is linear, 0..4. */
export const MAX_FADE_GAIN = 4;

/** @internal `id` names a live slot: non-zero, `gen[index]` matches the id's generation, and the slot isn't FREE (§3). */
function isCurrent(t: VoiceTableHandleApi, id: number): boolean {
  if (id === 0) return false;
  const index = id & 0xffff;
  return t.gen[index] === id >>> 16 && t.state[index] !== VoiceState.FREE;
}

/** @internal `isCurrent`, and not STOPPING or ENDING: `stop` and `fade` act only on these. */
function isActive(t: VoiceTableHandleApi, id: number): boolean {
  if (!isCurrent(t, id)) return false;
  const s = t.state[id & 0xffff];
  return s !== VoiceState.STOPPING && s !== VoiceState.ENDING;
}

/** @internal §1 reasons shown for an ended or ending voice: only "stolen" and "failed" show; anything else reads null. */
function shownEndReason(code: number): AudioReason | null {
  if (code === VoiceReason.STOLEN) return "stolen";
  if (code === VoiceReason.FAILED) return "failed";
  return null;
}

/** @internal A value for a warning message, without calling any method on it (so nothing a caller passes can throw). */
function show(value: unknown): string {
  return typeof value === "number" ? String(value) : typeof value;
}

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
    const handle = new AudioHandle(null, 0);
    handle.finalReason = reason;
    return handle;
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
    const t = this.table;
    if (t === null || !isCurrent(t, this.id)) return false;
    const index = this.id & 0xffff;
    const s = t.state[index];
    const audibleOrWaiting =
      s === VoiceState.LOCKED || s === VoiceState.PLAYING || s === VoiceState.VIRTUAL || s === VoiceState.WAITING_FOR_DATA;
    if (!audibleOrWaiting) return false;
    const r = t.reason[index];
    return r !== VoiceReason.STOLEN && r !== VoiceReason.FAILED;
  }

  /** @internal E3.10: the voice has not been freed yet (a stopped voice fading out is alive though not `playing`). */
  get alive(): boolean {
    const t = this.table;
    return t !== null && isCurrent(t, this.id);
  }

  /**
   * §1: "Why it isn't audible (while `playing`) or why it ended early ("stolen", "failed"); null when audible, or
   * finished or stopped normally."
   *
   * While the id is current and not STOPPING or ENDING: `REASON_NAMES[reason[index]]`. While STOPPING or ENDING:
   * "stolen" or "failed" if that is the slot's reason, else null. Once the id isn't current: the table's
   * `endedReason(id)`, of which only "stolen" and "failed" show (anything else reads null); the first answer read
   * after the end is cached and returned from then on, so a later reuse of the slot can't change it.
   *
   * Edge: the table remembers a slot's end reason for one generation only. A handle never read until its slot has
   * been freed twice (the stealer, or the next voice there, ended too) reads null instead of "stolen" or "failed".
   */
  get reason(): AudioReason | null {
    const t = this.table;
    if (t === null || this.id === 0) return this.finalReason ?? null;
    const index = this.id & 0xffff;
    if (isCurrent(t, this.id)) {
      const s = t.state[index];
      if (s === VoiceState.STOPPING || s === VoiceState.ENDING) return shownEndReason(t.reason[index]);
      return REASON_NAMES[t.reason[index]] ?? null;
    }
    if (this.finalReason !== undefined) return this.finalReason;
    this.finalReason = shownEndReason(t.endedReason(this.id));
    return this.finalReason;
  }

  /**
   * §1: "Stop now, or fade to silence over `fadeSeconds` (default 0) and stop. A second call is a no-op."
   *
   * No-op unless the id is current and not STOPPING or ENDING. A non-finite or negative `fadeSeconds` becomes 0 with
   * a one-time warning. Then `table.requestStop(id, fadeSeconds)`; `playing` reads false at once (§1 "Semantics":
   * `stop()` updates the mirror at once).
   */
  stop(fadeSeconds = 0): void {
    const t = this.table;
    if (t === null || !isActive(t, this.id)) return;
    let seconds = fadeSeconds;
    if (!Number.isFinite(seconds) || seconds < 0) {
      warnOnce("handle.stop.fadeSeconds", `AudioHandle.stop: fadeSeconds ${show(fadeSeconds)} is not a finite number >= 0; using 0.`);
      seconds = 0;
    }
    t.requestStop(this.id, seconds);
  }

  /**
   * §1: "Ease this sound's own gain multiplier to `to` (linear, 0..4) over `seconds` (0 = at once)."
   *
   * No-op unless the id is current and not STOPPING or ENDING. A non-finite `to` is ignored (no-op) with a one-time
   * warning; a finite one is clamped to 0..`MAX_FADE_GAIN`, warning once if it was out of range. A non-finite or
   * negative `seconds` becomes 0 with a one-time warning. Then `table.requestFade(id, to, seconds)`.
   */
  fade(to: number, seconds: number): void {
    const t = this.table;
    if (t === null || !isActive(t, this.id)) return;
    if (!Number.isFinite(to)) {
      warnOnce("handle.fade.to", `AudioHandle.fade: to ${show(to)} is not a finite gain; ignored.`);
      return;
    }
    let gain = to;
    if (gain < 0 || gain > MAX_FADE_GAIN) {
      warnOnce("handle.fade.range", `AudioHandle.fade: to ${String(to)} is outside 0..${MAX_FADE_GAIN}; clamped.`);
      gain = gain < 0 ? 0 : MAX_FADE_GAIN;
    }
    let secs = seconds;
    if (!Number.isFinite(secs) || secs < 0) {
      warnOnce("handle.fade.seconds", `AudioHandle.fade: seconds ${show(seconds)} is not a finite number >= 0; using 0.`);
      secs = 0;
    }
    t.requestFade(this.id, gain, secs);
  }
}

/** @internal Keys already warned about on this page (`warnOnce`). Grows by a handful of keys, never per call. */
const warnedKeys = new Set<string>();

/**
 * @internal Warns once per `key` for the page (§1 "each clamps and warns once"), with the `[myco]` prefix as
 * `mixer.ts` does. Tests reset it with `_resetHandleWarningsForTests`.
 */
export function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(`[myco] ${message}`);
}

/** @internal Tests: forget which warnings were given. */
export function _resetHandleWarningsForTests(): void {
  warnedKeys.clear();
}
