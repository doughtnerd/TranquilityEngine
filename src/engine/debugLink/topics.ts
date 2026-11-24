// The debug link's topic registry (ADR 0376): plugins register their topics here through the runtime context
// (`ctx.debugLink.topic("animation", load)`), as loaders. This file is the one part of `src/engine/debugLink/` every
// build holds: a map of names to `import()` functions, with type-only imports, so a release export (which ships none of
// the link's code, ADR 0376 "Security") still lets plugins register without loading anything. The link loads a topic's
// code when it starts, and only in a build with debugging on.
import type { Engine } from "../core/Engine";
import type { RecordWriter } from "./records";

/** What a topic gets from the link. */
export interface DebugTopicHost {
  /** The Engine the build runs. */
  readonly engine: Engine;
}

/** One pulled subscription: the build sends its samples while it lasts, and nothing without one. */
export interface DebugSubscription {
  /**
   * Writes the records due since the last call into `out` (nothing: no sample this time). Called after a frame, at most
   * at the topic's `rate`; `frame` is the build's frame number, for the records' heads. A reliable topic's subscription
   * is sampled again, up to `RELIABLE_SAMPLES_PER_FRAME` times a due frame, while each call writes records; each call
   * is one message.
   */
  sample(out: RecordWriter, frame: number): void;
  /** The subscription ended (unsubscribed, or the tool went away). */
  close(): void;
}

/** A topic as a build serves it. */
export interface DebugTopic {
  /** Samples per second each subscription sends at most (default 30). */
  readonly rate?: number;
  /**
   * The channel its samples travel on (ADR 0403 plan, C3). `unreliable` (the default): a lost or late sample is dropped,
   * which suits a picture of now (the animation topic's frames). `reliable`: every sample arrives, in order, which a
   * stream that can't have holes needs (the audio topic's `capture` segments, its take upload). Requests, replies,
   * commands and errors always travel reliably, whatever this says.
   */
  readonly channel?: "reliable" | "unreliable";
  /** Starts a subscription for `params` (what the tool shows), or refuses it with a reason. */
  subscribe(params: unknown): DebugSubscription | { readonly refused: string };
  /** Answers a request (a promise may resolve later). Throwing sends the tool an error with the message. */
  request?(method: string, params: unknown): unknown;
  /**
   * Applies a command from the tool. Called at the build's next frame start (ADR 0376: "applied at the build's next frame
   * start, like any input"), never when it arrives. Throwing sends the tool an error with the message.
   */
  command?(name: string, params: unknown): void;
  /** The link closed. */
  dispose?(): void;
}

/** Builds a topic for a link. */
export type DebugTopicFactory = (host: DebugTopicHost) => DebugTopic;
/** Loads a topic's code (an `import()`, so builds without the link never load it). */
export type DebugTopicLoader = () => Promise<DebugTopicFactory>;

const loaders = new Map<string, DebugTopicLoader>();

/** @internal Registers topic `name` (the runtime context's `debugLink.topic`); returns the undo. A later registration of the name wins. */
export function registerDebugTopic(name: string, load: DebugTopicLoader): () => void {
  loaders.set(name, load);
  return () => {
    if (loaders.get(name) === load) loaders.delete(name);
  };
}

/** @internal The registered topics by name. */
export function debugTopics(): ReadonlyMap<string, DebugTopicLoader> {
  return loaders;
}
