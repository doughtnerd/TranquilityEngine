// Room codes (ADR 0403 "Pairing code", 0404; plan task R5): pairs where neither side can reach a listener on the other
// meet in a rendezvous room and connect over the `webrtc` transport, signalled through that room.
//
// **Who makes the room (0404).** The waiting side, the one that shows the code, opens a room on a rendezvous it can
// reach (`roomPlace`) and shows its code; the joining side reads the rendezvous from the code (`joinCandidates`), joins
// with the code's room and token, and makes the WebRTC offer. A room is single use: once the two peers connect, or after
// 5 minutes, the rendezvous forgets it, so the waiting side opens the next room for the next code (`RoomOffer`).
//
// **Where a page opens its room (`roomPlace`).**
// - A page on http opens it on its own origin's `/myco-rendezvous` (the dev server, a debug export's `serve.mjs`). When
//   the page was opened by a private LAN address (`http://192.168.1.20:3000/`) on one of `RENDEZVOUS_PORTS`, the code
//   carries that address's last two octets and the port's index: a LAN room code.
// - Opened from `localhost` (or `127.x`, `[::1]`), the page can't name its LAN address: a page can't list its machine's
//   interfaces. With a hosted rendezvous configured it uses that one (a `Z` code works from anywhere). Without one it
//   still opens a room on its own origin and shows a LAN room code carrying `0.1` (127.0.0.1's last two octets), with
//   the note "open this page by its network address to pair from another machine": a tool on the same machine joins it
//   (`joinCandidates` tries `127.0.0.1` last for a code carrying `0.1`); one on another machine can't, and the note
//   says what to do.
// - Otherwise (a page on https, an http page on a port no code names, a page by a host name) the hosted rendezvous
//   (`debug.rendezvous`, Preferences) when one is configured, else no room, with a sentence saying why.
// Which of LAN and hosted is chosen is `choosePath`'s rule 3 and 4 (0403's pair table), so the rules live in one place.
//
// **One token, checked twice.** The code's token is the waiting side's `TokenGate`'s current token (20 bits for a LAN
// room, 30 for a hosted one). The rendezvous checks it when the joining side takes its seat (a wrong one never gets an
// offer through, and five lock the room), and the waiting side's gate checks it again in the connection's `pair`, as a
// listener does for an address code. The waiting side doesn't trust a joined seat alone: a hosted rendezvous may be
// someone else's service. The gate then spends the token, and the next room is opened with the next one.
//
// Everything here is reached only from the debug link (`host.ts` by `import()`, the editor's link), so a release export
// holds none of it (the `DEBUG_LINK` rule in `vite.shared.ts`); importing this module registers the `webrtc` transport.
import { createTransport, registerTransport, type Transport, type TransportConnection, type TransportEvent } from "../net/Transport";
import type { PeerConnectionConstructor } from "../net/transport/datagramLane";
import { WebRtcTransport, type WebRtcIceServer, type WebRtcSignaller, type WebRtcTransportOptions } from "../net/transport/webrtc";
import { addressCandidates, isPrivateIpv4, type AddressContext } from "./pairing/address";
import {
  HOSTED_ROOM_BITS,
  LAN_ROOM_BITS,
  LAN_ROOM_TOKEN_BITS,
  PAIR_TOKEN_BITS,
  RENDEZVOUS_PORTS,
  encodePairCode,
  type PairOctets,
  type RendezvousLocation,
  type RoomPairCode,
} from "./pairing/code";
import type { TokenGate } from "./pairing/gate";
import { choosePath, type PairPath, type UnreachableReason } from "./pairing/path";
import type { EndpointKind } from "./protocol";
import { RendezvousClient, rendezvousUrl } from "./rendezvous/client";
import { RENDEZVOUS_PATH } from "./rendezvous/protocol";

registerTransport("webrtc", (options) => new WebRtcTransport(options as unknown as WebRtcTransportOptions));

/** After a rendezvous couldn't be reached or refused the room, the waiting side tries again this much later, ms. */
export const ROOM_RETRY_MS = 2000;

