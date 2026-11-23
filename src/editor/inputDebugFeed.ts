// What the Input debugger panel and its game-view overlay (ADR 0336, 0337) share: one sampling of a play World's input
// (`inputState` ten times a second, its event log recorded every frame by `watchInput`) however many of them show it,
// the World the panel follows (the overlay follows the same one), whether the overlay shows, and a hardware recording
// in progress (it outlives the panel being closed).
import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import type { World } from "../engine/core/World";
import { inputState, recordInput, watchInput, type InputLog, type InputLogEntry, type InputRecorder, type InputWorldState } from "../engine/editor";
import { persisted } from "./preferences";

/** How often a World is sampled (its log records every frame regardless). */
export const INPUT_REFRESH_MS = 100;

/** The World the Input debugger panel follows (its World picker); null: the first that takes local input. */
export const followedInputWorld = signal<string | null>(null);

/** Whether the input overlay shows over the game view during play, remembered per user. */
export const inputOverlayShown = persisted("myco.editor.inputOverlay", false);

/** The hardware recording in progress (the Input debugger's Record), or null. */
export const inputRecording = signal<InputRecorder | null>(null);

/** Start a hardware recording, unless one is running. */
export function startHardwareRecording(): void {
  if (!inputRecording.peek()) inputRecording.value = recordInput();
}

export interface InputSample {
  readonly state: InputWorldState | null;
  readonly log: readonly InputLogEntry[];
}

interface Feed {
  readonly listeners: Set<(s: InputSample) => void>;
  readonly log: InputLog;
  timer: ReturnType<typeof setInterval> | null;
  /** The log's version last copied. */
  seen: number;
  sample: InputSample;
}

const feeds = new Map<World, Feed>();

/** Sample the World and tell every listener; the log is copied only when it changed. */
function tick(world: World, feed: Feed): void {
  try {
    const state = inputState(world);
    let log = feed.sample.log;
    if (feed.log.version !== feed.seen) {
      feed.seen = feed.log.version;
      log = [...feed.log.entries()];
    }
    feed.sample = { state, log };
  } catch (err) {
    console.error("[myco] The Input debugger couldn't read the World:", err); // a World torn down meanwhile
    return;
  }
  for (const l of [...feed.listeners]) l(feed.sample);
}

/** Sample `world`'s input for `listener` (now, then every `INPUT_REFRESH_MS`), sharing one sampling with every other listener of it. Returns the unsubscribe. */
export function sampleInput(world: World, listener: (s: InputSample) => void): () => void {
  let feed = feeds.get(world);
  if (!feed) {
    const f: Feed = { listeners: new Set(), log: watchInput(world), timer: null, seen: -1, sample: { state: null, log: [] } };
    f.timer = setInterval(() => tick(world, f), INPUT_REFRESH_MS);
    feeds.set(world, (feed = f));
  }
  const current = feed;
  current.listeners.add(listener);
  tick(world, current);
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size > 0 || feeds.get(world) !== current) return;
    feeds.delete(world);
    if (current.timer) clearInterval(current.timer);
    current.log.stop();
  };
}

/** Forget `world`'s logged events (the panel's Clear; the overlay's recent presses go too). */
export function clearInputLog(world: World): void {
  const feed = feeds.get(world);
  if (!feed) return;
  feed.log.clear();
  feed.seen = feed.log.version;
  feed.sample = { ...feed.sample, log: [] };
  for (const l of [...feed.listeners]) l(feed.sample);
}

/** `world`'s input, sampled while the component shows (`sampleInput`). */
export function useInputSample(world: World | null): InputSample {
  const [sample, setSample] = useState<InputSample>({ state: null, log: [] });
  useEffect(() => {
    if (!world) return;
    const stop = sampleInput(world, setSample);
    return () => {
      stop();
      setSample({ state: null, log: [] });
    };
  }, [world]);
  return sample;
}
