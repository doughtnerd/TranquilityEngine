// A build's debug link (ADR 0376): started by the player when `game.json` has `debug` (an export with debugging on), it
// loads the registered topics, connects out to the tool over the engine's transports (WebSocket, with WebRTC's data
// channel for samples when `debug.webrtc` asks, 0333; never the game session) and runs a session on the Engine's frame:
// commands at the frame start, samples at the frame end. When the tool isn't listening yet, or goes away, it tries again
// every few seconds of frames, so a build started before the editor still connects.
//
// ADR 0380 adds the other direction: a native build with `debug.listen` listens (`startBuildListener`, a
// `BuildListener`) and tools connect to it, pairing with the code the build shows. Both directions run the same session.
//
// The player imports this module only by `import()`, so a release export, which leaves the link's chunks out, holds
// none of it.
import type { Engine } from "../core/Engine";
import { createTransport, type Transport } from "../net/Transport";
import "../net/transport/websocket";
import { readDebugManifest } from "./config";
import type { NetworkInterfaceAddress } from "./pairing/address";
import type { IssuedToken } from "./pairing/gate";
import type { DebugPair, EndpointKind } from "./protocol";
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
  /**
   * The tool's pairing code, typed into the build's launch (`--debug-code <code>`, `?debug-code=`; plan decision O6),
   * or null. Version 2 (ADR 0380): on every connection the build sends `pair` (role `build`, its `kind`, this code's
   * token) and then `hello`; without a code the `pair` carries no token and a tool on another machine asks a person
   * (0376's accept prompt). L7 sends it; until then the build says hello first, which a version 2 tool reads as a
   * tokenless `pair`.
   */
  readonly code?: string | null;
  /** The build's endpoint kind, sent in `pair` (default `native` under Tauri, else `page-http` or `page-https` by the page's scheme). */
  readonly kind?: EndpointKind;
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

// --- the build listens (ADR 0380 "Roles"; plan contract C3, filled by L7) -------------------------------------------------

/** A tool that connects to a listening build, as the build's prompt sees it. */
export interface ToolAtTheDoor extends DebugPair {
  /** Its address, as the transport names it. */
  readonly remote: string;
  /** Whether it connects from this machine. */
  readonly sameMachine: boolean;
}

/** A tool connected to a listening build (paired, its session running). */
export interface ConnectedTool {
  /** Its `pair` name, or "A tool". */
  readonly name: string;
  readonly kind: EndpointKind;
  readonly remote: string;
}

export interface BuildListenerOptions {
  /** `game.json`'s `debug` section; the listener starts only when it says `listen: true` (C6), on the LAN only with `lan: true`. */
  readonly debug: unknown;
  /** The game's name, shown in the tool (the build's `hello`). */
  readonly name: string;
  /** `web`, `desktop` or `android` (the `hello`'s platform). */
  readonly platform?: string;
  /**
   * The listening transport's name (default `websocket`; it must be one that can listen here: the Tauri listener
   * transport the player registers under Tauri, U2/L8; the Node server's in tests; `loopback` in unit tests).
   */
  readonly transport?: string;
  /** Extra transport options. */
  readonly transportOptions?: Readonly<Record<string, unknown>>;
  /**
   * The build's own network addresses, for the code's two octets (`pairing/code.ts`): the first private IPv4 address
   * among them goes in the address code. Absent or none private: no LAN code (same-machine tools need none).
   */
  readonly interfaces?: () => readonly NetworkInterfaceAddress[];
  /**
   * Asks a person whether to let in a tokenless tool from another machine (0376's prompt; the editor's Play, U3).
   * Absent: such a tool is refused with `no-token` (a game has nobody to ask).
   */
  readonly prompt?: (tool: ToolAtTheDoor) => Promise<boolean>;
  /** The token gate's clock, ms (default `performance.now`). */
  readonly now?: () => number;
  /** The token gate's random source (default `crypto.getRandomValues`). */
  readonly randomToken?: (bits: number) => number;
  /** Where the listener's messages go (default `console.warn`). */
  readonly log?: (line: string) => void;
}

/**
 * A listening build (ADR 0380: "whichever side can listen does"): it listens on the first free port of
 * `debug.port`..`debug.port + 9` (7790..7799), on `0.0.0.0` with `debug.lan` and loopback otherwise, and accepts tools.
 * Each connecting tool's first message is `pair` (role `tool`): the token goes through a `TokenGate`
 * (`pairing/gate.ts`), a same-machine tool needs none, a tokenless one from another machine goes to `prompt` (or is
 * refused with `no-token`); the build answers `paired`, then says `hello` and serves its topics to the tool once
 * welcomed, on the Engine's frame, as `startDebugLink`'s session does. Several tools may be connected at once.
 */
export interface BuildListener {
  /** The address it listens at (`ws://0.0.0.0:7791/myco-debug`). */
  readonly address: string;
  /** The port it got. */
  readonly port: number;
  /** Whether it accepts connections from other machines (`debug.lan`). */
  readonly lan: boolean;
  /**
   * The address code to show (`3F9QK-7KD2X`; the overlay shows it while no tool is connected, F8 shows it again), or
   * null when there is none (not on the LAN, or no private address known). It changes after each pairing and each
   * expiry: read it each frame.
   */
  readonly code: string | null;
  /** The token behind `code` (its serial tells a new code from the same one), or null with no code. */
  readonly token: IssuedToken | null;
  /** When the gate's lock on LAN connections ends (the gate's clock, ms), or null when not locked. */
  readonly lockedUntil: number | null;
  /** The tools connected now. */
  readonly tools: readonly ConnectedTool[];
  /** Stops listening and closes every tool's session. */
  close(): void;
}

/**
 * Starts `engine`'s listening debug link as `options.debug` says; null when it doesn't ask to listen (`listen` absent
 * or false) or nothing could listen (every port of the range taken: logged). Topics load as in `startDebugLink`. The
 * listener closes with the Engine.
 */
export async function startBuildListener(engine: Engine, options: BuildListenerOptions): Promise<BuildListener | null> {
  void engine;
  void options;
  throw new Error("L7: not implemented");
}
