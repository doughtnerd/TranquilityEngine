// ADR 0417: take ownership, the one rule for who owns the build's takes (ADR 0408, 0411). It answers three things:
//
// - **Who starts and stops a take for a connected tool** (the audio topic's `take.start` and `take.stop`). A game build
//   with the take trigger installed (F10, `trigger.ts`) answers through the trigger, so a take the Audio Studio starts or
//   stops shows the player the same toasts as F10 does, and the trigger's own state follows (the next F10 stops a take
//   the Studio started). Without the trigger (the editor's player), the take is driven directly.
// - **Whether saving is handed off.** While a tool holds a claim (the audio topic's `take` subscription), the trigger only
//   starts and stops takes and saves nothing itself; the tool uploads the stopped take and saves it where it decides.
// - **The backup.** The build keeps its own copy of every take that stops while a tool owns them, however it stopped, in
//   case the stream is interrupted: an auto-named `<app data>/recordings/*.sporesample` in the newest-16 rotation, on
//   desktop and Android only (a browser would download it). A take the trigger hands off is backed up at once and the
//   trigger learns how the write went, so its toast never promises a copy that wasn't written.
//
// It value-imports no capture codec (`format.ts`, the reader, the events): the trigger, a lazy chunk of its own, and the
// audio topic both import it, and neither may pull `format-*.js` in with it (ADR 0230).
import { isTauri } from "../../../../engine/platform/FileSystem";
import { audioTake, type AudioTake, type AudioTakeState } from "./take";

/** What starts and stops a take for a connected tool. */
export interface TakeControl {
  /** Starts a take; rejects with why it couldn't. */
  start(): Promise<void>;
  /** Stops the running take, if any; the tool saves it. */
  stop(): void;
}

/** How a take the trigger stopped went to the tool: no copy kept (no backups here), a copy kept, or the copy failed. */
export type TakeHandOff = { copy: "none" } | { copy: "kept" } | { copy: "failed"; reason: string };

/** A tool's hold on the build's takes (the audio topic's `take` subscription). */
export interface TakeClaim {
  /** The take's state at each sample: a take seen to stop while the claim is held is backed up (on desktop and Android). */
  observe(state: AudioTakeState): void;
  /** Ends the claim; calling it again does nothing. */
  release(): void;
}

/** Who owns the build's takes. */
export interface TakeOwnership {
  /** A tool claims the build's takes until it releases them. */
  claim(): TakeClaim;
  /** True while a tool owns the takes: the trigger leaves saving to it. */
  handedOff(): boolean;
  /** The trigger stopped a take a tool owns: backs it up when this build keeps copies, and resolves how that went. */
  handOff(): Promise<TakeHandOff>;
  /** Installs `c` (the take trigger) as what answers a tool's start and stop; returns the removal. */
  setControl(c: TakeControl): () => void;
  /** A connected tool asks for a take (`take.start`). */
  startForTool(): Promise<void>;
  /** A connected tool stops the take (`take.stop`). */
  stopForTool(): void;
}

/** What take ownership needs of its surroundings. */
export interface TakeOwnershipEnv {
  /** The take: started and stopped directly when no trigger is installed, and saved for a backup. */
  take: Pick<AudioTake, "start" | "stop" | "save">;
  /** True where a handed-off take gets a backup copy (inside a Tauri webview: desktop, Android). */
  backups(): boolean;
  /** Reports a backup that failed with no trigger to say so. */
  warn(text: string): void;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Take ownership over `env`; the build has one, `takeOwnership`. */
export function createTakeOwnership(env: TakeOwnershipEnv): TakeOwnership {
  const direct: TakeControl = { start: () => env.take.start(), stop: () => env.take.stop() };
  let control: TakeControl | null = null;
  let claims = 0;
  /** The take's state as the claims last saw it (shared, so two claims back a take up once); null with no claim. */
  let seen: AudioTakeState | null = null;
  /** The trigger backed up the take that just stopped: the claims seeing that stop don't save it twice. */
  let backedUp = false;

  const backup = (): Promise<TakeHandOff> =>
    env.take.save().then(
      (): TakeHandOff => ({ copy: "kept" }),
      (err: unknown): TakeHandOff => ({ copy: "failed", reason: message(err) }),
    );

  return {
    claim() {
      claims++;
      let released = false;
      return {
        observe(state) {
          if (released || state === seen) return;
          if (state === "recording") backedUp = false;
          else if (seen === "recording" && state === "stopped") {
            if (backedUp) backedUp = false;
            else if (env.backups()) void backup().then((r) => r.copy === "failed" && env.warn(`[myco] couldn't keep a copy of the take: ${r.reason}`));
          }
          seen = state;
        },
        release() {
          if (released) return;
          released = true;
          if (--claims === 0) {
            seen = null;
            backedUp = false;
          }
        },
      };
    },
    handedOff: () => claims > 0,
    handOff() {
      if (claims === 0 || !env.backups()) return Promise.resolve({ copy: "none" });
      backedUp = true;
      return backup();
    },
    setControl(c) {
      control = c;
      return () => {
        if (control === c) control = null;
      };
    },
    startForTool: () => (control ?? direct).start(),
    stopForTool: () => (control ?? direct).stop(),
  };
}

/** @internal The build's take ownership: `Audio.take`, backed up on desktop and Android. */
export const takeOwnership: TakeOwnership = createTakeOwnership({
  take: audioTake,
  backups: isTauri,
  warn: (text) => console.warn(text),
});
