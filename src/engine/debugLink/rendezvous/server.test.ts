// The rendezvous server and client over loopback with an injected clock (plan task R1).
import { afterEach, describe, expect, it } from "vitest";
import { createTransport, type Transport } from "../../net/Transport";
import "../../net/transport/loopback";
import type { WebRtcSignal } from "../../net/transport/webrtc";
import { RendezvousClient } from "./client";
import {
  RENDEZVOUS_MAX_ROOMS,
  ROOM_EXPIRY_MS,
  ROOM_MAX_BYTES,
  decodeServerMessage,
  encodeRendezvousMessage,
  type RendezvousClientMessage,
  type RendezvousServerMessage,
} from "./protocol";
import { JOIN_LOCK_MS, MAX_JOIN_FAILURES, RENDEZVOUS_JOIN_TIMEOUT_MS, RendezvousServer } from "./server";

let clock = 0;
let addressCounter = 0;
const cleanup: { close(): void }[] = [];

afterEach(() => {
  for (const c of cleanup.splice(0)) c.close();
});

async function start(): Promise<{ server: RendezvousServer; address: string }> {
  clock = 0;
  const address = `rendezvous-test-${addressCounter++}`;
  const server = new RendezvousServer({ transport: createTransport("loopback"), now: () => clock });
  cleanup.push(server);
  await server.listen(address);
  return { server, address };
}

type Poller = { step?(): void; poll?(): unknown };

/** Poll the server and every client enough times for messages to cross a few hops. */
function pump(server: RendezvousServer, ...clients: Poller[]): void {
  for (let i = 0; i < 8; i++) {
    server.poll();
    for (const c of clients) c.step?.();
  }
}

function waiter(address: string, room = 5, token = 100, kind: "native" | "page-http" = "native"): RendezvousClient {
  const c = RendezvousClient.openRoom({ transport: createTransport("loopback"), url: address, kind, draw: () => ({ room, token }) });
  cleanup.push(c);
  return c;
}

function joiner(address: string, room = 5, token = 100): RendezvousClient {
  const c = RendezvousClient.joinRoom({ transport: createTransport("loopback"), url: address, kind: "page-http", room, token });
  cleanup.push(c);
  return c;
}

/** A bare connection speaking the wire protocol, for what a client never sends. */
function raw(address: string) {
  const transport: Transport = createTransport("loopback");
  cleanup.push(transport);
  const connection = transport.connect(address);
  const received: RendezvousServerMessage[] = [];
  let closed = false;
  return {
    send(m: RendezvousClientMessage | Uint8Array) {
      connection.send("reliable", m instanceof Uint8Array ? m : encodeRendezvousMessage(m));
    },
    step() {
      for (const e of transport.poll()) {
        if (e.kind === "close") closed = true;
        else if (e.kind === "data") {
          const d = decodeServerMessage(e.data);
          if ("message" in d) received.push(d.message);
        }
      }
    },
    received,
    get closed() {
      return closed;
    },
  };
}

const join = (seat: "waiting" | "joining", room = 5, token = 100): RendezvousClientMessage => ({ t: "join", v: 1, room, token, seat, kind: "native" });
const candidate = (n: number, size = 10): WebRtcSignal => ({ t: "candidate", candidate: `c${n}`.padEnd(size, "x"), mid: "0" });