/** What a page knows of where it was loaded from (`location`). */
export interface PageLocation {
  /** `http:` or `https:`. */
  readonly protocol: string;
  readonly hostname: string;
  /** The port as text, "" for the scheme's default. */
  readonly port: string;
}

/** The page's own location, or null under a native shell or outside a page. */
export function currentPage(): PageLocation | null {
  const g = globalThis as { __TAURI_INTERNALS__?: unknown; location?: PageLocation };
  if (g.__TAURI_INTERNALS__ !== undefined || !g.location || typeof g.location.protocol !== "string") return null;
  return { protocol: g.location.protocol, hostname: g.location.hostname, port: g.location.port };
}

/** The `webrtc` transport's options a room passes on (the rest comes from the room). */
export interface RoomWebRtcOptions {
  /** The `RTCPeerConnection` constructor (default the global one). */
  readonly PeerConnection?: PeerConnectionConstructor;
  /** STUN/TURN servers (`debug.iceServers`, Preferences); default none. */
  readonly iceServers?: readonly WebRtcIceServer[];
  /** Give up on a peer connection that hasn't opened by then, ms (the transport's default otherwise). */
  readonly connectTimeoutMs?: number;
}

/** Whether this side can make a peer connection (a WebKitGTK build without WebRTC can't). */
export function hasWebRtc(options?: RoomWebRtcOptions): boolean {
  return options?.PeerConnection !== undefined || typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection === "function";
}

/** Where the waiting side opens its rooms, or why it can't. */
export type RoomPlace =
  /**
   * A rendezvous on the LAN (the page's own server): LAN room codes. `loopbackOnly`: the page was opened from
   * `localhost`, so the code reaches only tools on this machine (`notice` says so).
   */
  | { readonly kind: "lan"; readonly url: string; readonly location: RendezvousLocation; readonly loopbackOnly: boolean; readonly notice: string | null }
  /** The configured hosted rendezvous: hosted (`Z`) room codes. */
  | { readonly kind: "hosted"; readonly url: string; readonly notice: null }
  /** No room can be made; `message` says why. */
  | { readonly kind: "none"; readonly message: string };

/** The note a page opened from `localhost` shows beside its code. */
export const LOOPBACK_ROOM_NOTICE = "Open this page by its network address (not localhost) to pair from another machine; this code pairs only with tools on this machine.";

const LOOPBACK_OCTETS: PairOctets = [0, 1];

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "[::1]" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** Whether `hosted` is a rendezvous URL a `kind` endpoint can open: a page on https only reaches `wss://` (mixed content). */
function usableHosted(kind: EndpointKind, hosted: string | null): hosted is string {
  return !!hosted && (kind !== "page-https" || hosted.startsWith("wss:"));
}

/**
 * Where a waiting `kind` endpoint loaded from `page` opens its rooms (the rules at the head of this file); `hosted` is
 * the configured hosted rendezvous (`debug.rendezvous`, Preferences) or null; `webrtc` whether this side has WebRTC.
 */
