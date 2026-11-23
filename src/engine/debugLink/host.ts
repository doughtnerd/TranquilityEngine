// A build's debug link (ADR 0376): started by the player when `game.json` has `debug` (an export with debugging on), it
// loads the registered topics, connects out to the tool over the engine's transports (WebSocket, with WebRTC's data
// channel for samples when `debug.webrtc` asks, 0333; never the game session) and runs a session on the Engine's frame:
// commands at the frame start, samples at the frame end. When the tool isn't listening yet, or goes away, it tries again
// every few seconds of frames, so a build started before the editor still connects.
//
// The player imports this module only by `import()`, so a release export, which leaves the link's chunks out, holds
// none of it.
import type { Engine } from "../core/Engine";
import { createTransport, type Transport } from "../net/Transport";
import "../net/transport/websocket";
import { readDebugManifest } from "./config";
import { DebugLinkSession, type BuildSessionState } from "./session";
import { debugTopics, type DebugTopic } from "./topics";

/** Seconds of frames between connection attempts while the tool can't be reached. */
export const RECONNECT_SECONDS = 2;

export interface DebugLinkOptions {
  /** `game.json`'s `debug` section. */
  readonly debug: unknown;
  /** A launch override of its address (`--debug-link`, `?debug-link=`), or null. */
  readonly override?: string | null;
  /** The game's name, shown in the tool. */
  readonly name: string;
  /** `web` or `desktop`. */
  readonly platform?: string;
  /** The transport to connect over (default `websocket`; tests use `loopback`). */
  readonly transport?: string;
  /** Extra transport options (the loopback's clock in tests). */
  readonly transportOptions?: Readonly<Record<string, unknown>>;
  /** Where the link's messages go (default `console.warn`). */
  readonly log?: (line: string) => void;
}

/** A running link. */
export interface DebugLinkHandle {
  /** The link's address. */
  readonly address: string;
  /** The current session's state ("closed" between attempts). */
  readonly state: BuildSessionState;
  /** Stops the link for good. */
  close(): void;
}

/**
 * Starts `engine`'s debug link as `options.debug` says; null when it says there is none. Topics that fail to load are
 * logged and left out.
 */
export async function startDebugLink(engine: Engine, options: DebugLinkOptions): Promise<DebugLinkHandle | null> {
  const log = options.log ?? ((line: string) => console.warn(line));
  const { config, problems } = readDebugManifest(options.debug, options.override);
  for (const p of problems) log(`[myco] debug link: ${p}`);
  if (!config) return null;

  const topics = new Map<string, DebugTopic>();
  for (const [name, load] of debugTopics()) {
    try {
      topics.set(name, (await load())({ engine }));
    } catch (err) {
      log(`[myco] debug link: the "${name}" topic didn't load (${(err as Error)?.message ?? err}).`);
    }
  }
  const transportOptions: Record<string, unknown> = { ...options.transportOptions };
  if (config.webrtc !== undefined) transportOptions.webrtc = config.webrtc;
  const transport: Transport = createTransport(options.transport ?? "websocket", transportOptions);
  const hello = { name: options.name, platform: options.platform ?? "web", topics: [...topics.keys()] };

  let session: DebugLinkSession | null = null;
  let wait = 0;
  let stopped = false;
  const connect = () => {
    try {
      session = new DebugLinkSession({ transport, connection: transport.connect(config.link), hello, topics, log });
    } catch (err) {
      session = null;
      log(`[myco] debug link: couldn't connect to ${config.link} (${(err as Error)?.message ?? err}).`);
    }
  };
  connect();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    removeHook();
    session?.close();
    transport.close();
    for (const t of topics.values()) t.dispose?.();
  };
  const removeHook = engine._addFrameHook({
    begin: () => session?.frameStart(),
    end: (dt) => {
      if (session && session.state !== "closed") {
        session.frameEnd(dt);
        return;
      }
      wait += Math.max(0, dt);
      if (wait < RECONNECT_SECONDS) return;
      wait = 0;
      connect();
    },
    dispose: stop,
  });

  return {
    address: config.link,
    get state() {
      return (session as DebugLinkSession | null)?.state ?? "closed";
    },
    close: stop,
  };
}
