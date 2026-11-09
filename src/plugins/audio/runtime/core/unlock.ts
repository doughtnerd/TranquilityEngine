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
  constructor(options: UnlockOptions) {
    throw new Error("not implemented: A0.3-L3");
  }

  /** Whether the gesture listeners are attached. */
  get armed(): boolean {
    throw new Error("not implemented: A0.3-L3");
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
    throw new Error("not implemented: A0.3-L3");
  }

  /** Removes every listener `arm` attached (gesture listeners with `{ capture: true }`). Safe when not armed. */
  disarm(): void {
    throw new Error("not implemented: A0.3-L3");
  }

  /** Disarms for good: later `arm()` calls do nothing. */
  dispose(): void {
    throw new Error("not implemented: A0.3-L3");
  }
}