export function roomPlace(kind: EndpointKind, page: PageLocation | null, hosted: string | null, webrtc = true): RoomPlace {
  let lan: { url: string; location: RendezvousLocation } | null = null;
  let loopback: { url: string; location: RendezvousLocation } | null = null;
  let offList = "";
  if (page && page.protocol === "http:") {
    const port = page.port ? Number(page.port) : 80;
    const host = page.hostname;
    const onList = RENDEZVOUS_PORTS.includes(port);
    if (!onList) offList = `This page's server is on port ${port}, and a room code can only name a rendezvous on ${RENDEZVOUS_PORTS.join(", ")}: serve the page on one of those, or configure a hosted rendezvous.`;
    else if (isPrivateIpv4(host)) {
      const parts = host.split(".").map(Number);
      lan = { url: rendezvousUrl(host, port), location: { octets: [parts[2]!, parts[3]!], port } };
    } else if (isLoopbackHost(host)) loopback = { url: rendezvousUrl(host.startsWith("[") || host === "::1" ? "127.0.0.1" : host, port), location: { octets: LOOPBACK_OCTETS, port } };
  }
  const path = choosePath(kind, "page-http", {
    canListen: { local: false, remote: false },
    webrtc: { local: webrtc, remote: true },
    lanRendezvous: lan !== null,
    hostedRendezvous: usableHosted(kind, hosted),
  });
  if (path.path === "webrtc") {
    if (path.rendezvous === "lan" && lan) return { kind: "lan", ...lan, loopbackOnly: false, notice: null };
    if (path.rendezvous === "hosted" && hosted) return { kind: "hosted", url: hosted, notice: null };
  }
  if (path.path === "unreachable" && path.reason === "needs-rendezvous" && loopback) return { kind: "lan", ...loopback, loopbackOnly: true, notice: LOOPBACK_ROOM_NOTICE };
  const reason: UnreachableReason = path.path === "unreachable" ? path.reason : "needs-rendezvous";
  if (reason === "no-webrtc") return { kind: "none", message: "This browser has no WebRTC, so it can't offer a pairing room." };
  if (reason === "needs-hosted-rendezvous") {
    return { kind: "none", message: "A page on https pairs only through a hosted rendezvous (a wss:// address), and none is configured." };
  }
  if (offList) return { kind: "none", message: offList };
  if (!page || page.protocol !== "http:") return { kind: "none", message: "A room needs a rendezvous: this side has no server of its own to use, and no hosted rendezvous is configured." };
  return { kind: "none", message: `Open this page by its network address (http://<this machine's address>:${page.port || 80}/) to pair, or configure a hosted rendezvous.` };
}

/** The token bits of the codes a `place` shows (the waiting side's `TokenGate` issues tokens this wide). */
export function roomTokenBits(place: Exclude<RoomPlace, { kind: "none" }>): number {
  return place.kind === "lan" ? LAN_ROOM_TOKEN_BITS : PAIR_TOKEN_BITS;
}

// --- the joining side -------------------------------------------------------------------------------------------------

/** The address a joining `webrtc` connection is given: the rendezvous and the room and token to join. */
export function roomAddress(url: string, room: number, token: number): string {
  return `${url}#room=${room}&token=${token}`;
}

/** `roomAddress`'s parts, or null for anything else. */
function readRoomAddress(address: string): { url: string; room: number; token: number } | null {
  const m = /^(.*)#room=(\d+)&token=(\d+)$/.exec(address);
  return m ? { url: m[1]!, room: Number(m[2]), token: Number(m[3]) } : null;
}

/** The path a `kind` endpoint joining `code` takes (`choosePath`): `webrtc` through the code's rendezvous, or why not. */
export function joinPath(kind: EndpointKind, code: RoomPairCode, hosted: string | null, webrtc = true): PairPath {
  return choosePath(kind, "page-http", {
    canListen: { local: false, remote: false },
    webrtc: { local: webrtc, remote: true },
    lanRendezvous: code.rendezvous !== null,
    hostedRendezvous: code.rendezvous === null && usableHosted(kind, hosted),
  });
}

/** Why a room code can't be joined, as a sentence for `who` (a tool's Connect dialog, or a build's log). */
export function joinRefusalMessage(reason: UnreachableReason, code: RoomPairCode, who: "tool" | "build"): string {
  const where = who === "tool" ? "Settings > Debug link" : "game.json's debug.rendezvous (the export's Debugging section)";
  if (reason === "no-webrtc") return "There's no WebRTC here, so a room code can't connect. Use the other side's address code, or a browser with WebRTC.";
  if (reason === "needs-hosted-rendezvous") {
    return code.rendezvous
      ? "This page is on https, so it can't reach a rendezvous on the local network (a ws:// address is blocked from https). Open it over http, or have the other side use a hosted rendezvous."
      : `This page is on https and that's a hosted room code, but no hosted rendezvous with a wss:// address is set. Set the one the other side uses in ${where}.`;
  }
  return `That's a hosted room code (it starts with Z), and no hosted rendezvous is configured. Set the one the other side uses in ${where}.`;
}

/**
 * The rendezvous URLs to try for `code`, best first: a LAN room code's address completed from `context` as an address
 * code's is (plus `127.0.0.1` last for a code carrying `0.1`, the one a page opened from `localhost` shows); a hosted
 * code's the configured `hosted` one (none without it).
 */
