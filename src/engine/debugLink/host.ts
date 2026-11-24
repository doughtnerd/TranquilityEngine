// A build's debug link (ADR 0376): started by the player when `game.json` has `debug` (an export with debugging on), it
// loads the registered topics, connects out to the tool over the engine's transports (WebSocket, with WebRTC's data
// channel for samples when `debug.webrtc` asks, 0333; never the game session) and runs a session on the Engine's frame:
// commands at the frame start, samples at the frame end. When the tool isn't listening yet, or goes away, it tries again
// every few seconds of frames, so a build started before the editor still connects.
//
// ADR 0403 adds the other direction: a native build with `debug.listen` listens (`startBuildListener`, a
// `BuildListener`) and tools connect to it, pairing with the code the build shows. Both directions run the same session.
// ADR 0404 adds rooms (`rooms.ts`, loaded by `import()`): a page with `debug.listen`, which can't listen, offers a
// rendezvous room and shows its room code; a build given a tool's room code (`?debug-code=`) joins the tool's room. Both
// connect over the `webrtc` transport; which path a build takes is `choosePath`'s (0403's pair table).
//
// **Connecting out (version 2).** Every connection's first messages are `pair` (role build, the build's kind, the token
// of the tool's code given at launch, its name) and `hello`, sent together (`DebugLinkSession`'s `pair`). A token is
// single use: once the tool accepts it, later reconnects go without one (same machine: no code needed; another
// machine: the tool's prompt). A `paired` refusal (a wrong, expired or used code, a locked tool, a tool connecting to a
// tool) ends the link: trying again with the same code can only fail, and five tries would lock the tool, so the build
// logs the tool's sentence and stops; it is relaunched with the new code. Everything else about reconnecting is as
// before.
//
// The player imports this module only by `import()`, so a release export, which leaves the link's chunks out, holds
// none of it.
import type { Engine } from "../core/Engine";
import { createTransport, type Transport, type TransportConnection, type TransportEvent } from "../net/Transport";
import "../net/transport/websocket";
import { DEBUG_LINK_PATH, DEFAULT_DEBUG_LINK_PORT, readDebugManifest, type DebugManifest } from "./config";
import { isPrivateIpv4, type AddressContext, type NetworkInterfaceAddress } from "./pairing/address";
import { PAIR_BASE_PORT, PAIR_PORT_OFFSETS, PAIR_TOKEN_BITS, decodePairCode, encodePairCode, type PairOctets, type RoomPairCode } from "./pairing/code";
import { TokenGate, type IssuedToken } from "./pairing/gate";
import { choosePath } from "./pairing/path";
import type { PageLocation, RoomJoinTransport, RoomWebRtcOptions } from "./rooms";
import {
  EnvelopeKind,
  decodeEnvelope,
  encodeEnvelope,
  jsonPayload,
  pairedEnvelope,
  pairRefusalMessage,
  readJsonPayload,
  readPair,
  type DebugHello,
  type DebugPair,
  type DebugPairReply,
  type EndpointKind,
  type PairRefusalReason,
} from "./protocol";
import { DebugLinkSession, sameMachineRemote, type BuildSessionState } from "./session";
import { tauriListenerPort } from "./tauriListener";
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
   * or null. Version 2 (ADR 0403): on every connection the build sends `pair` (role `build`, its `kind`, this code's
   * token) and then `hello`; without a code the `pair` carries no token and a tool on another machine asks a person
   * (0376's accept prompt). A code that doesn't read as one is logged and left out.
   */
  readonly code?: string | null;
  /** The build's endpoint kind, sent in `pair` (default `native` under Tauri, else `page-http` or `page-https` by the page's scheme). */
  readonly kind?: EndpointKind;
  /**
   * For a room code (ADR 0404: the tool waits in a rendezvous room and the build joins it over `webrtc`): the page's own
   * location, whose host completes a LAN room code's address (default the global `location`; null for none).
   */
  readonly page?: PageLocation | null;
  /** For a room code in a native build: this machine's addresses, which complete the code's address. */
  readonly interfaces?: () => readonly NetworkInterfaceAddress[];
  /** For a room code: the `webrtc` transport's options (`debug.iceServers` is added to them). */
  readonly webrtc?: RoomWebRtcOptions;
}

