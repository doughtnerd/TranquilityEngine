// The rendezvous server (ADR 0403 "Rendezvous", 0404; plan task R1): rooms over any listening `Transport`. See
// `protocol.ts` for the messages and the limits. It relays offer, answer and candidates between a room's two seats
// without reading them, and never carries debug traffic: a connection that isn't in a seated room has nothing to relay
// to, and a message that isn't a signal is never forwarded.
//
// Polled, as transports are (ADR 0033): the caller calls `poll()` once per frame or tick; the server has no timers.
// Time comes only from the injected clock, so tests step it.
import type { Transport, TransportConnection } from "../../net/Transport";
import type { EndpointKind } from "../protocol";
import {
  RENDEZVOUS_MAX_ROOMS,
  RENDEZVOUS_VERSION,
  ROOM_EXPIRY_MS,
  ROOM_MAX_BYTES,
  decodeClientMessage,
  encodeRendezvousMessage,
  type RendezvousErrorReason,
  type RendezvousServerMessage,
  type RoomSeat,
} from "./protocol";

/** Wrong tokens, within `JOIN_FAILURE_WINDOW_MS`, that lock a room's joins (0403: "Five wrong tokens"). */
export const MAX_JOIN_FAILURES = 5;
/** The window the wrong tokens are counted in, ms ("a minute"). */
export const JOIN_FAILURE_WINDOW_MS = 60_000;
/** How long a lock lasts, ms ("for a minute"). */
export const JOIN_LOCK_MS = 60_000;
/** A connection that hasn't sent its `join` by then is closed, ms (so silent connections don't pile up). */
export const RENDEZVOUS_JOIN_TIMEOUT_MS = 10_000;

export interface RendezvousServerOptions {
  /** The listening transport (a WebSocket transport in a build, loopback in tests). The server owns it: `close()` closes it. */
  readonly transport: Transport;
  /** The clock, ms (`performance.now()` in a build; a stepped value in tests). */
  now(): number;
}

interface Seat {
  readonly connection: TransportConnection;
  readonly kind: EndpointKind;
  connected: boolean;
}

interface Room {
  readonly number: number;
  readonly token: number;
  readonly createdAt: number;
  readonly seats: { waiting: Seat | null; joining: Seat | null };
  /** Signalling bytes relayed so far, both ways. */
  bytes: number;
  /** Both seats have been taken. */
  paired: boolean;
  /** When each recent wrong token came, ms. */
  failures: number[];
  lockedUntil: number;
}

interface Session {
  readonly connection: TransportConnection;
  readonly since: number;
  room: Room | null;
  seat: RoomSeat | null;
}

export class RendezvousServer {
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly rooms = new Map<number, Room>();
  private readonly sessions = new Map<TransportConnection, Session>();
  private closed = false;

  constructor(options: RendezvousServerOptions) {
    this.transport = options.transport;
    this.now = options.now;
  }

  /** Start accepting connections at `address` (the transport's: a path such as `RENDEZVOUS_PATH` on a socket transport). */
  listen(address: string): Promise<void> {
    return this.transport.listen(address);
  }

  /** How many rooms exist now. */
  get roomCount(): number {
    return this.rooms.size;
  }

  /** Read the transport, apply what arrived, and forget what expired. Call once per tick. */
  poll(): void {
    if (this.closed) return;
    for (const event of this.transport.poll()) {
      if (event.kind === "open") {
        this.sessions.set(event.connection, { connection: event.connection, since: this.now(), room: null, seat: null });
      } else if (event.kind === "close") {
        const session = this.sessions.get(event.connection);
        if (session) this.leave(session, true);
      } else if (event.channel === "reliable") {
        const session = this.sessions.get(event.connection);
        if (session) this.receive(session, event.data);
      }
    }
    const now = this.now();
    for (const room of [...this.rooms.values()]) {
      if (now - room.createdAt >= ROOM_EXPIRY_MS) this.endRoom(room, { t: "expired" });
    }
    for (const session of [...this.sessions.values()]) {
      if (!session.room && now - session.since >= RENDEZVOUS_JOIN_TIMEOUT_MS) this.refuse(session, "bad-message", "No join arrived in time.");
    }
  }