export function joinCandidates(code: RoomPairCode, context: AddressContext, hosted: string | null): string[] {
  if (!code.rendezvous) return hosted ? [hosted] : [];
  const { octets, port } = code.rendezvous;
  const urls = addressCandidates({ octets, portOffset: 0 }, context, { port, path: RENDEZVOUS_PATH }).map((c) => c.url);
  const loopback = rendezvousUrl("127.0.0.1", port);
  if (octets[0] === LOOPBACK_OCTETS[0] && octets[1] === LOOPBACK_OCTETS[1] && !urls.includes(loopback)) urls.push(loopback);
  return urls;
}

/** Why a rendezvous ended a join (`RendezvousClient.error`). */
export type RoomRefusal = RendezvousClient["error"];

export interface RoomTransportOptions {
  /** This side's endpoint kind, told to the other seat. */
  readonly kind: EndpointKind;
  /** A new transport for each rendezvous connection (a WebSocket transport in a build, loopback in tests). */
  readonly signalTransport: () => Transport;
  readonly webrtc?: RoomWebRtcOptions;
}

function webrtcTransport(signaller: (address: string, role: "offer" | "answer") => WebRtcSignaller, webrtc?: RoomWebRtcOptions): Transport {
  return createTransport("webrtc", {
    signaller,
    ...(webrtc?.PeerConnection ? { PeerConnection: webrtc.PeerConnection } : {}),
    ...(webrtc?.iceServers ? { iceServers: webrtc.iceServers } : {}),
    ...(webrtc?.connectTimeoutMs !== undefined ? { connectTimeoutMs: webrtc.connectTimeoutMs } : {}),
  });
}

/**
 * The joining side's transport: `connect(roomAddress(url, room, token))` joins that room on that rendezvous and makes
 * the WebRTC offer through it; the connection opens when the peer connection does. A tool's `ToolConnector` and a
 * build's session run over it as over a WebSocket. `refusal(address)` says why the rendezvous ended the last join to
 * `address` (a wrong token, no such room, locked), for the person's message.
 */
export class RoomJoinTransport implements Transport {
  private readonly inner: Transport;
  private readonly clients = new Map<string, RendezvousClient>();

  constructor(private readonly options: RoomTransportOptions) {
    this.inner = webrtcTransport((address) => {
      const at = readRoomAddress(address);
      if (!at) throw new Error(`"${address}" isn't a room address.`);
      const client = RendezvousClient.joinRoom({ transport: options.signalTransport(), url: at.url, kind: options.kind, room: at.room, token: at.token });
      this.clients.set(address, client);
      return client;
    }, options.webrtc);
  }

  /** Why the rendezvous ended the last join to `address`, or null (it didn't, or nothing joined there). */
  refusal(address: string): RoomRefusal {
    return this.clients.get(address)?.error ?? null;
  }

  listen(): Promise<void> {
    return Promise.reject(new Error("A room is joined with connect(); RoomOffer opens one."));
  }

  connect(address: string): TransportConnection {
    return this.inner.connect(address);
  }

  poll(): TransportEvent[] {
    return this.inner.poll();
  }

  close(): void {
    this.inner.close();
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }
}

// --- the waiting side -------------------------------------------------------------------------------------------------

export interface RoomOfferOptions extends RoomTransportOptions {
  /** Where the rooms are opened (`roomPlace`, not `none`). */
  readonly place: Exclude<RoomPlace, { kind: "none" }>;
  /** The gate behind the codes (its token bits `roomTokenBits(place)`); the listener on this transport checks `pair` with it. */
  readonly gate: TokenGate;
  /** The clock, ms (the gate's), for `ROOM_RETRY_MS`. */
  now(): number;
  /** A random whole number in 0..2^bits-1, for room numbers. */
  randomRoom(bits: number): number;
}

/** Where a room offer stands. */
export type RoomOfferState =
  /** A room is being opened (the rendezvous hasn't given the seat yet). */
  | { readonly kind: "opening" }
  /** The room is open and its code shown. */
  | { readonly kind: "waiting"; readonly code: string }
  /** Someone joined; the peers are connecting (the next room opens once they have, or once this fails). */
  | { readonly kind: "joined" }
  /** The rendezvous couldn't be reached or refused the room; tried again `ROOM_RETRY_MS` later. */
  | { readonly kind: "retrying"; readonly why: string };

