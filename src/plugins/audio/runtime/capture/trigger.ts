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
// the newest 16 of those through `rotateCaptures` (`list`, `remove` over the `recordings/` folder). The trigger saves unnamed and does not copy it.
// A browser cannot delete a download, so the web trigger stops at `CAPTURE_TRIGGER_MAX_FILES` saves per page session and says
// so (R16, `webSaveCount`).
//
// **Takes (ADR 0348).** `installTakeTrigger()` is the same trigger for `Audio.take` on **F10** (game.json `audioTake`): a
// take records what the game asked of audio beside the profile, and saves a `*.sporesample`. It has no touch gesture (three
// fingers are the capture's; more fingers collide with the platforms' own gestures). While the Audio Studio is connected
// and owns the build's takes (ADR 0408; take ownership, `takeOwnership.ts`, ADR 0417), F10 only starts and stops: the
// Studio uploads and saves, and the build keeps a backup copy in app data on desktop and Android. The toast says a copy is
// kept only once that copy is written, and says so when it couldn't be. ADR 0411: a take the Studio starts or stops (the
// audio topic's `take.start` and `take.stop`) goes through this trigger too, so the player sees the same toasts as for
// F10 and the next F10 stops a take the Studio started.
import { isTauri } from "../../../../engine/platform/FileSystem";
import { audioCapture, type AudioCapture } from "./capture";
import { audioTake } from "./take";
import { takeOwnership, type TakeHandOff, type TakeOwnership } from "./takeOwnership";

/** How long exactly three fingers stay down before the touch trigger fires, ms (owner decision 7). */
const TRIGGER_HOLD_MS = 1000;
/** The key. */
export const TRIGGER_KEY = "F9";
/** ADR 0348: the take trigger's key. */
export const TAKE_TRIGGER_KEY = "F10";
/** Fingers of the touch hold. */
export const TRIGGER_FINGERS = 3;
/** How long a toast stays, ms. */
export const TOAST_MS = 3000;

const TOAST_RECORDING = "Recording audio…";
const TOAST_RECORDING_TAKE = "Recording a take…";
const toastSaved = (name: string): string => `Saved ${name}`;
const TOAST_HANDED_OFF = "Take stopped: the Audio Studio saves it";
/** ADR 0408: desktop and Android keep their own copy of a take they hand off, in app data; said once it is written (ADR 0417). */
const TOAST_HANDED_OFF_COPY = "Take sent to the Audio Studio (a copy is kept in app data)";
const toastHandedOffNoCopy = (reason: string): string => `Take sent to the Audio Studio, but no copy could be kept in app data: ${reason}`;
const toastCap = (max: number): string => `Capture limit reached: this page has saved ${max} captures, and a browser can't delete downloads. Reload the page to record more.`;

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
  /**
   * ADR 0408, 0417: who owns the takes (the take trigger's: `takeOwnership`; the capture trigger's: none). While a
   * connected tool does, the trigger only starts and stops, the tool saves, and the trigger answers the tool's start and stop.
   */
  ownership: TakeOwnership | null;
}

/** A touch list's length, from the shape of a `TouchEvent` (a fake has only `touches.length`). */
const touchCount = (e: Event): number => (e as unknown as { touches?: { length: number } }).touches?.length ?? 0;

/** The name a toast shows: a web file name as it is, a Tauri file path as its leaf name. */
function savedName(result: string): string {
  return result.split(/[\\/]/).pop() ?? result;
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
  return installTrigger(env, { key: TRIGGER_KEY, recording: TOAST_RECORDING, touch: true, capture: audioCapture });
}

/**
 * ADR 0348: installs the take trigger (F10 starts `Audio.take`, the next F10 stops and saves it) and returns what removes it.
 * The player calls it once when game.json says `audioTake`. `env.capture` stands for the take (tests).
 */
