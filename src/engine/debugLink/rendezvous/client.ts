// The rendezvous client (ADR 0403 "Rendezvous"; plan task R1): connects out to a rendezvous and is the `webrtc`
// transport's `WebRtcSignaller` for one seat of one room. The waiting side (it shows the room code) opens a room;
// the joining side (it typed the code) joins it. Polled like transports are (ADR 0033): `poll()` reads the connection.
//
//     const signaller = RendezvousClient.openRoom({ transport, url, kind: "native", draw });  // waiting
//     signaller.room, signaller.token   // build the room code (`pairing/code.ts`) once `signaller.joined`
//     const signaller = RendezvousClient.joinRoom({ transport, url, kind, room, token });     // joining
//
// Use one `Transport` per client: the client polls it and owns it (closing the client closes the transport unless
// `ownsTransport` is false). `state` is `connecting` until the other seat sits (`peer-joined`), `open` while both do,
// and `closed` after, with `closedReason` saying why and `error` the rendezvous's reason when it refused something.
import type { WebRtcSignal, WebRtcSignaller } from "../../net/transport/webrtc";
import type { Transport, TransportConnection } from "../../net/Transport";
import type { EndpointKind } from "../protocol";
import {
  RENDEZVOUS_PATH,
  RENDEZVOUS_VERSION,
  decodeServerMessage,
  encodeRendezvousMessage,
  type RendezvousClientMessage,
  type RendezvousErrorReason,
  type RoomSeat,
} from "./protocol";

/** How many times a waiting side draws another room when the rendezvous says `room-taken`. */
export const MAX_ROOM_DRAWS = 8;

/** A rendezvous's WebSocket URL from its host and port (`ws://192.168.1.20:7790/myco-rendezvous`). */
export function rendezvousUrl(host: string, port: number, secure = false): string {
  return `${secure ? "wss" : "ws"}://${host}:${port}${RENDEZVOUS_PATH}`;
}

export interface RendezvousClientOptions {
  /** A transport of its own to connect with (a WebSocket transport in a build, loopback in tests). */
  readonly transport: Transport;
  /** The rendezvous's address (`rendezvousUrl(...)`; for loopback, its listen address). */
  readonly url: string;
  /** This side's endpoint kind, passed to the other seat. */
  readonly kind: EndpointKind;
  /** Close `transport` with the client (default true). */
  readonly ownsTransport?: boolean;
}

export interface OpenRoomOptions extends RendezvousClientOptions {
  /** A room and token to ask for: a whole room number and a token in the ranges the room code holds. Called again after `room-taken`. */
  draw(): { readonly room: number; readonly token: number };
}

export interface JoinRoomOptions extends RendezvousClientOptions {
  readonly room: number;
  readonly token: number;
}

export class RendezvousClient implements WebRtcSignaller {
  /** The seat this client takes. */
  readonly seat: RoomSeat;
  private readonly transport: Transport;
  private readonly url: string;
  private readonly kind: EndpointKind;
  private readonly ownsTransport: boolean;
  private readonly draw: (() => { room: number; token: number }) | null;
  private draws = 1;
  private connection: TransportConnection | null = null;
  private inbox: WebRtcSignal[] = [];
  private _state: "connecting" | "open" | "closed" = "connecting";
  private _reason = "";
  private _error: RendezvousErrorReason | "expired" | "peer-left" | null = null;
  private _joined = false;
  private _room: number;
  private _token: number;
  private _peerKind: EndpointKind | null = null;
  private _expiresIn = 0;
  private sentConnected = false;

  private constructor(options: RendezvousClientOptions, seat: RoomSeat, room: number, token: number, draw: (() => { room: number; token: number }) | null) {
    this.transport = options.transport;
    this.url = options.url;
    this.kind = options.kind;
    this.ownsTransport = options.ownsTransport !== false;
    this.seat = seat;
    this._room = room;
    this._token = token;
    this.draw = draw;
    this.open();
  }

  /** The waiting side: opens a room on the rendezvous. Its `room` and `token` are the ones to show in a room code, once `joined`. */
  static openRoom(options: OpenRoomOptions): RendezvousClient {
    const first = options.draw();
    return new RendezvousClient(options, "waiting", first.room, first.token, options.draw);
  }

