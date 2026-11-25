// ADR 0411 (Record session): who starts and stops `Audio.take` when a connected tool asks (the audio topic's `take.start`
// and `take.stop`). A game build with the take trigger installed (F10, `trigger.ts`) answers through the trigger, so a
// take the Audio Studio starts or stops shows the player the same recording and stopped toasts as F10 does, and the
// trigger's own state follows (the next F10 stops a take the Studio started). Without the trigger (the editor's player),
// the take is driven directly.
import { audioTake } from "./take";

/** What starts and stops a take for a connected tool. */
export interface TakeControl {
  /** Starts a take; rejects with why it couldn't. */
  start(): Promise<void>;
  /** Stops the running take, if any; the tool saves it. */
  stop(): void;
}

const direct: TakeControl = {
  start: () => audioTake.start(),
  stop: () => audioTake.stop(),
};

let control: TakeControl | null = null;

/** @internal Installs `c` (the take trigger) as what answers a tool's start and stop; returns the removal. */
export function setTakeControl(c: TakeControl): () => void {
  control = c;
  return () => {
    if (control === c) control = null;
  };
}

/** @internal A connected tool asks for a take (`take.start`). */
export function startTakeForTool(): Promise<void> {
  return (control ?? direct).start();
}

/** @internal A connected tool stops the take (`take.stop`). */
export function stopTakeForTool(): void {
  (control ?? direct).stop();
}