/** A running link. */
export interface DebugLinkHandle {
  /** The link's address (with a room code, the rendezvous it tries now). */
  readonly address: string;
  /** The current session's state ("closed" between attempts, and for good after a refusal). */
  readonly state: BuildSessionState;
  /** Stops the link for good. */
  close(): void;
}

/** The registered topics, loaded for `engine`; those that fail are logged and left out. */
async function loadTopics(engine: Engine, log: (line: string) => void): Promise<Map<string, DebugTopic>> {
  const topics = new Map<string, DebugTopic>();
  for (const [name, load] of debugTopics()) {
    try {
      topics.set(name, (await load())({ engine }));
    } catch (err) {
      log(`[myco] debug link: the "${name}" topic didn't load (${(err as Error)?.message ?? err}).`);
    }
  }
  return topics;
}

/** This endpoint's kind (ADR 0403): a Tauri app is native, a page by its scheme; anything else (Node) can listen too. */
function ownKind(): EndpointKind {
  const g = globalThis as { __TAURI_INTERNALS__?: unknown; location?: { protocol?: string } };
  if (g.__TAURI_INTERNALS__ !== undefined) return "native";
  if (g.location?.protocol === "https:") return "page-https";
  if (g.location?.protocol === "http:") return "page-http";
  return "native";
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

  let token: number | undefined;
  let room: RoomPairCode | null = null;
  if (typeof options.code === "string" && options.code.trim()) {
    const read = decodePairCode(options.code);
    if ("code" in read) {
      token = read.code.token;
      if (read.code.kind === "room") room = read.code;
    } else log(`[myco] debug link: the debug code "${options.code}" isn't a pairing code (${read.refused}); connecting without it.`);
  }
  const kind = options.kind ?? ownKind();

  // A room code (ADR 0404): the tool waits in a rendezvous room; the build joins it and connects over `webrtc`, trying
  // the code's rendezvous candidates in turn. Anything else connects to the tool's listener (`debug.link`).
  let addresses = [config.link];
  let shown = [config.link];
  let joiner: RoomJoinTransport | null = null;
  if (room) {
    const rooms = await import("./rooms");
    const hosted = config.rendezvous ?? null;
    const webrtc = { ...options.webrtc, ...(config.iceServers ? { iceServers: config.iceServers } : {}) };
    const path = rooms.joinPath(kind, room, hosted, rooms.hasWebRtc(webrtc));
    if (path.path !== "webrtc") {
      log(`[myco] debug link: can't join the tool's room: ${rooms.joinRefusalMessage(path.path === "unreachable" ? path.reason : "needs-rendezvous", room, "build")}`);
      return null;
    }
    const page = options.page === undefined ? rooms.currentPage() : options.page;
    const context: AddressContext = page ? { kind: "page", host: page.hostname } : { kind: "native", interfaces: options.interfaces?.() ?? [] };
    const { room: number, token: roomToken } = room;
    shown = rooms.joinCandidates(room, context, hosted);
    addresses = shown.map((url) => rooms.roomAddress(url, number, roomToken));
    joiner = new rooms.RoomJoinTransport({ kind, signalTransport: () => createTransport(options.transport ?? "websocket", { ...options.transportOptions }), webrtc });
  }

  const topics = await loadTopics(engine, log);
  const transportOptions: Record<string, unknown> = { ...options.transportOptions };
  if (config.webrtc !== undefined) transportOptions.webrtc = config.webrtc;
  const transport: Transport = joiner ?? createTransport(options.transport ?? "websocket", transportOptions);
  const hello = { name: options.name, platform: options.platform ?? "web", topics: [...topics.keys()] };

  let session: DebugLinkSession | null = null;
  let wait = 0;
  let stopped = false;
  let refused = false;
  /** Which of `addresses` the current attempt uses (a room code's candidates are tried in turn). */
  let cursor = 0;
  /** A room's pairing was accepted: the room is gone once its session ends. */
  let roomUsed = false;
  /** The ended room attempt already judged by `roomOver`. */
  let judged: DebugLinkSession | null = null;
  const connect = () => {
    const pair: DebugPair = token === undefined ? { role: "build", kind, name: options.name } : { role: "build", kind, token, name: options.name };
    const at = addresses[cursor % addresses.length]!;
    try {
      session = new DebugLinkSession({ transport, connection: transport.connect(at), hello, topics, log, pair });
    } catch (err) {
      session = null;
      log(`[myco] debug link: couldn't connect to ${shown[cursor % shown.length]} (${(err as Error)?.message ?? err}).`);
    }
  };
  /** After a room attempt ended: whether to stop for good (the room is used, gone, or refused the token). */
  const roomOver = (): boolean => {
    const at = addresses[cursor % addresses.length]!;
    const why = joiner!.refusal(at);
    if (roomUsed) log("[myco] debug link: the tool's room is used up; relaunch the build with the room code the tool shows now to pair again.");
    else if (why === "bad-token" || why === "no-room" || why === "locked" || why === "expired") {
      log(`[myco] debug link: the tool's room at ${shown[cursor % shown.length]} refused the code (${why}); relaunch the build with the code the tool shows now.`);
    } else {
      cursor++;
      return false;
    }
    return true;
  };
  if (addresses.length === 0) {
    log("[myco] debug link: the room code names no rendezvous this build can reach.");
    return null;
  }
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
    begin: () => {
      const s = session as DebugLinkSession | null;
      if (!s) return;
      s.frameStart();
      const reply = s.paired;
      if (reply?.accepted && reply.via === "token") token = undefined; // spent: the tool shows its next code
      if (reply?.accepted && joiner) roomUsed = true;
      if (s.refusal && !refused) {
        refused = true;
        log("[myco] debug link: not trying again; relaunch the build with the code the tool shows now.");
      }
    },
    end: (dt) => {
      if (refused) return;
      if (session && session.state !== "closed") {
        session.frameEnd(dt);
        return;
      }
      if (joiner && session && judged !== session) {
        judged = session;
        if (roomOver()) {
          refused = true;
          return;
        }
      }
      wait += Math.max(0, dt);
      if (wait < RECONNECT_SECONDS) return;
      wait = 0;
      connect();
    },
    dispose: stop,
  });

  return {
    get address() {
      return shown[cursor % shown.length]!;
    },
    get state() {
      return (session as DebugLinkSession | null)?.state ?? "closed";
    },
    close: stop,
  };
}

