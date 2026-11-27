/**
 * Speaker channels (ADR 0355 §4–§5): `Audio.say` and `Audio.dialogue`. One system per page's audio session.
 *
 * - **Deciding.** An event's `cooldown` (since it last spoke) and `chance` are checked first, then `decide` picks a line
 *   (`decideLine.ts`: best match or weighted, availability, the event's avoid-repeat memory). Every refusal finishes the
 *   handle `refused` with its reason (`unknownEvent`, `cooldown`, `chance`, `silence`, `noMatch`, `unavailable`, `busy`).
 * - **Channels.** A say plays on `options.channel`, else the picked line's speaker, else the event name; a channel speaks
 *   one line at a time, and at most `settings.dialogue.maxVoices` lines speak at once (default 3, 0: no limit).
 * - **Busy** (the channel speaks, or `maxVoices` is reached: compared with the lowest-priority speaking line): interrupt
 *   when the event's `interrupt` allows it (`lower`: the speaking line's priority is lower; `always`; `never`) and
 *   `whenBusy` isn't `drop` — the speaking line fades out over `interruptFadeMs` (default 150), ends `interrupted`, and
 *   its event's `onInterrupted` is said after the fade (same arguments and channel, never chained further); else queue
 *   (`whenBusy: "queue"`: at most 4 per channel, by priority then age, the lowest dropped when full, dropped after
 *   `maxWait`; decided again when it starts, so cooldowns and the language are current); else drop (`busy`).
 * - **Priority** 0..100: `options.priority`, else the event's, else the line's table priority.
 * - **Memory** (`memory.ts`): event cooldowns and histories, line cooldowns and once-lines; `Audio.dialogue.memory()` and
 *   `restore()` save and load it as plain JSON.
 * - **Takes** (§6): each say is recorded as asked (resolved arguments, options, what it did, its pick and the World
 *   generator's state before it decided) and again when a queued one starts or is dropped.
 */
import { World } from "../../../../engine/core/World";
import { Assets } from "../../../../engine/scene/Assets";
import { AUDIO_PROJECT_FILE } from "../../../../engine/audio/project/types";
import { argumentName, type DialogueEvent } from "../../../../engine/audio/dialogue/types";
import type { DecideResult } from "../../../../engine/audio/dialogue/decide";
import type { TakeSayOptions, TakeSayPick } from "../../../../engine/audio/take/types";
import type { AudioReason } from "../backend";
import { warnOnce } from "../core/handle";
import { onAudioSessionReleased } from "../audioSession";
import { worldKeyOf } from "../AudioSource";
import { takePlayOptions, takeTap, type TakeEmitter } from "../capture/takeTap";
import { playlistHost, type HostedRuntime } from "../playlists/host";
import { dialogueEvent, lineLocation } from "../localisation/lineRegistry";
import { LineHandle, startLine, type AudioLineHandle, type LineOptions } from "../localisation/lines";
import { decideEvent, dialogueMemory } from "./decideLine";
import type { DialogueMemory } from "./memory";
import { nearestSpeaker } from "./AudioSpeaker";

/** Options for `Audio.say` (ADR 0355 §5). */
export interface SayOptions extends LineOptions {
  /** A value per argument name (labels); arguments not given read their global parameter, else their default. */
  args?: Record<string, string>;
  /** The speaker channel; default the picked line's speaker, else the event name. */
  channel?: string;
  /** 0..100; default the event's, else the line's table priority. */
  priority?: number;
  /** Overrides the event's `whenBusy`. */
  whenBusy?: "queue" | "interrupt" | "drop";
}

/** `Audio.dialogue` (ADR 0355 §5). */
export interface AudioDialogue {
  /** Whether a line speaks on `channel` now. */
  speaking(channel: string): boolean;
  /** Stops the line speaking on `channel` and clears its queue (every channel when omitted). */
  stop(channel?: string, fadeSeconds?: number): void;
  /** The dialogue memory as plain JSON (cooldown times relative to now, histories, once-lines). */
  memory(): DialogueMemory;
  /** Replaces the dialogue memory with a saved one. */
  restore(memory: DialogueMemory): void;
}

