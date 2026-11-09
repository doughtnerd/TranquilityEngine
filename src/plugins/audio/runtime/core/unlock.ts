// The unlock layer (ADR 0157; architecture §2.1, §3.1): when autoplay is blocked the context starts
// suspended, and the core loads into it anyway (Locked). The layer then listens for the first user gesture
// and calls `resume()` inside it, so a click or key press starts sound. A0.9 adds the re-arm after
// `interrupted` and after a failed resume; this file is the gesture listener.

/** @internal What the unlock layer needs of an `AudioContext` (a fake in tests). */
export interface UnlockContext {
  readonly state: string;
  resume(): Promise<void>;
  addEventListener(type: "statechange", listener: () => void): void;
  removeEventListener(type: "statechange", listener: () => void): void;
}

/** @internal §3.1: the gestures that unlock, listened to with `{ capture: true, passive: true }`. */
export const UNLOCK_EVENTS = ["pointerdown", "keydown"] as const;

/** @internal */
export interface UnlockOptions {
  /** Where gestures are listened for: `document` in the browser. */
  readonly target: EventTarget;
  readonly context: UnlockContext;
  /** Called once each time an armed layer sees the context reach `"running"`, after it disarmed. */
  readonly onUnlocked?: () => void;
}

/** @internal The gesture listener of §3.1: arm when locked, resume inside the gesture, disarm when running. */
export class Unlock {
  private readonly target: EventTarget;
  private readonly context: UnlockContext;
  private readonly onUnlocked: (() => void) | undefined;
  private isArmed = false;
  private isDisposed = false;

  // Kept as fields so `addEventListener` and `removeEventListener` get the same function.
  private readonly onGesture = (): void => {
    if (!this.isArmed) return;
    // Called synchronously inside the event: browsers allow resume() only there.
    // A rejection is swallowed; the layer stays armed for the next gesture.
    this.context.resume().then(
      () => this.onResolved(),
      () => {},
    );
  };

  private readonly onStateChange = (): void => {
    if (this.context.state === "running") this.unlock();
  };

  constructor(options: UnlockOptions) {
    this.target = options.target;
    this.context = options.context;
    this.onUnlocked = options.onUnlocked;
  }

  /** Whether the gesture listeners are attached. */
  get armed(): boolean {
    return this.isArmed;
  }

  /**
   * §3.1 "arm pointerdown and keydown, capture, passive": attaches a listener for each of `UNLOCK_EVENTS` on the
   * target with `{ capture: true, passive: true }`, and a `statechange` listener on the context. Does nothing when
   * already armed, after `dispose()`, or when the context's state is already `"running"`.
   *
   * Each gesture calls `context.resume()` synchronously inside the event (browsers allow it only there). A rejected
   * resume is swallowed (no unhandled rejection) and the layer stays armed for the next gesture.
   *
   * When the context reaches `"running"` (a `statechange` event, or a resume that resolved with the state
   * `"running"`), the layer disarms and calls `onUnlocked` once.
   */
  arm(): void {
    if (this.isArmed || this.isDisposed || this.context.state === "running") return;
    this.isArmed = true;
    for (const type of UNLOCK_EVENTS) {
      this.target.addEventListener(type, this.onGesture, { capture: true, passive: true });
    }
    this.context.addEventListener("statechange", this.onStateChange);
  }

  /** Removes every listener `arm` attached (gesture listeners with `{ capture: true }`). Safe when not armed. */
  disarm(): void {
    if (!this.isArmed) return;
    this.isArmed = false;
    for (const type of UNLOCK_EVENTS) {
      this.target.removeEventListener(type, this.onGesture, { capture: true });
    }
    this.context.removeEventListener("statechange", this.onStateChange);
  }

  /** Disarms for good: later `arm()` calls do nothing. */
  dispose(): void {
    this.isDisposed = true;
    this.disarm();
  }

  /** A resume that resolved: unlocks only when the context reports `"running"`. */
  private onResolved(): void {
    if (this.context.state === "running") this.unlock();
  }

  /** Disarms, then reports once: a second trigger finds the layer already disarmed. */
  private unlock(): void {
    if (!this.isArmed) return;
    this.disarm();
    this.onUnlocked?.();
  }
}