// --- the build listens (ADR 0403 "Roles"; plan contract C3) -----------------------------------------------------------

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
   * among them goes in the address code. Absent or none private: no LAN code (same-machine tools need none). A
   * connection from one of these addresses counts as the same machine.
   */
  readonly interfaces?: () => readonly NetworkInterfaceAddress[];
  /**
   * Whether a connection whose transport names its far end `remote` comes from this machine. Default: loopback
   * addresses, in-process loopback links and the `interfaces` addresses (`sameMachineRemote`); a listening transport
   * that names remotes its own way passes its own.
   */
  readonly sameMachine?: (remote: string) => boolean;
  /**
   * Asks a person whether to let in a tokenless tool from another machine (0376's prompt; the editor's Play, U3).
   * Absent: such a tool is refused with `no-token` (a game has nobody to ask).
   */
  readonly prompt?: (tool: ToolAtTheDoor) => Promise<boolean>;
  /** The token gate's clock, ms (default `performance.now`). */
  readonly now?: () => number;
  /** The token gate's random source (default `crypto.getRandomValues`); a page's room numbers come from it too. */
  readonly randomToken?: (bits: number) => number;
  /** Where the listener's messages go (default `console.warn`). */
  readonly log?: (line: string) => void;
  /**
   * The build's endpoint kind (default: `native` under Tauri, else `page-http` or `page-https` by the page's scheme). A
   * native build listens on a WebSocket; a page offers a rendezvous room (ADR 0404).
   */
  readonly kind?: EndpointKind;
  /** A page's own location, for where its rooms open (`rooms.ts` `roomPlace`); default the global `location`, null for none. */
  readonly page?: PageLocation | null;
  /** The `webrtc` transport's options for a page's rooms (`debug.iceServers` is added to them). */
  readonly webrtc?: RoomWebRtcOptions;
}

/**
 * A listening build (ADR 0403: "whichever side can listen does"): it listens on the first free port of
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
  /**
   * A sentence for the overlay beside or instead of the code, or null: a page's room that is still opening, can't open
   * (and why), or reaches only this machine (opened from `localhost`). Always null on a native listener.
   */
  readonly notice: string | null;
  /** Stops listening and closes every tool's session. */
  close(): void;
}

/** One connection to a listening build: before its pair, while a person is asked, or paired with its session. */
type Visitor =
  | { readonly stage: "door" }
  | { readonly stage: "asking"; readonly pair: DebugPair; answer?: boolean }
  | { readonly stage: "session"; readonly pair: DebugPair; readonly session: DebugLinkSession };

