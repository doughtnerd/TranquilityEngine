/**
 * Dialogue memory (ADR 0355 §4–§5): what the dialogue events have said this session, for cooldowns, avoid-repeat and
 * once-lines. One per page's audio session (the World's life in a game: a World and its audio session end together),
 * kept on the heard clock, saved and restored by the game as plain JSON (`Audio.dialogue.memory()` / `restore`), with
 * times relative to now so a save loads into any session.
 */
import { rememberLine } from "../../../../engine/audio/dialogue/decide";

/** `Audio.dialogue.memory()`: plain JSON. Times are seconds since (so ≥ 0), relative to when it was taken. */
export interface DialogueMemory {
  /** Per event: seconds since it last spoke, and its last spoken line keys (newest last, at most 8). */
  events: Record<string, { since: number | null; history: string[] }>;
  /** Per line key: seconds since it was last said by an event. */
  lines: Record<string, number>;
  /** Line keys with `once` that were said (never again this session). */
  once: string[];
}

export class DialogueMemoryStore {
  private readonly eventSpoke = new Map<string, number>();
  private readonly histories = new Map<string, string[]>();
  private readonly lineSaid = new Map<string, number>();
  private readonly onceSaid = new Set<string>();

  /** The event's last spoken lines, newest last. */
  history(event: string): readonly string[] {
    return this.histories.get(event) ?? [];
  }

  /** Seconds since the event last spoke at heard `now`; null when it never has. */
  sinceEvent(event: string, now: number): number | null {
    const t = this.eventSpoke.get(event);
    return t === undefined ? null : Math.max(0, now - t);
  }

  /** Seconds since the line was last said at `now`; null when never. */
  sinceLine(key: string, now: number): number | null {
    const t = this.lineSaid.get(key);
    return t === undefined ? null : Math.max(0, now - t);
  }

  /** Whether a `once` line has been said. */
  saidOnce(key: string): boolean {
    return this.onceSaid.has(key);
  }

  /** `event` (null for a line said outside an event) spoke `key` at `now`; `once`: the line is never said again. */
  spoke(event: string | null, key: string, now: number, once: boolean): void {
    if (event !== null) {
      this.eventSpoke.set(event, now);
      this.histories.set(event, rememberLine(this.histories.get(event) ?? [], key));
    }
    this.lineSaid.set(key, now);
    if (once) this.onceSaid.add(key);
  }

  /** The memory as plain JSON at heard `now`. */
  save(now: number): DialogueMemory {
    const events: DialogueMemory["events"] = {};
    for (const name of new Set([...this.eventSpoke.keys(), ...this.histories.keys()])) {
      events[name] = { since: this.sinceEvent(name, now), history: [...(this.histories.get(name) ?? [])] };
    }
    const lines: Record<string, number> = {};
    for (const [k, t] of this.lineSaid) lines[k] = Math.max(0, now - t);
    return { events, lines, once: [...this.onceSaid] };
  }

  /** Replaces the memory with `m` (a `save`, possibly from another session) at heard `now`; bad values are skipped. */
  restore(m: unknown, now: number): void {
    this.clear();
    if (typeof m !== "object" || m === null) return;
    const o = m as Partial<DialogueMemory>;
    const finiteSince = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
    if (typeof o.events === "object" && o.events !== null) {
      for (const [name, e] of Object.entries(o.events)) {
        if (typeof e !== "object" || e === null) continue;
        if (finiteSince(e.since)) this.eventSpoke.set(name, now - e.since);
        if (Array.isArray(e.history)) this.histories.set(name, e.history.filter((k): k is string => typeof k === "string").slice(-8));
      }
    }
    if (typeof o.lines === "object" && o.lines !== null) {
      for (const [k, since] of Object.entries(o.lines)) if (finiteSince(since)) this.lineSaid.set(k, now - since);
    }
    if (Array.isArray(o.once)) for (const k of o.once) if (typeof k === "string") this.onceSaid.add(k);
  }

  clear(): void {
    this.eventSpoke.clear();
    this.histories.clear();
    this.lineSaid.clear();
    this.onceSaid.clear();
  }
}