describe("the rendezvous", () => {
  it("relays a full signalling exchange between two clients, unread", async () => {
    const { server, address } = await start();
    const a = waiter(address, 5, 100, "native");
    const b = joiner(address, 5, 100);
    pump(server, a, b);
    expect(a.joined && b.joined).toBe(true);
    expect([a.state, b.state]).toEqual(["open", "open"]);
    expect([a.peerKind, b.peerKind]).toEqual(["page-http", "native"]);
    expect([a.room, a.token]).toEqual([5, 100]);
    expect(a.expiresIn).toBe(ROOM_EXPIRY_MS);

    const sdp = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n";
    b.send({ t: "offer", sdp });
    b.send(candidate(1));
    pump(server, a, b);
    expect(a.poll()).toEqual([{ t: "offer", sdp }, candidate(1)]);
    a.send({ t: "answer", sdp: "answer-sdp" });
    a.send(candidate(2));
    a.send({ t: "candidate", candidate: "", mid: null });
    pump(server, a, b);
    expect(b.poll()).toEqual([{ t: "answer", sdp: "answer-sdp" }, candidate(2), { t: "candidate", candidate: "", mid: null }]);
    expect(a.poll()).toEqual([]);
    expect(server.roomCount).toBe(1);
  });

  it("forgets the room once both sides report connected, and not before", async () => {
    const { server, address } = await start();
    const a = waiter(address);
    const b = joiner(address);
    pump(server, a, b);
    a.connected();
    pump(server, a, b);
    expect(server.roomCount).toBe(1);
    expect(b.state).toBe("open"); // the one still finishing isn't told the other left
    b.send(candidate(3));
    b.connected();
    pump(server, a, b);
    expect(server.roomCount).toBe(0);
    expect([a.state, b.state]).toEqual(["closed", "closed"]);
    const late = joiner(address);
    pump(server, late);
    expect(late.error).toBe("no-room");
  });

  it("forgets the room after five minutes and tells both sides", async () => {
    const { server, address } = await start();
    const a = waiter(address);
    const b = joiner(address);
    pump(server, a, b);
    clock = ROOM_EXPIRY_MS - 1;
    pump(server, a, b);
    expect(server.roomCount).toBe(1);
    clock = ROOM_EXPIRY_MS;
    pump(server, a, b);
    expect(server.roomCount).toBe(0);
    expect([a.state, b.state]).toEqual(["closed", "closed"]);
    expect([a.error, b.error]).toEqual(["expired", "expired"]);
    const late = joiner(address);
    pump(server, late);
    expect(late.error).toBe("no-room");
  });

  it("expires a room nobody joined", async () => {
    const { server, address } = await start();
    const a = waiter(address);
    pump(server, a);
    expect(a.state).toBe("connecting");
    clock = ROOM_EXPIRY_MS + 1;
    pump(server, a);
    expect(a.error).toBe("expired");
    expect(server.roomCount).toBe(0);
  });

  it("holds 64 rooms and answers full to the 65th, until one is forgotten", async () => {
    const { server, address } = await start();
    const waiting: RendezvousClient[] = [];
    for (let i = 0; i < RENDEZVOUS_MAX_ROOMS; i++) waiting.push(waiter(address, i, 1000 + i));
    pump(server, ...waiting);
    expect(server.roomCount).toBe(RENDEZVOUS_MAX_ROOMS);
    expect(waiting.every((w) => w.joined)).toBe(true);
    const extra = waiter(address, 100, 5);
    pump(server, extra);
    expect(extra.error).toBe("full");
    expect(extra.closedReason).toContain("64");
    waiting[0].close();
    pump(server, ...waiting);
    const again = waiter(address, 100, 5);
    pump(server, again);
    expect(again.joined).toBe(true);
  });

  it("ends a room that relays more than 16 KiB of signalling, answering too-big", async () => {
    const { server, address } = await start();
    const a = waiter(address);
    const b = joiner(address);
    pump(server, a, b);
    let sent = 0;
    for (let n = 0; sent < ROOM_MAX_BYTES - 3000; n++) {
      const s = candidate(n, 3000);
      b.send(s);
      sent += new TextEncoder().encode(JSON.stringify(s)).byteLength;
      pump(server, a, b);
    }
    expect(a.poll().length).toBeGreaterThan(0);
    expect(server.roomCount).toBe(1);
    b.send(candidate(99, 3000));
    pump(server, a, b);
    expect([a.error, b.error]).toEqual(["too-big", "too-big"]);
    expect(server.roomCount).toBe(0);
  });

  it("refuses a message past the size limit with too-big", async () => {
    const { server, address } = await start();
    const r = raw(address);
    r.send(join("waiting"));
    for (let i = 0; i < 4; i++) {
      server.poll();
      r.step();
    }
    r.send(new Uint8Array(20_000).fill(32));
    for (let i = 0; i < 4; i++) {
      server.poll();
      r.step();
    }
    expect(r.received.at(-1)).toMatchObject({ t: "error", reason: "too-big" });
    expect(r.closed).toBe(true);
    expect(server.roomCount).toBe(0);
  });

  it("locks a room's joins for a minute after five wrong tokens, even for the right one", async () => {
    const { server, address } = await start();
    const a = waiter(address, 5, 100);
    pump(server, a);
    for (let i = 0; i < MAX_JOIN_FAILURES; i++) {
      const bad = joiner(address, 5, 200 + i);
      pump(server, a, bad);
      expect(bad.error).toBe("bad-token");
      clock += 1000;
    }
    const right = joiner(address, 5, 100);
    pump(server, a, right);
    expect(right.error).toBe("locked");
    expect(a.state).toBe("connecting"); // the waiting side is undisturbed
    clock += JOIN_LOCK_MS;
    const later = joiner(address, 5, 100);
    pump(server, a, later);
    expect(later.state).toBe("open");
    expect(a.state).toBe("open");
  });

  it("doesn't lock for wrong tokens spread over more than a minute, and a lock ends with a fresh count", async () => {
    const { server, address } = await start();
    const a = waiter(address, 5, 100);
    pump(server, a);
    for (let i = 0; i < 10; i++) {
      const bad = joiner(address, 5, 300 + i);
      pump(server, a, bad);
      expect(bad.error).toBe("bad-token");
      clock += 20_000;
    }
    const right = joiner(address, 5, 100);
    pump(server, a, right);
    expect(right.state).toBe("open");
  });

  it("answers no-room, seat-taken, room-taken and version with clear messages", async () => {
    const { server, address } = await start();
    const a = waiter(address, 5, 100);
    const b = joiner(address, 5, 100);
    pump(server, a, b);
    const none = joiner(address, 6, 100);
    const third = joiner(address, 5, 100);
    const same = raw(address);
    same.send(join("waiting", 5, 1));
    const old = raw(address);
    old.send({ t: "join", v: 9, room: 8, token: 1, seat: "waiting", kind: "native" });
    for (let i = 0; i < 6; i++) {
      server.poll();
      same.step();
      old.step();
      none.step();
      third.step();
    }
    expect(none.error).toBe("no-room");
    expect(none.closedReason).toContain("6");
    expect(third.error).toBe("seat-taken");
    expect(same.received[0]).toMatchObject({ t: "error", reason: "room-taken" });
    expect(old.received[0]).toMatchObject({ t: "error", reason: "version" });
    expect(b.state).toBe("open");
  });

  it("draws another room when the one asked for is taken", async () => {
    const { server, address } = await start();
    const a = waiter(address, 5, 100);
    pump(server, a);
    const draws = [
      { room: 5, token: 1 },
      { room: 6, token: 2 },
    ];
    const b = RendezvousClient.openRoom({ transport: createTransport("loopback"), url: address, kind: "native", draw: () => draws.shift()! });
    cleanup.push(b);
    pump(server, a, b);
    expect(b.joined).toBe(true);
    expect([b.room, b.token]).toEqual([6, 2]);
    expect(server.roomCount).toBe(2);
  });

  it("refuses a signal before the other side sits, a second join, and a first message that isn't a join", async () => {
    const { server, address } = await start();
    const early = raw(address);
    early.send(join("waiting", 1, 1));
    for (let i = 0; i < 4; i++) {
      server.poll();
      early.step();
    }
    early.send({ t: "offer", sdp: "x" });
    const second = raw(address);
    second.send({ t: "connected" });
    const twice = raw(address);
    twice.send(join("waiting", 2, 2));
    for (let i = 0; i < 4; i++) {
      server.poll();
      twice.step();
    }
    twice.send(join("waiting", 3, 3));
    for (let i = 0; i < 6; i++) {
      server.poll();
      early.step();
      second.step();
      twice.step();
    }
    expect(early.received.at(-1)).toMatchObject({ t: "error", reason: "bad-message" });
    expect(second.received[0]).toMatchObject({ t: "error", reason: "bad-message" });
    expect(twice.received.at(-1)).toMatchObject({ t: "error", reason: "bad-message" });
    expect([early.closed, second.closed, twice.closed]).toEqual([true, true, true]);
    expect(server.roomCount).toBe(0);
  });

  it("never relays anything but signals: a debug-looking message is refused, not forwarded", async () => {
    const { server, address } = await start();
    const a = waiter(address);
    const b = raw(address);
    b.send({ t: "join", v: 1, room: 5, token: 100, seat: "joining", kind: "native" });
    for (let i = 0; i < 6; i++) {
      server.poll();
      a.step();
      b.step();
    }
    b.send(new TextEncoder().encode('{"t":"hello","payload":"take"}'));
    for (let i = 0; i < 6; i++) {
      server.poll();
      a.step();
      b.step();
    }
    expect(a.poll()).toEqual([]);
    expect(b.received.at(-1)).toMatchObject({ t: "error", reason: "bad-message" });
  });

  it("tells the other side when one leaves before connecting, and frees the room", async () => {
    const { server, address } = await start();
    const a = waiter(address);
    const b = joiner(address);
    pump(server, a, b);
    a.close();
    pump(server, a, b);
    expect(b.error).toBe("peer-left");
    expect(server.roomCount).toBe(0);
  });

  it("closes a connection that never sends its join", async () => {
    const { server, address } = await start();
    const silent = raw(address);
    pump(server, { step: () => silent.step() });
    expect(silent.closed).toBe(false);
    clock = RENDEZVOUS_JOIN_TIMEOUT_MS;
    pump(server, { step: () => silent.step() });
    expect(silent.closed).toBe(true);
  });
});