function defaultRandomToken(bits: number): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]! % 2 ** bits;
}

/** The last two octets of the first private IPv4 address among `interfaces`, or null. */
function privateOctets(interfaces: readonly NetworkInterfaceAddress[]): PairOctets | null {
  for (const i of interfaces) {
    if (i.internal || i.family === "IPv6" || !/^\d+\.\d+\.\d+\.\d+$/.test(i.address) || !isPrivateIpv4(i.address)) continue;
    const parts = i.address.split(".").map(Number);
    return [parts[2]!, parts[3]!];
  }
  return null;
}

/**
 * Starts `engine`'s listening debug link as `options.debug` says; null when it doesn't ask to listen (`listen` absent
 * or false) or nothing could listen (every port of the range taken: logged). Topics load as in `startDebugLink`. The
 * listener closes with the Engine.
 *
 * Which way tools reach it is `choosePath`'s (0403's pair table): a native build listens on a WebSocket; a page, which
 * can't listen, offers a rendezvous room instead (ADR 0404, `rooms.ts`): its code is a room code, tools join the room
 * and connect over `webrtc`, and the same tool door (`pair` through the gate, then the session) runs on that
 * connection. `options.transport` is then the transport the room's rendezvous connections use. A page that can make no
 * room (on https with no hosted rendezvous, say) still gets a listener, with no code and `notice` saying why, so its
 * overlay can tell the person.
 */
export async function startBuildListener(engine: Engine, options: BuildListenerOptions): Promise<BuildListener | null> {
  const log = options.log ?? ((line: string) => console.warn(line));
  const { config, problems } = readDebugManifest(options.debug);
  for (const p of problems) log(`[myco] debug link: ${p}`);
  if (!config?.listen) return null;
  const kind = options.kind ?? ownKind();
  const path = choosePath(kind, "page-http", { canListen: { local: true, remote: false }, lanRendezvous: true, hostedRendezvous: true });
  if (path.path !== "websocket") return startRoomListener(engine, options, config, kind, log);
  const lan = config.lan === true;
  const base = config.port ?? DEFAULT_DEBUG_LINK_PORT;

  const transport: Transport = createTransport(options.transport ?? "websocket", { ...options.transportOptions });
  let address = "";
  let port = 0;
  for (let offset = 0; offset < PAIR_PORT_OFFSETS && !address; offset++) {
    const at = `ws://${lan ? "0.0.0.0" : "127.0.0.1"}:${base + offset}${DEBUG_LINK_PATH}`;
    try {
      await transport.listen(at);
      // The desktop's native listener scans the range itself (ADR 0403, L8) and may have bound a later port than asked;
      // the code must name the port it really got.
      port = tauriListenerPort(transport) ?? base + offset;
      address = `ws://${lan ? "0.0.0.0" : "127.0.0.1"}:${port}${DEBUG_LINK_PATH}`;
    } catch {
      // taken: try the next port
    }
  }
  if (!address) {
    transport.close();
    log(`[myco] debug link: couldn't listen: ports ${base}..${base + PAIR_PORT_OFFSETS - 1} are all taken.`);
    return null;
  }

  const topics = await loadTopics(engine, log);
  const interfaces = options.interfaces?.() ?? [];
  const own = interfaces.map((i) => i.address);
  const now = options.now ?? (() => performance.now());
  const gate = new TokenGate({ now, randomToken: options.randomToken ?? defaultRandomToken, tokenBits: PAIR_TOKEN_BITS });
  const octets = lan ? privateOctets(interfaces) : null;
  const portOffset = port - PAIR_BASE_PORT;
  const codeable = octets !== null && portOffset >= 0 && portOffset < PAIR_PORT_OFFSETS;
  if (lan && octets === null) log("[myco] debug link: no private network address is known, so there's no pairing code; type the full address in the tool.");
  else if (lan && !codeable) log(`[myco] debug link: a pairing code names ports ${PAIR_BASE_PORT}..${PAIR_BASE_PORT + PAIR_PORT_OFFSETS - 1}; this listener is on ${port}, so type the full address in the tool.`);
  let shown: { serial: number; code: string } | null = null;

  const door = serveTools(engine, {
    transport,
    topics,
    hello: { name: options.name, platform: options.platform ?? "desktop", topics: [...topics.keys()] },
    sameMachine: options.sameMachine ?? ((remote: string) => sameMachineRemote(remote, own)),
    gate,
    prompt: options.prompt,
    log,
  });

  return {
    address,
    port,
    lan,
    get code() {
      if (!codeable) return null;
      const t = gate.current();
      if (shown?.serial !== t.serial) shown = { serial: t.serial, code: encodePairCode({ kind: "address", octets: octets!, portOffset, token: t.token }) };
      return shown.code;
    },
    get token() {
      return codeable ? gate.current() : null;
    },
    get lockedUntil() {
      return gate.lockedUntil();
    },
    get tools() {
      return door.tools();
    },
    notice: null,
    close: door.close,
  };
}

