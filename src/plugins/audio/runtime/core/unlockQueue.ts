// The locked queue (ADR 0157 D5; architecture §2.1 and §3.1; api-and-models §1 `OneShotOptions.at` and "locked").
// While `Audio.status` is "locked" the browser hasn't let audio start. A one-shot played then is not lost at once: up to
// `MAX_QUEUED_ONE_SHOTS` of the last `ONE_SHOT_WINDOW_MS` are kept and start on unlock, because a click that unlocks
// audio often follows the sound the click was meant to cause (a menu "select"). Older or surplus one-shots are
// dropped: a minute-old footstep must not fire when a player finally clicks. Owned voices (an `AudioSource`'s) and
// looping voices are never dropped or expired: they wait for the unlock and start with it (D5).
//
// A pure data structure: no clock of its own (callers pass `nowMs`, any monotonic millisecond clock) and no knowledge
// of voices (`T` is whatever the caller queues, e.g. a voice id). `CoreBackend` owns one and calls `drain` when the
// host reaches "running".

/** D5: at most this many one-shots wait for the unlock. */
export const MAX_QUEUED_ONE_SHOTS = 32;
/** D5: a queued one-shot older than this (milliseconds) is dropped at the unlock. */
export const ONE_SHOT_WINDOW_MS = 1000;

/** Why an item left the queue without starting. */
export type DropReason = "overflow" | "expired";

export interface UnlockQueueOptions<T> {
  /** Default `MAX_QUEUED_ONE_SHOTS`. */
  maxOneShots?: number;
  /** Default `ONE_SHOT_WINDOW_MS`. */
  windowMs?: number;
  /** Called once for each item dropped by `pushOneShot` (overflow, expired) or `drain` (expired), so the owner can free it. Not called by `remove` or `clear`. */
  onDrop?: (item: T, reason: DropReason) => void;
}

export class UnlockQueue<T> {
  constructor(options: UnlockQueueOptions<T> = {}) {
    void options;
    throw new Error("A1.6 L1: UnlockQueue is not implemented yet");
  }

  /**
   * Queue a one-shot at `nowMs`. First drops (reason "expired") the queued one-shots older than the window at `nowMs`,
   * then, if `maxOneShots` one-shots are still queued, drops the oldest one-shot (reason "overflow"), so the newest
   * `maxOneShots` stay. Owned items are never dropped by this.
   */
  pushOneShot(item: T, nowMs: number): void {
    void item;
    void nowMs;
    throw new Error("A1.6 L1");
  }

  /** Queue an owned or looping item: it waits for `drain` however long that takes and doesn't count toward the one-shot cap. */
  pushOwned(item: T): void {
    void item;
    throw new Error("A1.6 L1");
  }

  /**
   * The unlock: calls `start(item)` for every item still queued, in the order they were pushed (one-shots and owned
   * items interleaved), then leaves the queue empty. A one-shot whose age at `nowMs` is more than the window (exactly
   * the window is kept) is dropped with reason "expired" instead, before any `start`. Items pushed from inside
   * `start` are not started by this call.
   */
  drain(nowMs: number, start: (item: T) => void): void {
    void nowMs;
    void start;
    throw new Error("A1.6 L1");
  }

  /** Take one item out (its voice was stopped before the unlock). True if it was queued. `onDrop` is not called. */
  remove(item: T): boolean {
    void item;
    throw new Error("A1.6 L1");
  }

  /** Forget everything without calling `onDrop` or `start` (the host closed). */
  clear(): void {
    throw new Error("A1.6 L1");
  }

  /** Items queued, one-shots and owned together. */
  get size(): number {
    throw new Error("A1.6 L1");
  }

  /** One-shots queued. */
  get oneShotCount(): number {
    throw new Error("A1.6 L1");
  }

  /** One-shots dropped since construction (overflow and expired), for `debug().counters.droppedPlays`. */
  get droppedCount(): number {
    throw new Error("A1.6 L1");
  }
}
