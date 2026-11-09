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

/** One queued entry: a one-shot (expires, counts toward the cap) or an owned or looping item (neither). */
interface QueuedItem<T> {
  readonly item: T;
  readonly oneShot: boolean;
  /** `nowMs` at push; meaningful only for one-shots. */
  readonly pushedAt: number;
}

export class UnlockQueue<T> {
  private entries: QueuedItem<T>[] = [];
  private readonly maxOneShots: number;
  private readonly windowMs: number;
  private readonly onDrop: ((item: T, reason: DropReason) => void) | undefined;
  private dropped = 0;

  constructor(options: UnlockQueueOptions<T> = {}) {
    this.maxOneShots = options.maxOneShots ?? MAX_QUEUED_ONE_SHOTS;
    this.windowMs = options.windowMs ?? ONE_SHOT_WINDOW_MS;
    this.onDrop = options.onDrop;
  }

  private isExpired(entry: QueuedItem<T>, nowMs: number): boolean {
    return entry.oneShot && nowMs - entry.pushedAt > this.windowMs;
  }

  private countOneShots(): number {
    let n = 0;
    for (const entry of this.entries) if (entry.oneShot) n++;
    return n;
  }

  private reportDrop(entry: QueuedItem<T>, reason: DropReason): void {
    this.dropped++;
    this.onDrop?.(entry.item, reason);
  }

  /**
   * Queue a one-shot at `nowMs`. First drops (reason "expired") the queued one-shots older than the window at `nowMs`,
   * then, if `maxOneShots` one-shots are still queued, drops the oldest one-shot (reason "overflow"), so the newest
   * `maxOneShots` stay. Owned items are never dropped by this.
   */
  pushOneShot(item: T, nowMs: number): void {
    const expired: QueuedItem<T>[] = [];
    const kept: QueuedItem<T>[] = [];
    for (const entry of this.entries) {
      if (this.isExpired(entry, nowMs)) expired.push(entry);
      else kept.push(entry);
    }
    this.entries = kept;
    for (const entry of expired) this.reportDrop(entry, "expired");

    const entry: QueuedItem<T> = { item, oneShot: true, pushedAt: nowMs };
    if (this.maxOneShots <= 0) {
      this.reportDrop(entry, "overflow");
      return;
    }
    while (this.countOneShots() >= this.maxOneShots) {
      const index = this.entries.findIndex((e) => e.oneShot);
      const [oldest] = this.entries.splice(index, 1);
      this.reportDrop(oldest, "overflow");
    }
    this.entries.push(entry);
  }

  /** Queue an owned or looping item: it waits for `drain` however long that takes and doesn't count toward the one-shot cap. */
  pushOwned(item: T): void {
    this.entries.push({ item, oneShot: false, pushedAt: 0 });
  }

  /**
   * The unlock: calls `start(item)` for every item still queued, in the order they were pushed (one-shots and owned
   * items interleaved), then leaves the queue empty. A one-shot whose age at `nowMs` is more than the window (exactly
   * the window is kept) is dropped with reason "expired" instead, before any `start`. Items pushed from inside
   * `start` are not started by this call.
   */
  drain(nowMs: number, start: (item: T) => void): void {
    // Swap the queue out first, so items pushed from inside `start` or `onDrop` stay queued for a later drain.
    const batch = this.entries;
    this.entries = [];
    const live: QueuedItem<T>[] = [];
    const expired: QueuedItem<T>[] = [];
    for (const entry of batch) {
      if (this.isExpired(entry, nowMs)) expired.push(entry);
      else live.push(entry);
    }
    for (const entry of expired) this.reportDrop(entry, "expired");
    for (const entry of live) start(entry.item);
  }

  /** Take one item out (its voice was stopped before the unlock). True if it was queued. `onDrop` is not called. */
  remove(item: T): boolean {
    const index = this.entries.findIndex((e) => e.item === item);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    return true;
  }

  /** Forget everything without calling `onDrop` or `start` (the host closed). */
  clear(): void {
    this.entries = [];
  }

  /** Items queued, one-shots and owned together. */
  get size(): number {
    return this.entries.length;
  }

  /** One-shots queued. */
  get oneShotCount(): number {
    return this.countOneShots();
  }

  /** One-shots dropped since construction (overflow and expired), for `debug().counters.droppedPlays`. */
  get droppedCount(): number {
    return this.dropped;
  }
}
