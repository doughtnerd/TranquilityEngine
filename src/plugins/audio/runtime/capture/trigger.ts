// ADR 0171 amended by 0172 (M5a, task X1; owner decision 7; api-and-models §8): the built-in capture trigger of an exported
// game. The player installs it only when game.json says `audioCapture` (the Export option): **F9** starts a take, the next F9
// stops it and saves; a **one-second hold of exactly three fingers** does the same on a touch device. A toast says
// "Recording audio…", "Saved <name>" or why nothing happened. The editor never installs it (it has the Profiler panel).
//
// Nothing here runs without `installCaptureTrigger()`: no listener, no timer, no DOM. The recorder stays the lazy chunk
// `capture.ts` loads on the first `start()`, and `save.ts` (for the web's per-session cap) is reached by `import()` on the
// first press, so a game that exports with the option but never presses F9 loads neither.
//
// **Rotation is Rc4's.** `Audio.capture.save()` with no name is an auto-named file; on Tauri and Android `saveCapture` keeps
// the newest 16 of those through `rotateCaptures` (`Storage.list`, `delete`). The trigger saves unnamed and does not copy it.
// A browser cannot delete a download, so the web trigger stops at `CAPTURE_TRIGGER_MAX_FILES` saves per page session and says
// so (R16, `webSaveCount`).
import { isTauri } from "../../../../engine/platform/FileSystem";
import { audioCapture, type AudioCapture } from "./capture";

/** How long exactly three fingers stay down before the touch trigger fires, ms (owner decision 7). */
export const TRIGGER_HOLD_MS = 1000;
/** The key. */
export const TRIGGER_KEY = "F9";
/** Fingers of the touch hold. */
export const TRIGGER_FINGERS = 3;
/** How long a toast stays, ms. */
export const TOAST_MS = 3000;

export const TOAST_RECORDING = "Recording audio…";
export const toastSaved = (name: string): string => `Saved ${name}`;
export const toastCap = (max: number): string => `Capture limit reached: this page has saved ${max} captures, and a browser can't delete downloads. Reload the page to record more.`;

/** What the trigger needs of its surroundings; every member has a real default, so a test passes fakes. */
export interface TriggerEnv {
  capture: Pick<AudioCapture, "state" | "start" | "stop" | "save">;
  /** Where the key and touch events arrive (the window). */
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  /** Shows a message to the player. */
  toast(text: string): void;
  /** True inside a Tauri webview (desktop, Android): files rotate instead of stopping at the cap. */
  tauri: boolean;
  /** Downloads this page has saved, and the cap (`save.ts`); loaded on the first press. */
  webSaves(): Promise<{ count: number; max: number }>;
  /** Runs `fn` after `ms` and returns the cancel. */
  schedule(fn: () => void, ms: number): () => void;
}

/** A touch list's length, from the shape of a `TouchEvent` (a fake has only `touches.length`). */
const touchCount = (e: Event): number => (e as unknown as { touches?: { length: number } }).touches?.length ?? 0;

/** The name a toast shows: a web file name as it is, a Tauri `<appData>/cache/<key>.bin` path as the capture's own file name. */
export function savedName(result: string): string {
  const leaf = result.split(/[\\/]/).pop() ?? result;
  const bare = leaf.replace(/\.bin$/i, "");
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The default toast: one `role="status"` line at the bottom of the page, replaced by the next and removed after `TOAST_MS`. */
function domToast(schedule: TriggerEnv["schedule"]): { show(text: string): void; dispose(): void } {
  let el: HTMLElement | null = null;
  let cancel: (() => void) | null = null;
  const remove = (): void => {
    cancel?.();
    cancel = null;
    el?.remove();
    el = null;
  };
  return {
    show(text) {
      if (typeof document === "undefined") return;
      if (!el) {
        el = document.createElement("div");
        el.setAttribute("role", "status");
        el.setAttribute("aria-live", "polite");
        el.dataset.mycoToast = "audio-capture";
        Object.assign(el.style, {
          position: "fixed", left: "50%", bottom: "24px", transform: "translateX(-50%)", maxWidth: "min(90vw, 480px)", padding: "8px 14px",
          borderRadius: "6px", background: "rgba(20, 20, 24, 0.9)", color: "#fff", font: "14px/1.4 system-ui, sans-serif", zIndex: "2147483647",
          pointerEvents: "none", textAlign: "center",
        });
        document.body.appendChild(el);
      }
      el.textContent = text;
      cancel?.();
      cancel = schedule(remove, TOAST_MS);
    },
    dispose: remove,
  };
}

const timerSchedule: TriggerEnv["schedule"] = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

/**
 * Installs the trigger and returns what removes it. `env` overrides the defaults (tests). Calling it twice installs two
 * triggers; the player calls it once.
 */
export function installCaptureTrigger(env: Partial<TriggerEnv> = {}): () => void {
  const schedule = env.schedule ?? timerSchedule;
  const dom = env.toast ? null : domToast(schedule);
  const toast = env.toast ?? ((text: string) => dom!.show(text));
  const capture = env.capture ?? audioCapture;
  const target = env.target ?? (globalThis as unknown as { window: EventTarget }).window;
  const tauri = env.tauri ?? isTauri();
  const webSaves =
    env.webSaves ??
    (async () => {
      const { webSaveCount } = await import("./save");
      const { CAPTURE_TRIGGER_MAX_FILES } = await import("./format");
      return { count: webSaveCount(), max: CAPTURE_TRIGGER_MAX_FILES };
    });

  /** A press is being handled (the chunk loading, the file compressing): another press waits for it. */
  let busy = false;

  const toggle = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      if (capture.state === "recording") {
        capture.stop();
        try {
          toast(toastSaved(savedName(await capture.save())));
        } catch (err) {
          toast(message(err));
        }
        return;
      }
      if (!tauri) {
        const { count, max } = await webSaves();
        if (count >= max) {
          toast(toastCap(max));
          return;
        }
      }
      toast(TOAST_RECORDING);
      try {
        await capture.start();
      } catch (err) {
        toast(message(err));
      }
    } finally {
      busy = false;
    }
  };

  const onKey = (e: Event): void => {
    const k = e as KeyboardEvent;
    if (k.key !== TRIGGER_KEY || k.repeat) return;
    if (k.ctrlKey || k.altKey || k.metaKey || k.shiftKey) return;
    k.preventDefault();
    void toggle();
  };

  // The touch hold: exactly three fingers down for TRIGGER_HOLD_MS. Any change in the count before then cancels it, and a
  // hold that fired waits for the fingers to lift below three before it can fire again.
  let cancelHold: (() => void) | null = null;
  let fired = false;
  const onTouch = (e: Event): void => {
    const n = touchCount(e);
    cancelHold?.();
    cancelHold = null;
    if (n < TRIGGER_FINGERS) fired = false;
    if (n !== TRIGGER_FINGERS || fired) return;
    cancelHold = schedule(() => {
      cancelHold = null;
      fired = true;
      void toggle();
    }, TRIGGER_HOLD_MS);
  };

  const capturing = { capture: true } as const;
  target.addEventListener("keydown", onKey, capturing);
  for (const type of ["touchstart", "touchend", "touchcancel"]) target.addEventListener(type, onTouch, { capture: true, passive: true });
  return () => {
    target.removeEventListener("keydown", onKey, capturing);
    for (const type of ["touchstart", "touchend", "touchcancel"]) target.removeEventListener(type, onTouch, { capture: true });
    cancelHold?.();
    cancelHold = null;
    dom?.dispose();
  };
}