  /** Close every connection, forget every room and stop listening. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rooms.clear();
    this.sessions.clear();
    this.transport.close();
  }

  private receive(session: Session, data: Uint8Array): void {
    const decoded = decodeClientMessage(data);
    if ("refused" in decoded) return this.refuse(session, decoded.reason, decoded.refused);
    const m = decoded.message;
    if (m.t === "join") return this.join(session, m);
    const room = session.room;
    if (!room || !session.seat) return this.refuse(session, "bad-message", "The first message must be a join.");
    const seat = room.seats[session.seat];
    if (!seat) return;
    switch (m.t) {
      case "leave":
        return this.leave(session, false);
      case "connected":
        seat.connected = true;
        if (room.seats.waiting?.connected && room.seats.joining?.connected) this.endRoom(room, { t: "expired" });
        return;
      default: {
        const other = room.seats[session.seat === "waiting" ? "joining" : "waiting"];
        if (!other) {
          if (room.paired) return; // the other side connected and went: nothing to relay to
          return this.refuse(session, "bad-message", "The other side hasn't joined yet.");
        }
        room.bytes += data.byteLength;
        if (room.bytes > ROOM_MAX_BYTES) {
          this.endRoom(room, { t: "error", reason: "too-big", message: `A room relays at most ${ROOM_MAX_BYTES} bytes of signalling; this one is over.` });
          return;
        }
        // Relayed as the sender sent it (only its known fields, which decoding kept): never interpreted.
        this.send(other.connection, m);
      }
    }
  }

  private join(session: Session, m: { v: number; room: number; token: number; seat: RoomSeat; kind: EndpointKind }): void {
    if (session.room) return this.refuse(session, "bad-message", "This connection already joined a room.");
    if (m.v !== RENDEZVOUS_VERSION) return this.refuse(session, "version", `This rendezvous speaks version ${RENDEZVOUS_VERSION}, not ${m.v}.`);
    const now = this.now();
    let room = this.rooms.get(m.room);
    if (m.seat === "waiting") {
      if (room) return this.refuse(session, "room-taken", `Room ${m.room} already exists.`);
      if (this.rooms.size >= RENDEZVOUS_MAX_ROOMS) return this.refuse(session, "full", `This rendezvous holds ${RENDEZVOUS_MAX_ROOMS} rooms and they're all in use. Try again in a few minutes.`);
      room = { number: m.room, token: m.token, createdAt: now, seats: { waiting: null, joining: null }, bytes: 0, paired: false, failures: [], lockedUntil: 0 };
      this.rooms.set(room.number, room);
    } else {
      if (!room) return this.refuse(session, "no-room", `There is no room ${m.room}: it was never opened, or it expired or was used.`);
      if (now < room.lockedUntil) return this.refuse(session, "locked", "Too many wrong codes for this room; wait a minute and try again.");
      if (m.token !== room.token) {
        room.failures = room.failures.filter((t) => now - t < JOIN_FAILURE_WINDOW_MS);
        room.failures.push(now);
        if (room.failures.length >= MAX_JOIN_FAILURES) {
          room.failures = [];
          room.lockedUntil = now + JOIN_LOCK_MS;
        }
        return this.refuse(session, "bad-token", "That code's token isn't this room's. Check the code on the other screen.");
      }
      if (room.seats.joining) return this.refuse(session, "seat-taken", "Someone already joined this room.");
    }
    const seat: Seat = { connection: session.connection, kind: m.kind, connected: false };
    room.seats[m.seat] = seat;
    session.room = room;
    session.seat = m.seat;
    this.send(session.connection, { t: "joined", room: room.number, seat: m.seat, expiresIn: Math.max(0, room.createdAt + ROOM_EXPIRY_MS - now) });
    const { waiting, joining } = room.seats;
    if (waiting && joining) {
      room.paired = true;
      this.send(waiting.connection, { t: "peer-joined", kind: joining.kind });
      this.send(joining.connection, { t: "peer-joined", kind: waiting.kind });
    }
  }

  /** `session` leaves its room (it sent `leave`, or its connection closed). */
  private leave(session: Session, connectionClosed: boolean): void {
    const room = session.room;
    const seatName = session.seat;
    if (connectionClosed) this.sessions.delete(session.connection);
    if (!room || !seatName) {
      if (!connectionClosed) this.close1(session.connection);
      return;
    }
    const seat = room.seats[seatName];
    session.room = null;
    session.seat = null;
    room.seats[seatName] = null;
    const other = room.seats[seatName === "waiting" ? "joining" : "waiting"];
    if (!other) {
      this.rooms.delete(room.number);
    } else if (!seat?.connected) {
      // A side that leaves before connecting ends the room (the waiting side's code is spent; a joiner starts over).
      this.rooms.delete(room.number);
      this.send(other.connection, { t: "peer-left" });
      this.endSeat(other);
    }
    // A side that already connected leaves quietly: the other is finishing its connection, and the room stays
    // until it reports connected, leaves or expires.
    if (!connectionClosed) this.close1(session.connection);
  }

  /** Tell every seat of `room` `last`, close them and forget the room. */
  private endRoom(room: Room, last: RendezvousServerMessage): void {
    this.rooms.delete(room.number);
    for (const seat of [room.seats.waiting, room.seats.joining]) {
      if (!seat) continue;
      this.send(seat.connection, last);
      this.endSeat(seat);
    }
    room.seats.waiting = null;
    room.seats.joining = null;
  }

  private endSeat(seat: Seat): void {
    const session = this.sessions.get(seat.connection);
    if (session) {
      session.room = null;
      session.seat = null;
      this.sessions.delete(seat.connection);
    }
    this.close1(seat.connection);
  }

  private refuse(session: Session, reason: RendezvousErrorReason, message: string): void {
    this.send(session.connection, { t: "error", reason, message });
    if (session.room) this.leave(session, false);
    else {
      this.sessions.delete(session.connection);
      this.close1(session.connection);
    }
  }

  private send(connection: TransportConnection, m: RendezvousServerMessage): void {
    if (connection.state === "closed") return;
    connection.send("reliable", encodeRendezvousMessage(m));
  }

  private close1(connection: TransportConnection): void {
    if (connection.state !== "closed") connection.close();
  }
}