/** A page's listener: a room offer (`rooms.ts`) with the tool door on its connections. */
async function startRoomListener(
  engine: Engine,
  options: BuildListenerOptions,
  config: DebugManifest,
  kind: EndpointKind,
  log: (line: string) => void,
): Promise<BuildListener> {
  const rooms = await import("./rooms");
  const webrtc = { ...options.webrtc, ...(config.iceServers ? { iceServers: config.iceServers } : {}) };
  const page = options.page === undefined ? rooms.currentPage() : options.page;
  const place = rooms.roomPlace(kind, page, config.rendezvous ?? null, rooms.hasWebRtc(webrtc));
  if (place.kind === "none") {
    log(`[myco] debug link: no pairing room: ${place.message}`);
    return { address: "", port: 0, lan: false, code: null, token: null, lockedUntil: null, tools: [], notice: place.message, close() {} };
  }
  if (place.notice) log(`[myco] debug link: ${place.notice}`);
  const now = options.now ?? (() => performance.now());
  const random = options.randomToken ?? defaultRandomToken;
  const gate = new TokenGate({ now, randomToken: random, tokenBits: rooms.roomTokenBits(place) });
  const offer = new rooms.RoomOffer({
    place,
    gate,
    kind,
    signalTransport: () => createTransport(options.transport ?? "websocket", { ...options.transportOptions }),
    webrtc,
    now,
    randomRoom: random,
  });
  await offer.listen();
  const topics = await loadTopics(engine, log);
  const door = serveTools(engine, {
    transport: offer,
    topics,
    hello: { name: options.name, platform: options.platform ?? "web", topics: [...topics.keys()] },
    // A joined room's peer is never "this machine" by its address: every tool pairs with the room's token.
    sameMachine: () => false,
    gate,
    prompt: options.prompt,
    log,
  });
  const port = Number(new URL(place.url).port) || (place.url.startsWith("wss:") ? 443 : 80);
  return {
    address: place.url,
    port,
    lan: place.kind === "lan",
    get code() {
      return offer.code;
    },
    get token() {
      return offer.code ? gate.current() : null;
    },
    get lockedUntil() {
      return gate.lockedUntil();
    },
    get tools() {
      return door.tools();
    },
    get notice() {
      const state = offer.state;
      const waiting = state.kind === "retrying" ? `Can't open a pairing room at ${place.url} (${state.why}); trying again.` : state.kind === "waiting" ? null : "Opening a pairing room…";
      return [waiting, place.notice].filter((s): s is string => !!s).join("\n") || null;
    },
    close: door.close,
  };
}

/** What the tool door needs (`serveTools`). */
interface ToolDoorOptions {
  /** The transport tools connect on (polled by the door each frame; closed with it). */
  readonly transport: Transport;
  readonly topics: Map<string, DebugTopic>;
  readonly hello: DebugHello;
  readonly sameMachine: (remote: string) => boolean;
  readonly gate: TokenGate;
  readonly prompt?: (tool: ToolAtTheDoor) => Promise<boolean>;
  readonly log: (line: string) => void;
}

/**
 * Accepts tools on `transport`, on the Engine's frame: each one's first message is `pair` (role `tool`), answered by the
 * gate (a same-machine tool needs no token; a tokenless one from another machine goes to `prompt`, or is refused with
 * `no-token`); then the build says `hello` and serves its topics. Closes with the Engine, or by `close`.
 */
