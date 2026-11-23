/**
 * Deciding a dialogue event's line at runtime (ADR 0355 §2): the pure `decide` with the runtime's context: the World's
 * seeded generator, line availability (the line exists and isn't held by its cooldown or `once`), whether it is
 * recorded in the current language's chain (for `skipMissing`), the global labelled parameters and the event's memory.
 * Shared by `Audio.say` (`dialogueSystem.ts`) and playlist line entries in their event form (0355 §3).
 */
import { decide, type DecideResult } from "../../../../engine/audio/dialogue/decide";
import type { DialogueEvent } from "../../../../engine/audio/dialogue/types";
import { isLabelled } from "../../../../engine/audio/parameters";
import { warnOnce } from "../core/handle";
import { onAudioSessionReleased } from "../audioSession";
import { playlistHost } from "../playlists/host";
import { lineLocation } from "../localisation/lineRegistry";
import { resolveLine } from "../localisation/lineResolve";
import { DialogueMemoryStore } from "./memory";

/** The session's dialogue memory (cooldowns, histories, once-lines). */
export const dialogueMemory = new DialogueMemoryStore();
onAudioSessionReleased(() => dialogueMemory.clear());

/** Whether line `key` can be said at heard `now`: defined, not a said `once` line, out of its cooldown. */
export function lineAvailable(key: string, now: number): boolean {
  const loc = lineLocation(key);
  if (!loc) return false;
  if (loc.line.once && dialogueMemory.saidOnce(key)) return false;
  const since = dialogueMemory.sinceLine(key, now);
  return !(loc.line.cooldown > 0 && since !== null && since < loc.line.cooldown);
}

/** The event's line for `args` now, with `rng` (the World's generator). Never throws. */
export function decideEvent(event: DialogueEvent, args: Readonly<Record<string, string>> | undefined, rng: () => number): DecideResult {
  const host = playlistHost();
  const now = host.clock();
  return decide(event, args, {
    rng,
    available: (key) => lineAvailable(key, now),
    recorded: (key) => resolveLine(key)?.file != null,
    parameter: (name) => {
      const v = host.getGlobal(name);
      return typeof v === "string" ? v : null;
    },
    parameterLabels: (name) => {
      const g = host.globalParameter(name);
      return g && isLabelled(g.def) ? g.def.labels : null;
    },
    history: dialogueMemory.history(event.name),
    warn: (m) => warnOnce(`dialogue:${m}`, m),
  });
}
