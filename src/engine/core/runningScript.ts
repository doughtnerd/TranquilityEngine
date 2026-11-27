// ADR 0435: which game code is running now. The World notes the behaviour hook it calls (`World.invoke`, every hook and
// message) and the scheduler the defined system it runs (`Scheduler.runUser`), so an engine service a script calls can
// say who asked: the audio profiler's "Why it played" names the GameObject, behaviour and system that started a sound.
// Writing costs two field stores and their restores per call (no allocation); `runningScript` builds its answer only
// when asked. Code that runs after an `await`, or from a timer or a DOM event, runs outside any hook and reads null.
import type { GameBehavior } from "./Component";

/** @internal The writers' state: set and restored around each call by `World.invoke` and `Scheduler.runUser`. */
export const _running: { behaviour: GameBehavior | null; hook: string; system: string | null } = { behaviour: null, hook: "", system: null };

/** What is running now: the behaviour and its hook (a nested hook, from `sendMessage`, wins), and the defined system. */
export interface RunningScript {
  /** The behaviour whose hook is running, or null. */
  readonly behaviour: GameBehavior | null;
  /** That hook's name ("update", "onCollisionEnter"), or null with no behaviour. */
  readonly hook: string | null;
  /** The defined system (`defineSystem`) running, by name, or null. Built-in systems aren't named. */
  readonly system: string | null;
}

/** @internal The game code running now, or null when no behaviour hook or defined system is on the stack. */
export function runningScript(): RunningScript | null {
  const { behaviour, hook, system } = _running;
  if (!behaviour && system === null) return null;
  return { behaviour, hook: behaviour ? hook : null, system };
}
