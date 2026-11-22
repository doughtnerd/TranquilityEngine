// How the desktop editor hands a project (and an asset) to the Audio Studio's window (ADR 0327), with the same
// ready / ack pattern as the Projects window's handoff (launcher/handoff.ts, ADR 0059). The editor asks Rust to
// create or focus the `studio` window, then asks the Studio whether it is ready, sends `myco://studio-open
// {id, request}` and waits for the Studio's answer. App-agnostic: the editor uses `linkToStudio`, the Studio page
// `serveStudioOpen`. Messages are Tauri events (a `Bus`, so tests pass their own).
import type { Bus } from "./launcher/handoff";
import type { StudioOpenRequest } from "./studioAssets";

export type { Bus };

export const STUDIO_EVENTS = {
  /** Editor → Studio: are you ready? */
  ping: "myco://studio-ping",
  /** Studio → editor: loaded and listening (on start-up, and in answer to a ping). */
  ready: "myco://studio-ready",
  /** Editor → Studio: `{ id, request }`. */
  open: "myco://studio-open",
  /** Studio → editor: `{ id, error? }`. */
  opened: "myco://studio-open-result",
} as const;

interface OpenMessage {
  id: number;
  request: StudioOpenRequest;
}
interface OpenedMessage {
  id: number;
  error?: string;
}

/** The Studio answered that it couldn't open the request; the message is its own wording of why. */
export class StudioRefusal extends Error {
  override name = "StudioRefusal";
}

/** The Studio didn't answer in time (it isn't running, or is still loading something that failed). */
export class StudioTimeout extends Error {
  override name = "StudioTimeout";
}

export interface StudioLink {
  /** Resolves once the Studio window has said it is listening. */
  readonly ready: Promise<void>;
  /** Hand the Studio `request`; resolves once it opened it, throws `StudioRefusal` with its reason, or `StudioTimeout`. */
  open(request: StudioOpenRequest): Promise<void>;
  dispose(): void;
}

/** How long the editor waits for the Studio to be ready, and then for it to open what it was sent. */
export const STUDIO_TIMEOUT_MS = 20_000;

/**
 * The editor's side. Make one per hand-off, before asking Rust for the window, so a window created for it is heard
 * saying it is ready, and an open one answers the ping (a link outlives no window). `timeoutMs` bounds each wait.
 */
export function linkToStudio(bus: Bus, timeoutMs = STUDIO_TIMEOUT_MS): StudioLink {
  let nextId = 1;
  const waiting = new Map<number, { resolve(): void; reject(err: Error): void }>();
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  const stops = [
    bus.listen(STUDIO_EVENTS.ready, () => markReady()),
    bus.listen<OpenedMessage>(STUDIO_EVENTS.opened, ({ id, error }) => {
      const w = waiting.get(id);
      if (!w) return;
      waiting.delete(id);
      if (error === undefined) w.resolve();
      else w.reject(new StudioRefusal(error));
    }),
  ];
  // Ask once listening, in case the Studio loaded first and its ready message was missed.
  void Promise.all(stops).then(() => bus.emit(STUDIO_EVENTS.ping));
  const within = <T>(promise: Promise<T>, what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new StudioTimeout(`The Audio Studio didn't ${what}.`)), timeoutMs);
      promise.then(
        (v) => (clearTimeout(timer), resolve(v)),
        (e: unknown) => (clearTimeout(timer), reject(e as Error)),
      );
    });
  return {
    ready,
    async open(request) {
      await within(ready, "start");
      const id = nextId++;
      const done = new Promise<void>((resolve, reject) => waiting.set(id, { resolve, reject }));
      await bus.emit(STUDIO_EVENTS.open, { id, request } satisfies OpenMessage);
      try {
        await within(done, "open the project");
      } finally {
        waiting.delete(id);
      }
    },
    dispose() {
      for (const stop of stops) void stop.then((f) => f());
    },
  };
}

/**
 * The Studio window's side: answers pings, and opens each request with `open` (throwing if it couldn't, in its own
 * words), sending the result back. Returns a function that stops serving.
 */
export function serveStudioOpen(bus: Bus, open: (request: StudioOpenRequest) => Promise<void>): () => void {
  const stops = [
    bus.listen(STUDIO_EVENTS.ping, () => void bus.emit(STUDIO_EVENTS.ready)),
    bus.listen<OpenMessage>(STUDIO_EVENTS.open, async ({ id, request }) => {
      let error: string | undefined;
      try {
        await open(request);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      await bus.emit(STUDIO_EVENTS.opened, { id, ...(error === undefined ? {} : { error }) } satisfies OpenedMessage);
    }),
  ];
  void Promise.all(stops).then(() => bus.emit(STUDIO_EVENTS.ready));
  return () => {
    for (const stop of stops) void stop.then((f) => f());
  };
}
