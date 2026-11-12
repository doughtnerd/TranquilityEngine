// Background modes, hidden-tab behaviour, device events and stall detection (ADR 0157 A3.4b; architecture §2.1, §3.7,
// §3.8, §4.5, §7; api-and-models §2 `audio.background`).
//
// One controller per core backend. It watches `visibilitychange` and applies the project's `audio.background`:
//   mute   MASTER to 0 over 50 ms, flushed at once (no frame will flush it), restored over 50 ms when visible again.
//          Voices keep time, STATUS keeps flowing.
//   pause  MASTER to 0 over 30 ms, then the context is suspended (the voices freeze with it); resumed when visible.
//   play   nothing.
// While the page is hidden `mirror.freeEndedInMessage` is on, so ended voices are freed from STATUS handling, not from
// `update()` (rAF stops hidden): a handle reads `playing = false` and the slot returns to the pool.
// On becoming visible the clock map re-anchors (§3.8).
//
// It also feeds `deviceChange.ts`: on `devicechange`, `sinkchange`, `statechange` and every `STALL_CHECK_MS` it builds
// an observation, classifies it, and resumes the context or calls K6's `rebuild(reason)`. A worklet stall (no STATUS for
// 1 s while running and visible) is `rebuild("stall")`; an `interrupted` context that hasn't resumed after 2 s is
// `rebuild("device")`.
//
// Everything it touches comes in through `BackgroundHost` and `BackgroundTarget`, so Node tests drive it with fakes and
// vitest's fake timers.
//
// ADR 0166 P9 (architecture §3.8, ADR 0167 owner decision 5): music keeps its place while hidden under `play` and
// `mute`. Each visibility change goes to `music/background.ts` (`noteHidden`), and while hidden under either mode the
// controller listens to the host's STATUS (after the mirror applied it) and hands each block to `tickHidden`, which
// ticks the music players and flushes their batch. A target without `music` (a fake) or a host without a link skips it.
import type { AudioBackend, AudioBackground } from "../backend";
import { classifyDeviceChange, INTERRUPTED_RETRY_MS, type DeviceSnapshot, type DeviceVerdict } from "./deviceChange";
import { rebuild as rebuildCore, type RebuildOutcome, type RebuildReason } from "./recovery";
import { noteHidden, tickHidden } from "../music/background";

/** §3.8: MASTER ramp when muting or unmuting for `mute`, ms. */
export const MUTE_RAMP_MS = 50;
/** §3.8: MASTER ramp before a `pause` suspend, ms. */
export const PAUSE_RAMP_MS = 30;
/** §3.8: the suspend follows the fade after this long (ms), a little more than the ramp. */
export const PAUSE_SUSPEND_DELAY_MS = 40;
/** How often the heartbeat is judged (ms). A hidden page's timers run at 1 Hz at most, which only matters while visible. */
export const HEALTH_CHECK_MS = 250;

/** The page's visibility (`document`, or a fake). */
export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** @internal The page's `document` when there is one. */
export const pageVisibility = (): VisibilitySource | null => (typeof document !== "undefined" ? (document as unknown as VisibilitySource) : null);

/** What the controller does to the backend (`CoreBackend` implements it). */
export interface BackgroundTarget {
  /** `audio.background` as last set. */
  readonly backgroundMode: AudioBackground;
  /** STATUS blocks applied so far: the heartbeat. */
  readonly statusBlocks: number;
  /** The page is hidden or not: ended voices are freed in the STATUS handler while it is. */
  setHidden(hidden: boolean): void;
  /** MASTER to 0 (`true`) or back (`false`) over `rampMs`, sent and flushed at once. */
  hiddenMute(on: boolean, rampMs: number): void;
  /** Re-anchor the clock map (§3.8). */
  reanchor(): void;
}

/** What the controller needs of the `AudioHost`. */
export interface BackgroundHost {
  readonly closed: boolean;
  readonly status: "locked" | "running" | "failed";
  snapshot(): DeviceSnapshot;
  probeDeviceRate(): Promise<number | null>;
  onDeviceEvent(listener: (kind: "device" | "state") => void): () => void;
  suspendForBackground(): Promise<boolean>;
  resumeFromBackground(): Promise<boolean>;
  resumeContext(): Promise<boolean>;
  readonly pageSuspended: boolean;
  /** ADR 0166 P9: the host's link, whose STATUS ticks the music while hidden (absent on fakes: no hidden music tick). */
  readonly link?: { onStatus(listener: () => void): () => void };
}

/** §8 counters this controller owns. */
export interface BackgroundCounters {
  /** Times the page went hidden. */
  backgroundEnters: number;
  /** Times the context entered `interrupted`. */
  interruptions: number;
  /** Rebuilds this controller asked for, by reason (the rebuild's own counters are A3.4a's). */
  rebuildsAsked: Record<"stall" | "device" | "rate", number>;
}