/** `Audio.debug().dialogue`. */
export interface AudioDialogueDebug {
  channels: { channel: string; speaking: string | null; priority: number; queue: { event: string; waited: number }[] }[];
  refusals: Record<DialogueRefusal, number>;
}

export type DialogueRefusal = "busy" | "cooldown" | "chance" | "silence" | "noMatch" | "unavailable";

/** `audio.json` `settings.dialogue` (ADR 0355 §4). */
export interface DialogueSettings {
  /** Lines speaking at once across channels; 0: no limit. */
  maxVoices: number;
  /** The fade of an interrupted line, ms. */
  interruptFadeMs: number;
}

export const DEFAULT_DIALOGUE_SETTINGS: Readonly<DialogueSettings> = Object.freeze({ maxVoices: 3, interruptFadeMs: 150 });
/** Says waiting per channel. */
export const MAX_QUEUE = 4;

let settingsFrom: { raw: unknown; value: DialogueSettings } | null = null;

/** `audio.json`'s `settings.dialogue`, leniently (bad values: the defaults). */
export function dialogueSettings(): DialogueSettings {
  let raw: unknown;
  try { raw = Assets.has(AUDIO_PROJECT_FILE) ? Assets.get(AUDIO_PROJECT_FILE) : undefined; } catch { raw = undefined; }
  if (settingsFrom !== null && settingsFrom.raw === raw) return settingsFrom.value;
  const d = (raw as { settings?: { dialogue?: { maxVoices?: unknown; interruptFadeMs?: unknown } } } | undefined)?.settings?.dialogue;
  const int = (v: unknown, fallback: number, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : fallback);
  const value = { maxVoices: int(d?.maxVoices, DEFAULT_DIALOGUE_SETTINGS.maxVoices, 64), interruptFadeMs: int(d?.interruptFadeMs, DEFAULT_DIALOGUE_SETTINGS.interruptFadeMs, 10_000) };
  settingsFrom = { raw, value };
  return value;
}

/** A say's facts the system keeps: its event, the arguments it was given, its options and whether it was an `onInterrupted`. */
interface SayRecord {
  readonly ev: DialogueEvent;
  readonly options: SayOptions;
  readonly chained: boolean;
}

interface Queued {
  readonly handle: LineHandle;
  readonly say: SayRecord;
  readonly asked: number;
  readonly seq: number;
}

interface Channel {
  readonly name: string;
  speaking: LineHandle | null;
  queue: Queued[];
}

const clampPriority = (p: number): number => Math.min(100, Math.max(0, Math.round(p)));

class DialogueSystem implements HostedRuntime {
  private readonly channels = new Map<string, Channel>();
  private readonly says = new WeakMap<LineHandle, SayRecord>();
  private readonly later: { at: number; run: () => void }[] = [];
  private seq = 0;
  refusals: Record<DialogueRefusal, number> = { busy: 0, cooldown: 0, chance: 0, silence: 0, noMatch: 0, unavailable: 0 };

  private channel(name: string): Channel {
    let c = this.channels.get(name);
    if (!c) this.channels.set(name, (c = { name, speaking: null, queue: [] }));
    return c;
  }

  private now(): number { return playlistHost().clock(); }
  private world(): number { return worldKeyOf(World.active); }
  private rng = (): number => playlistHost().random(this.world());

  /** Lines speaking now across channels. */
  private speakingLines(): LineHandle[] {
    const out: LineHandle[] = [];
    for (const c of this.channels.values()) if (c.speaking?.state === "playing") out.push(c.speaking);
    return out;
  }