function serveTools(engine: Engine, o: ToolDoorOptions): { tools(): ConnectedTool[]; close(): void } {
  const { transport, topics, hello, log, gate } = o;
  const visitors = new Map<TransportConnection, Visitor>();

  const send = (c: TransportConnection, reply: DebugPairReply) => {
    if (c.state === "open") c.send("reliable", encodeEnvelope(pairedEnvelope(reply)));
  };
  const refuse = (c: TransportConnection, reason: PairRefusalReason) => {
    const message = pairRefusalMessage(reason);
    send(c, { accepted: false, reason, message });
    visitors.delete(c);
    if (c.state !== "closed") c.close(message);
  };
  const admit = (c: TransportConnection, pair: DebugPair, via: "token" | "same-machine" | "prompt") => {
    send(c, { accepted: true, via });
    visitors.set(c, { stage: "session", pair, session: new DebugLinkSession({ transport, connection: c, hello, topics, log }) });
  };
  const fail = (c: TransportConnection, message: string) => {
    if (c.state === "open") c.send("reliable", encodeEnvelope({ kind: EnvelopeKind.error, topic: "", id: 0, payload: jsonPayload({ message }) }));
    visitors.delete(c);
    if (c.state !== "closed") c.close(message);
  };
  /** A tool's first message: its pair, answered by the accept rule. */
  const door = (c: TransportConnection, data: Uint8Array) => {
    const decoded = decodeEnvelope(data);
    if ("refused" in decoded) return fail(c, decoded.refused);
    if (decoded.envelope.kind !== EnvelopeKind.pair) return fail(c, "A listening build expects pair as the first message.");
    const read = readJsonPayload(decoded.envelope.payload);
    const made = "refused" in read ? read : readPair(read.value);
    if ("refused" in made) return fail(c, made.refused);
    const pair = made.pair;
    if (pair.role !== "tool") return refuse(c, "role");
    const local = o.sameMachine(c.remote);
    const verdict = gate.check(pair.token, { sameMachine: local });
    if (verdict.verdict === "admit") return admit(c, pair, verdict.via);
    if (verdict.verdict === "refuse") return refuse(c, verdict.reason);
    const prompt = o.prompt;
    if (!prompt) return refuse(c, "no-token");
    const asking: Visitor = { stage: "asking", pair };
    visitors.set(c, asking);
    let asked: Promise<boolean>;
    try {
      asked = Promise.resolve(prompt({ ...pair, remote: c.remote, sameMachine: local }));
    } catch {
      asked = Promise.resolve(false);
    }
    asked.then(
      (yes) => void (asking.answer = yes === true),
      () => void (asking.answer = false),
    );
  };

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    removeHook();
    for (const [c, v] of visitors) {
      if (v.stage === "session") v.session.close("The build stopped listening.");
      else if (c.state !== "closed") c.close("The build stopped listening.");
    }
    visitors.clear();
    transport.close();
    for (const t of topics.values()) t.dispose?.();
  };
  const removeHook = engine._addFrameHook({
    begin: () => {
      const routed = new Map<TransportConnection, TransportEvent[]>();
      for (const event of transport.poll()) {
        const c = event.connection;
        const v = visitors.get(c);
        if (event.kind === "open") {
          if (!v) visitors.set(c, { stage: "door" });
        } else if (!v) {
          continue;
        } else if (v.stage === "session") {
          const list = routed.get(c);
          if (list) list.push(event);
          else routed.set(c, [event]);
        } else if (event.kind === "close") {
          visitors.delete(c);
        } else if (v.stage === "door") {
          door(c, event.data);
        } // while a person is asked the tool waits for `paired`; anything it sends meanwhile is dropped
      }
      // Prompts answered since the last frame.
      for (const [c, v] of visitors) {
        if (v.stage !== "asking" || v.answer === undefined) continue;
        if (c.state !== "open") visitors.delete(c);
        else if (v.answer) admit(c, v.pair, "prompt");
        else refuse(c, "declined");
      }
      for (const [c, v] of visitors) {
        if (v.stage !== "session") continue;
        v.session.frameStart(routed.get(c) ?? []);
        if (v.session.state === "closed") visitors.delete(c);
      }
    },
    end: (dt) => {
      for (const [c, v] of visitors) {
        if (v.stage !== "session") continue;
        v.session.frameEnd(dt);
        if (v.session.state === "closed") visitors.delete(c);
      }
    },
    dispose: stop,
  });

  return {
    tools() {
      const out: ConnectedTool[] = [];
      for (const [c, v] of visitors) if (v.stage === "session" && v.session.state !== "closed") out.push({ name: v.pair.name ?? "A tool", kind: v.pair.kind, remote: c.remote });
      return out;
    },
    close: stop,
  };
}