  /** The joining side: joins `room` with `token` (from the typed room code). */
  static joinRoom(options: JoinRoomOptions): RendezvousClient {
    return new RendezvousClient(options, "joining", options.room, options.token, null);
  }

  get state(): "connecting" | "open" | "closed" {
    return this._state;
  }

  get closedReason(): string {
    return this._reason;
  }

  /** The rendezvous's refusal reason, `expired` or `peer-left`, if that is why the session closed. */
  get error(): RendezvousErrorReason | "expired" | "peer-left" | null {
    return this._error;
  }

  /** The room number: the one asked for (the waiting side's may change after a `room-taken`, until `joined`). */
  get room(): number {
    return this._room;
  }

  /** The room's token. */
  get token(): number {
    return this._token;
  }

  /** Whether the rendezvous has given this client its seat (a waiting side shows its room code from then on). */
  get joined(): boolean {
    return this._joined;
  }

  /** The other seat's endpoint kind, once it sat. */
  get peerKind(): EndpointKind | null {
    return this._peerKind;
  }

  /** Milliseconds the room has left, as of `joined` (the rendezvous's clock, not this one). */
  get expiresIn(): number {
    return this._expiresIn;
  }

  /** Read the connection without taking signals (for a view that shows the room code before anyone joins). */
  step(): void {
    if (this._state === "closed") return;
    for (const event of this.transport.poll()) {
      if (event.connection !== this.connection) continue;
      if (event.kind === "close") this.finish(`The rendezvous connection closed: ${event.reason}`, null);
      else if (event.kind === "data" && event.channel === "reliable") this.receive(event.data);
      if (this.state === "closed") return;
    }
  }

  send(signal: WebRtcSignal): void {
    if (this._state !== "open") return;
    this.write(signal);
  }

  poll(): WebRtcSignal[] {
    this.step();
    return this.inbox.splice(0);
  }

  connected(): void {
    if (this._state !== "open" || this.sentConnected) return;
    this.sentConnected = true;
    this.write({ t: "connected" });
    this.close();
  }

  close(): void {
    if (this._state !== "closed") {
      this.write({ t: "leave" });
      this.finish("Closed by this side.", null);
    }
  }

  private open(): void {
    this.connection = this.transport.connect(this.url);
    this.write({ t: "join", v: RENDEZVOUS_VERSION, room: this._room, token: this._token, seat: this.seat, kind: this.kind });
  }

  private write(m: RendezvousClientMessage): void {
    const c = this.connection;
    if (!c || c.state === "closed") return;
    try {
      c.send("reliable", encodeRendezvousMessage(m));
    } catch (error) {
      this.finish(error instanceof Error ? error.message : String(error), null);
    }
  }

  private receive(data: Uint8Array): void {
    const decoded = decodeServerMessage(data);
    if ("refused" in decoded) return this.finish(`The rendezvous sent something unreadable: ${decoded.refused}`, null);
    const m = decoded.message;
    switch (m.t) {
      case "joined":
        this._joined = true;
        this._expiresIn = m.expiresIn;
        break;
      case "peer-joined":
        this._peerKind = m.kind;
        if (this._state === "connecting") this._state = "open";
        break;
      case "peer-left":
        this.finish("The other side left the room.", "peer-left");
        break;
      case "expired":
        this.finish("The room expired.", "expired");
        break;
      case "error":
        if (m.reason === "room-taken" && this.draw && this.draws < MAX_ROOM_DRAWS && !this._joined) {
          // Another room, on a new connection (the rendezvous closed this one).
          this.draws++;
          const next = this.draw();
          this._room = next.room;
          this._token = next.token;
          this.connection?.close();
          this.open();
        } else {
          this.finish(m.message, m.reason);
        }
        break;
      default:
        if (this._state === "open") this.inbox.push(m);
    }
  }

  private finish(reason: string, error: RendezvousErrorReason | "expired" | "peer-left" | null): void {
    if (this._state === "closed") return;
    this._state = "closed";
    this._reason = reason;
    this._error = error;
    this.connection?.close();
    if (this.ownsTransport) this.transport.close();
  }
}