  /** What blocks `channel` now: its own speaking line, else (at `maxVoices`) the lowest-priority speaking line; null when free. */
  private blocker(channel: Channel): LineHandle | null {
    if (channel.speaking?.state === "playing") return channel.speaking;
    const max = dialogueSettings().maxVoices;
    const speaking = this.speakingLines();
    if (max === 0 || speaking.length < max) return null;
    return speaking.reduce((low, h) => (h.priority < low.priority ? h : low));
  }

  private refuse(handle: LineHandle, reason: AudioReason): LineHandle {
    if (reason in this.refusals) this.refusals[reason as DialogueRefusal]++;
    return handle.refuse(reason);
  }

  /** The arguments as decided (every argument's value; `*` for one that matched only wildcards), for the take. */
  private resolvedArgs(d: DecideResult): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(d.trace.values)) out[k] = v ?? "*";
    return out;
  }

  private record(handle: LineHandle, say: SayRecord, args: Record<string, string>, state: "playing" | "queued" | "refused", picked: TakeSayPick | null, random: number | null): void {
    const sink = takeTap.sink;
    if (!sink) return;
    const o = say.options;
    const options: TakeSayOptions = takePlayOptions(o);
    if (typeof o.channel === "string") options.channel = o.channel;
    if (o.whenBusy === "queue" || o.whenBusy === "interrupt" || o.whenBusy === "drop") options.whenBusy = o.whenBusy;
    const node = o.node && o.node.isValid ? o.node : null;
    const emitter: TakeEmitter | null = node ? { key: node, name: node.name, position: () => node.transform?.worldPosition ?? null }
      : o.position ? { key: handle, name: say.ev.name, position: () => handle.position } : null;
    sink.say(handle, { event: say.ev.name, args, options, state, picked, random, emitter });
  }

  /** `Audio.say(event, options)`. Never throws. */
  say(name: string, options: SayOptions = {}, chained = false): AudioLineHandle {
    const handle = new LineHandle("", String(name));
    const found = dialogueEvent(String(name));
    if (!found) {
      warnOnce(`say:unknown:${String(name)}`, `Audio.say: no dialogue event "${String(name)}"; nothing is said (reason "unknownEvent").`);
      return handle.refuse("unknownEvent");
    }
    const ev = found.event;
    const say: SayRecord = { ev, options, chained };
    this.says.set(handle, say);
    const now = this.now();
    const random = playlistHost().randomState(this.world());
    const given = options.args ?? {};
    // Cooldown and chance first: a say refused by them draws nothing from the generator but the chance roll.
    const since = dialogueMemory.sinceEvent(ev.name, now);
    if (ev.cooldown > 0 && since !== null && since < ev.cooldown) {
      this.record(handle, say, { ...given }, "refused", { none: "cooldown" }, random);
      return this.refuse(handle, "cooldown");
    }
    if (ev.chance < 1 && !(this.rng() < ev.chance)) {
      this.record(handle, say, { ...given }, "refused", { none: "chance" }, random);
      return this.refuse(handle, "chance");
    }
    const d = decideEvent(ev, options.args, this.rng);
    const args = this.resolvedArgs(d);
    if ("none" in d) {
      this.record(handle, say, args, "refused", { none: d.none }, random);
      return this.refuse(handle, d.none);
    }
    const loc = lineLocation(d.key)!;
    handle.path = d.path;
    handle.key = d.key;
    handle.speaker = loc.line.speaker;
    handle.priority = clampPriority(typeof options.priority === "number" && Number.isFinite(options.priority) ? options.priority : ev.priority ?? loc.table.priority);
    const channel = this.channel(typeof options.channel === "string" && options.channel !== "" ? options.channel : loc.line.speaker ?? ev.name);
    handle.channel = channel.name;
    const whenBusy = options.whenBusy ?? ev.whenBusy;
    const blocker = this.blocker(channel);
    const picked: TakeSayPick = { key: d.key, pathIndex: d.pathIndex };
    if (!blocker) {
      this.record(handle, say, args, "playing", picked, random);
      return this.speak(handle, say, channel, d.key);
    }
    if (whenBusy !== "drop" && this.mayInterrupt(ev, blocker, handle.priority)) {
      this.interrupt(blocker);
      this.record(handle, say, args, "playing", picked, random);
      return this.speak(handle, say, channel, d.key);
    }
    if (whenBusy === "queue") {
      this.record(handle, say, args, "queued", null, random);
      return this.enqueue(channel, { handle, say, asked: now, seq: ++this.seq });
    }
    this.record(handle, say, args, "refused", { none: "busy" }, random);
    return this.refuse(handle, "busy");
  }

  private mayInterrupt(ev: DialogueEvent, speaking: LineHandle, priority: number): boolean {
    return ev.interrupt === "always" || (ev.interrupt === "lower" && speaking.priority < priority);
  }

  /** Cuts `h` off: it fades out and ends `interrupted`; its event's `onInterrupted` is said after the fade (never chained further). */
  private interrupt(h: LineHandle): void {
    const fade = dialogueSettings().interruptFadeMs / 1000;
    const said = this.says.get(h);
    h.interrupt(fade);
    const next = said?.ev.onInterrupted;
    if (!said || said.chained || !next) return;
    const args: Record<string, string> = {};
    // Same arguments: the ones it was given (the event's own arguments decide again from them).
    for (const [k, v] of Object.entries(said.options.args ?? {})) args[k] = v;
    const opts: SayOptions = { ...said.options, args, ...(h.channel !== null ? { channel: h.channel } : {}) };
    this.later.push({ at: this.now() + fade, run: () => { this.say(next, opts, true); } });
    playlistHost().host(this);
  }

  /** Starts the line now on `channel`: the memory notes it, an `AudioSpeaker` places it when the say doesn't. */
  private speak(handle: LineHandle, say: SayRecord, channel: Channel, key: string): LineHandle {
    const loc = lineLocation(key)!;
    const o = say.options;
    const node = !o.position && !o.node && loc.line.speaker !== null ? nearestSpeaker(loc.line.speaker) : null;
    dialogueMemory.spoke(say.ev.name, key, this.now(), loc.line.once);
    startLine(handle, loc, node ? { ...o, node } : o, `Audio.say("${say.ev.name}")`);
    if (handle.state !== "playing") return handle;
    channel.speaking = handle;
    handle.onEnd = () => {
      if (channel.speaking === handle) channel.speaking = null;
      this.pumpAll();
    };
    playlistHost().host(this);
    return handle;
  }

  private enqueue(channel: Channel, q: Queued): LineHandle {
    channel.queue.push(q);
    channel.queue.sort((a, b) => b.handle.priority - a.handle.priority || a.seq - b.seq);
    if (channel.queue.length > MAX_QUEUE) {
      const dropped = channel.queue.pop()!;
      this.drop(dropped);
    }
    q.handle.onEnd = (h, how) => {
      // Stopped by the game while it waited: it leaves the queue.
      if (how === "stopped") channel.queue = channel.queue.filter((x) => x.handle !== h);
    };
    playlistHost().host(this);
    return q.handle;
  }

  private drop(q: Queued, reason: AudioReason = "busy", picked: TakeSayPick | null = { none: "busy" }, random: number | null = null): void {
    takeTap.sink?.sayState(q.handle, "dropped", picked, random);
    q.handle.onEnd = null;
    this.refuse(q.handle, reason);
  }

  /** Starts what waits on `channel` while it (and `maxVoices`) allows: each queued say decides as it starts. */
  private pump(channel: Channel): void {
    while (channel.queue.length > 0 && !this.blocker(channel)) {
      const q = channel.queue.shift()!;
      const now = this.now();
      if (now - q.asked > q.say.ev.maxWait) { this.drop(q); continue; }
      const ev = q.say.ev;
      const random = playlistHost().randomState(this.world());
      const since = dialogueMemory.sinceEvent(ev.name, now);
      if (ev.cooldown > 0 && since !== null && since < ev.cooldown) { this.drop(q, "cooldown", { none: "cooldown" }, random); continue; }
      const d = decideEvent(ev, q.say.options.args, this.rng);
      if ("none" in d) { this.drop(q, d.none, { none: d.none }, random); continue; }
      const loc = lineLocation(d.key)!;
      q.handle.path = d.path;
      q.handle.key = d.key;
      q.handle.speaker = loc.line.speaker;
      q.handle.onEnd = null;
      takeTap.sink?.sayState(q.handle, "playing", { key: d.key, pathIndex: d.pathIndex }, random);
      this.speak(q.handle, q.say, channel, d.key);
    }
  }

  private pumpAll(): void {
    for (const c of this.channels.values()) this.pump(c);
  }

  // --- HostedRuntime ---------------------------------------------------------------------------------------------------

  update(): void {
    const now = this.now();
    if (this.later.length > 0) {
      const due = this.later.filter((l) => l.at <= now + 1e-9);
      this.later.splice(0, this.later.length, ...this.later.filter((l) => l.at > now + 1e-9));
      for (const l of due) l.run();
    }
    for (const c of this.channels.values()) {
      for (const q of [...c.queue]) {
        if (now - q.asked > q.say.ev.maxWait) {
          c.queue.splice(c.queue.indexOf(q), 1);
          this.drop(q);
        }
      }
    }
    this.pumpAll();
  }
  onGlobal(): void {}
  resend(): void {}
  stopAll(): void { this.stop(undefined, 0); }
  release(): void { this.reset(); }
  forgetWorld(): void {}
  sweep(): void {}

  reset(): void {
    this.channels.clear();
    this.later.length = 0;
    this.refusals = { busy: 0, cooldown: 0, chance: 0, silence: 0, noMatch: 0, unavailable: 0 };
    settingsFrom = null;
  }

  // --- Audio.dialogue ------------------------------------------------------------------------------------------------

  speaking(channel: string): boolean {
    return this.channels.get(String(channel))?.speaking?.state === "playing";
  }

  stop(channel?: string, fadeSeconds?: number): void {
    const list = channel === undefined ? [...this.channels.values()] : [this.channels.get(String(channel))].filter((c): c is Channel => !!c);
    for (const c of list) {
      const queue = c.queue;
      c.queue = [];
      for (const q of queue) { q.handle.onEnd = null; q.handle.stop(); }
      const s = c.speaking;
      c.speaking = null;
      if (s) { s.onEnd = null; s.stop(fadeSeconds); }
    }
  }

  debug(): AudioDialogueDebug {
    const now = this.now();
    const channels: AudioDialogueDebug["channels"] = [];
    for (const c of this.channels.values()) {
      const s = c.speaking?.state === "playing" ? c.speaking : null;
      if (!s && c.queue.length === 0) continue;
      channels.push({ channel: c.name, speaking: s?.key ?? null, priority: s?.priority ?? 0, queue: c.queue.map((q) => ({ event: q.say.ev.name, waited: Math.max(0, now - q.asked) })) });
    }
    return { channels, refusals: { ...this.refusals } };
  }
}

let system: DialogueSystem | null = null;

/** The page's dialogue system. */
export function dialogueSystem(): DialogueSystem {
  return (system ??= new DialogueSystem());
}

onAudioSessionReleased(() => system?.reset());

/** `Audio.dialogue`. */
export const audioDialogue: AudioDialogue = {
  speaking: (channel) => dialogueSystem().speaking(channel),
  stop: (channel, fadeSeconds) => dialogueSystem().stop(channel, fadeSeconds),
  memory: () => dialogueMemory.save(playlistHost().clock()),
  restore: (memory) => dialogueMemory.restore(memory, playlistHost().clock()),
};

/** Whether `event` has an argument named `name` (for `AudioSpeaker.say`). */
export function eventHasArgument(event: string, name: string): boolean {
  return dialogueEvent(event)?.event.arguments.some((a) => argumentName(a) === name) ?? false;
}
