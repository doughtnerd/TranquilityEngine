// How the desktop editor's Projects window hands a project to the editor window (ADR 0059). Both
// windows load at start-up; the editor window stays hidden while it loads. The Projects window
// asks whether the editor is ready, sends the project the user picked, and hides once the editor
// says it opened (the editor window shows itself first). When the editor closes its project it
// hides and asks the Projects window to show again. Messages are Tauri events (a `Bus` here, so
// tests can pass their own).

/** A project for the editor window to open. */
export type OpenRequest = { kind: "folder"; root: string } | { kind: "sample"; id: string };

export interface Bus {
  emit(event: string, payload?: unknown): Promise<void>;
  /** Resolves to a function that stops listening. */
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
}

export const EVENTS = {
  /** Projects window → editor: are you ready? */
  ping: "myco://editor-ping",
  /** Editor → Projects window: loaded and listening (on start-up, and in answer to a ping). */
  ready: "myco://editor-ready",
  /** Projects window → editor: `{ id, request }`. */
  open: "myco://open-project",
  /** Editor → Projects window: `{ id, error? }`. */
  opened: "myco://open-project-result",
  /** Editor → Projects window: the project was closed; show the projects again. */
  showProjects: "myco://show-projects",
} as const;

interface OpenMessage {
  id: number;
  request: OpenRequest;
}
interface OpenedMessage {
  id: number;
  error?: string;
}

/** The Projects window's side: `open` resolves once the editor window shows the project, and throws its error if it couldn't open it. */
export interface EditorLink {
  /** Resolves once the editor window has loaded. */
  readonly ready: Promise<void>;
  open(request: OpenRequest): Promise<void>;
  dispose(): void;
}

export function linkToEditor(bus: Bus, onShowProjects: () => void): EditorLink {
  let nextId = 1;
  const waiting = new Map<number, { resolve(): void; reject(err: Error): void }>();
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  const stops = [
    bus.listen(EVENTS.ready, () => markReady()),
    bus.listen<OpenedMessage>(EVENTS.opened, ({ id, error }) => {
      const w = waiting.get(id);
      if (!w) return;
      waiting.delete(id);
      if (error === undefined) w.resolve();
      else w.reject(new Error(error));
    }),
    bus.listen(EVENTS.showProjects, () => onShowProjects()),
  ];
  // Ask once listening, in case the editor loaded first and its ready message was missed.
  void Promise.all(stops).then(() => bus.emit(EVENTS.ping));
  return {
    ready,
    async open(request) {
      await ready;
      const id = nextId++;
      const done = new Promise<void>((resolve, reject) => waiting.set(id, { resolve, reject }));
      await bus.emit(EVENTS.open, { id, request } satisfies OpenMessage);
      return done;
    },
    dispose() {
      for (const stop of stops) void stop.then((f) => f());
    },
  };
}

/**
 * The editor window's side. `open` opens the project and shows the editor window, throwing if it
 * couldn't; the result goes back to the Projects window. Returns a function that stops serving.
 */
export function serveProjectsWindow(bus: Bus, open: (request: OpenRequest) => Promise<void>): () => void {
  const stops = [
    bus.listen(EVENTS.ping, () => void bus.emit(EVENTS.ready)),
    bus.listen<OpenMessage>(EVENTS.open, async ({ id, request }) => {
      let error: string | undefined;
      try {
        await open(request);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      await bus.emit(EVENTS.opened, { id, ...(error === undefined ? {} : { error }) } satisfies OpenedMessage);
    }),
  ];
  void Promise.all(stops).then(() => bus.emit(EVENTS.ready));
  return () => {
    for (const stop of stops) void stop.then((f) => f());
  };
}

/** Ask the Projects window to show (the editor closed its project). */
export function showProjectsWindow(bus: Bus): Promise<void> {
  return bus.emit(EVENTS.showProjects);
}

/** Tauri's events, both windows of the app hearing each other. */
export async function tauriBus(): Promise<Bus> {
  const { emit, listen } = await import("@tauri-apps/api/event");
  return {
    emit: (event, payload) => emit(event, payload),
    listen: (event, handler) => listen(event, (e) => handler(e.payload as never)),
  };
}