export interface BackgroundDeps {
  host: BackgroundHost;
  target: BackgroundTarget;
  /** Defaults to `document`; null (no page) means never hidden. */
  visibility?: VisibilitySource | null;
  /** Defaults to K6's `rebuild`. */
  rebuild?: (reason: RebuildReason) => Promise<RebuildOutcome>;
  /** Defaults to `performance.now()`, ms. */
  now?: () => number;
  /** Called on each device event (`devicechange`, `sinkchange`) before the controller evaluates it (Rh2's calibration). */
  onDevice?: () => void;
}

/** @internal The §3.8 / §3.7 controller. `start()` attaches it; `dispose()` detaches. */
export class BackgroundController {
  readonly counters: BackgroundCounters = { backgroundEnters: 0, interruptions: 0, rebuildsAsked: { stall: 0, device: 0, rate: 0 } };

  private readonly host: BackgroundHost;
  private readonly target: BackgroundTarget;
  private readonly visibility: VisibilitySource | null;
  private readonly rebuildFn: (reason: RebuildReason) => Promise<RebuildOutcome>;
  private readonly now: () => number;

  private hiddenNow = false;
  /** The mode applied at `enter`, so `leave` undoes what was done even if the setting changed meanwhile. */
  private applied: AudioBackground | null = null;
  /** Bumped by every visibility change: a late async step from an earlier one does nothing. */
  private epoch = 0;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private interruptTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBlocks = 0;
  private lastBlockAt = 0;
  private lastSnapshot: DeviceSnapshot;
  private readonly onDevice: (() => void) | undefined;
  private interruptedSince: number | null = null;
  private busy = false;
  private again = false;
  private disposed = false;
  private offDevice: (() => void) | null = null;
  private started = false;
  /** ADR 0166 P9: the STATUS subscription that ticks the music while hidden, or null. */
  private offHiddenStatus: (() => void) | null = null;

  private readonly onVisibility = (): void => {
    if (this.disposed) return;
    if (this.visibility?.hidden) this.enter();
    else void this.leave();
  };

  constructor(deps: BackgroundDeps) {
    this.host = deps.host;
    this.target = deps.target;
    this.visibility = deps.visibility === undefined ? pageVisibility() : deps.visibility;
    this.rebuildFn = deps.rebuild ?? rebuildCore;
    this.onDevice = deps.onDevice;
    this.now = deps.now ?? (() => performance.now());
    this.lastSnapshot = this.host.snapshot();
    this.lastBlocks = this.target.statusBlocks;
    this.lastBlockAt = this.now();
  }

  /** Whether the page is hidden as far as the controller knows. */
  get hidden(): boolean {
    return this.hiddenNow;
  }

  /** Starts listening (visibility, device events, the heartbeat check). A page that is already hidden enters at once. */
  start(): this {
    if (this.started || this.disposed) return this;
    this.started = true;
    this.visibility?.addEventListener("visibilitychange", this.onVisibility);
    this.offDevice = this.host.onDeviceEvent((kind) => {
      if (kind === "device") this.onDevice?.();
      void this.evaluate(kind === "device");
    });
    this.healthTimer = setInterval(() => void this.evaluate(false), HEALTH_CHECK_MS);
    // A timer must never keep Node (tests, the export tool) alive.
    (this.healthTimer as { unref?: () => void }).unref?.();
    if (this.visibility?.hidden) this.enter();
    return this;
  }

  /** Stops listening and cancels timers. Leaves MASTER as it is: the backend is being torn down. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.visibility?.removeEventListener("visibilitychange", this.onVisibility);
    this.offDevice?.();
    this.offDevice = null;
    if (this.healthTimer !== null) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.clearPauseTimer();
    this.clearInterruptTimer();
    if (this.hiddenNow) {
      this.target.setHidden(false);
      this.stopHiddenMusic();
    }
  }

  /** ADR 0166 P9: from here on each STATUS ticks the music players (see the header). */
  private startHiddenMusic(): void {
    noteHidden(true);
    const backend = this.target as Partial<AudioBackend>;
    const link = this.host.link;
    if (!link || backend.music === undefined || this.offHiddenStatus !== null) return;
    this.offHiddenStatus = link.onStatus(() => {
      if (this.hiddenNow && !this.disposed) tickHidden(backend as AudioBackend);
    });
  }

  private stopHiddenMusic(): void {
    noteHidden(false);
    this.offHiddenStatus?.();
    this.offHiddenStatus = null;
  }

  // --- Visibility (§3.8) ---