/**
 * The waiting side's transport: `listen()` opens a room on the place's rendezvous and answers the offer that comes
 * through it; each joined room becomes one connection (an `open` event), as a listening WebSocket's clients do, so a
 * `DebugLinkListener` or a build's tool door runs over it unchanged. It keeps one room open at a time, always with the
 * gate's current token: a new room after each pairing, expiry or failure, and when the gate issues a new token (a
 * pairing spent it, or it expired) while nobody has joined. Read `code` each frame: it changes with the room.
 */
export class RoomOffer implements Transport {
  private readonly inner: Transport;
  private current: RendezvousClient | null = null;
  private retryAt: number | null = null;
  private problem = "";
  private listening = false;
  private closed = false;
  private shown: { room: number; token: number; code: string } | null = null;

  constructor(private readonly options: RoomOfferOptions) {
    const bits = options.place.kind === "lan" ? LAN_ROOM_BITS : HOSTED_ROOM_BITS;
    this.inner = webrtcTransport(() => {
      const client = RendezvousClient.openRoom({
        transport: options.signalTransport(),
        url: options.place.url,
        kind: options.kind,
        draw: () => ({ room: options.randomRoom(bits), token: options.gate.current().token }),
      });
      this.current = client;
      return client;
    }, options.webrtc);
  }

  /** The rendezvous rooms open on. */
  get url(): string {
    return this.options.place.url;
  }

  /** The room code to show now, or null while no room is open and waiting. */
  get code(): string | null {
    const s = this.state;
    return s.kind === "waiting" ? s.code : null;
  }

  get state(): RoomOfferState {
    const c = this.current;
    if (!c || c.state === "closed") return this.retryAt !== null ? { kind: "retrying", why: this.problem } : { kind: "opening" };
    if (c.peerKind !== null) return { kind: "joined" };
    if (!c.joined || c.token !== this.options.gate.current().token) return { kind: "opening" };
    if (this.shown?.room !== c.room || this.shown.token !== c.token) {
      const place = this.options.place;
      const code = encodePairCode({ kind: "room", rendezvous: place.kind === "lan" ? place.location : null, room: c.room, token: c.token });
      this.shown = { room: c.room, token: c.token, code };
    }
    return { kind: "waiting", code: this.shown.code };
  }

  /** Starts offering rooms (the address is the place's; anything given is ignored). */
  async listen(): Promise<void> {
    if (this.closed) throw new Error("This room offer is closed.");
    if (this.listening) return;
    this.listening = true;
    await this.open();
  }

  connect(): TransportConnection {
    throw new Error("A room offer only waits; RoomJoinTransport joins a room.");
  }

  poll(): TransportEvent[] {
    const events = this.inner.poll();
    if (this.listening && !this.closed) this.maintain();
    return events;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.current?.close();
    this.inner.close();
  }

  /** Opens the next room when the last one is done, failed, or holds a token the gate no longer issues. */
  private maintain(): void {
    const c = this.current;
    if (c && c.state !== "closed") {
      if (c.peerKind === null && c.joined && c.token !== this.options.gate.current().token) {
        c.close(); // its connection fails unseen; a room with the gate's token replaces it
        void this.open();
      }
      return;
    }
    if (c) {
      this.current = null;
      // Done (the peers connected: the client closed itself), expired, or the joiner left: the next room at once.
      // Anything else (unreachable, refused) waits a little, so a missing rendezvous isn't hammered.
      const done = c.joined && (c.error === null || c.error === "expired" || c.error === "peer-left");
      if (done) {
        this.retryAt = null;
        this.problem = "";
      } else {
        this.problem = c.closedReason || "The rendezvous couldn't be reached.";
        this.retryAt = this.options.now() + ROOM_RETRY_MS;
      }
    }
    if (this.retryAt !== null && this.options.now() < this.retryAt) return;
    this.retryAt = null;
    void this.open();
  }

  private async open(): Promise<void> {
    await this.inner.listen(this.options.place.url);
  }
}