export function installTakeTrigger(env: Partial<TriggerEnv> = {}): () => void {
  return installTrigger({ ownership: takeOwnership, ...env }, { key: TAKE_TRIGGER_KEY, recording: TOAST_RECORDING_TAKE, touch: false, capture: audioTake });
}

interface TriggerSpec {
  key: string;
  recording: string;
  touch: boolean;
  capture: TriggerEnv["capture"];
}

function installTrigger(env: Partial<TriggerEnv>, spec: TriggerSpec): () => void {
  const schedule = env.schedule ?? timerSchedule;
  const dom = env.toast ? null : domToast(schedule);
  const toast = env.toast ?? ((text: string) => dom!.show(text));
  const capture = env.capture ?? spec.capture;
  const target = env.target ?? (globalThis as unknown as { window: EventTarget }).window;
  const tauri = env.tauri ?? isTauri();
  const ownership = env.ownership ?? null;
  const handedOff = (): boolean => ownership?.handedOff() ?? false;
  const webSaves =
    env.webSaves ??
    (async () => {
      const { webSaveCount } = await import("./save");
      const { CAPTURE_TRIGGER_MAX_FILES } = await import("./format");
      return { count: webSaveCount(), max: CAPTURE_TRIGGER_MAX_FILES };
    });

  /** A press is being handled (the chunk loading, the file compressing): another press waits for it. */
  let busy = false;
  /**
   * This trigger started the recording and hasn't saved it. A recording that stopped by itself (ADR 0348: the take cap,
   * the recorder released) reads "stopped", not "recording": the next press saves it instead of starting over it.
   */
  let unsaved = false;

  /** Hands a stopped take to the tool and says how that went: a copy is promised only once it is written. */
  const handOff = async (): Promise<void> => {
    const r: TakeHandOff = ownership ? await ownership.handOff() : { copy: "none" };
    toast(r.copy === "kept" ? TOAST_HANDED_OFF_COPY : r.copy === "failed" ? toastHandedOffNoCopy(r.reason) : TOAST_HANDED_OFF);
  };

  /** Says it records and starts; resolves once recording, else toasts why and rejects. */
  const begin = async (): Promise<void> => {
    toast(spec.recording);
    try {
      await capture.start();
      unsaved = true;
    } catch (err) {
      toast(message(err));
      throw err;
    }
  };

  const toggle = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const state = capture.state;
      if (state === "recording" || (unsaved && state === "stopped")) {
        unsaved = false;
        if (state === "recording") capture.stop();
        if (handedOff()) {
          await handOff();
          return;
        }
        try {
          toast(toastSaved(savedName(await capture.save())));
        } catch (err) {
          toast(message(err));
        }
        return;
      }
      if (!tauri && !handedOff()) {
        const { count, max } = await webSaves();
        if (count >= max) {
          toast(toastCap(max));
          return;
        }
      }
      await begin().catch(() => {}); // toasted
    } finally {
      busy = false;
    }
  };

  // ADR 0411: the Studio's Record session. Its start never meets the web's save cap (the Studio saves the take), and its
  // stop leaves the take to the Studio, saying so as F10 does when the Studio owns the takes.
  const removeControl = ownership
    ? ownership.setControl({
        start: async () => {
          if (capture.state === "recording") return;
          await begin();
        },
        stop: () => {
          if (capture.state !== "recording") return;
          unsaved = false;
          capture.stop();
          void handOff();
        },
      })
    : null;

  const onKey = (e: Event): void => {
    const k = e as KeyboardEvent;
    if (k.key !== spec.key || k.repeat) return;
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
  const touches = spec.touch ? ["touchstart", "touchend", "touchcancel"] : [];
  target.addEventListener("keydown", onKey, capturing);
  for (const type of touches) target.addEventListener(type, onTouch, { capture: true, passive: true });
  return () => {
    target.removeEventListener("keydown", onKey, capturing);
    for (const type of touches) target.removeEventListener(type, onTouch, { capture: true });
    cancelHold?.();
    cancelHold = null;
    removeControl?.();
    dom?.dispose();
  };
}