  private enter(): void {
    if (this.hiddenNow) return;
    this.hiddenNow = true;
    const epoch = ++this.epoch;
    this.counters.backgroundEnters++;
    // Ended voices are freed in the STATUS handler from here on (no frame will do it).
    this.target.setHidden(true);
    const mode = this.target.backgroundMode;
    this.applied = mode;
    if (mode === "play" || mode === "mute") this.startHiddenMusic();
    if (mode === "mute") {
      this.target.hiddenMute(true, MUTE_RAMP_MS);
    } else if (mode === "pause") {
      this.target.hiddenMute(true, PAUSE_RAMP_MS);
      this.pauseTimer = setTimeout(() => {
        this.pauseTimer = null;
        if (this.hiddenNow && epoch === this.epoch && !this.disposed) void this.host.suspendForBackground();
      }, PAUSE_SUSPEND_DELAY_MS);
    }
  }

  private async leave(): Promise<void> {
    if (!this.hiddenNow) return;
    this.hiddenNow = false;
    const epoch = ++this.epoch;
    this.clearPauseTimer();
    const mode = this.applied;
    this.applied = null;
    this.target.setHidden(false);
    this.stopHiddenMusic();
    if (mode === "pause") {
      await this.host.resumeFromBackground();
      if (epoch !== this.epoch || this.disposed) return;
    }
    this.target.reanchor();
    if (mode === "mute" || mode === "pause") this.target.hiddenMute(false, MUTE_RAMP_MS);
    // STATUS was slow or absent while hidden: the heartbeat's grace starts now.
    this.lastBlocks = this.target.statusBlocks;
    this.lastBlockAt = this.now();
  }

  // --- Device events and the heartbeat (§3.7, §7) ---

  /**
   * One look at the context and the heartbeat: classify and act. `deviceEvent` (a `devicechange` or `sinkchange`)
   * also probes the device's rate. Serialised: an event during a rebuild or a probe is run again afterwards.
   */
  private async evaluate(deviceEvent: boolean): Promise<void> {
    if (this.disposed || this.host.closed) return;
    if (this.busy) {
      if (deviceEvent) this.again = true;
      return;
    }
    this.busy = true;
    try {
      let probe = deviceEvent;
      do {
        this.again = false;
        await this.evaluateOnce(probe);
        probe = true;
      } while (this.again && !this.disposed && !this.host.closed);
    } finally {
      this.busy = false;
    }
  }

  private async evaluateOnce(deviceEvent: boolean): Promise<void> {
    const t = this.now();
    const blocks = this.target.statusBlocks;
    if (blocks !== this.lastBlocks) {
      this.lastBlocks = blocks;
      this.lastBlockAt = t;
    }
    const before = this.lastSnapshot;
    const after = this.host.snapshot();
    this.lastSnapshot = after;
    if (after.state === "interrupted") {
      if (this.interruptedSince === null) {
        this.interruptedSince = t;
        this.counters.interruptions++;
        // The resume is retried for 2 s; then this look rebuilds.
        this.interruptTimer = setTimeout(() => {
          this.interruptTimer = null;
          void this.evaluate(false);
        }, INTERRUPTED_RETRY_MS);
      }
    } else {
      this.interruptedSince = null;
      this.clearInterruptTimer();
    }
    const deviceRate = deviceEvent && after.state === "running" ? await this.host.probeDeviceRate() : null;
    const verdict: DeviceVerdict = classifyDeviceChange({
      before,
      after: this.host.snapshot(),
      deviceRate,
      heartbeatAgeMs: this.host.status === "running" ? t - this.lastBlockAt : null,
      visible: !this.hiddenNow,
      pageSuspended: this.host.pageSuspended,
      interruptedForMs: this.interruptedSince === null ? 0 : t - this.interruptedSince,
    });
    await this.act(verdict);
  }

  private async act(verdict: DeviceVerdict): Promise<void> {
    if (verdict.action === "leave") return;
    if (verdict.action === "resume") {
      await this.host.resumeContext();
      return;
    }
    this.counters.rebuildsAsked[verdict.reason]++;
    try {
      await this.rebuildFn(verdict.reason);
    } catch (err) {
      console.error("[myco] audio rebuild failed:", err);
    }
    // A fresh node starts from no heartbeat: the grace starts after the rebuild, whatever its outcome. A context still
    // interrupted gets a new 2 s window (the same interruption, not counted again).
    this.lastBlocks = this.target.statusBlocks;
    this.lastBlockAt = this.now();
    if (this.interruptedSince !== null) this.interruptedSince = this.lastBlockAt;
    this.lastSnapshot = this.host.snapshot();
  }

  private clearPauseTimer(): void {
    if (this.pauseTimer !== null) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
  }

  private clearInterruptTimer(): void {
    if (this.interruptTimer !== null) clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
  }
}
