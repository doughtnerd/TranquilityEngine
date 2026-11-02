import { afterEach, describe, expect, it } from "vitest";
import { createTransport, type TransportConnection, type TransportEvent } from "../net/Transport";
import { LoopbackConnection, LoopbackTransport, type LoopbackOptions } from "../net/transport/loopback";

// ADR 0033, T7: the loopback transport, on a fake clock so delivery is deterministic.

let clock = 0;
const now = () => clock;
const open: LoopbackTransport[] = [];
let addressCounter = 0;

/** A transport on the fake clock, closed after each test so addresses don't leak between tests. */
function transport(options: LoopbackOptions = {}): LoopbackTransport {
  const t = new LoopbackTransport({ now, ...options });
  open.push(t);
  return t;
}

/** A random source that plays back `values` in a loop. */
function sequence(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

const bytes = (...values: number[]) => new Uint8Array(values);

/** Events as compact strings: "open", "data:reliable:1,2", "close:<reason>". */
function describeEvents(events: TransportEvent[]): string[] {
  return events.map(e => (e.kind === "data" ? `data:${e.channel}:${[...e.data].join(",")}` : e.kind === "close" ? `close:${e.reason}` : e.kind));
}

/** A listening server and a client connected to it (not yet open). */
async function link(server: LoopbackOptions = {}, client: LoopbackOptions = {}) {
  const address = `test-${addressCounter++}`;
  const s = transport(server);
  const c = transport(client);
  await s.listen(address);
  const connection = c.connect(address);
  return { address, s, c, connection };
}

/** Open both ends (advancing the clock far enough) and return the server's connection. */
function openBoth(s: LoopbackTransport, c: LoopbackTransport): TransportConnection {
  clock += 10_000;
  const serverEvents = s.poll();
  expect(serverEvents.map(e => e.kind)).toEqual(["open"]);
  expect(c.poll().map(e => e.kind)).toEqual(["open"]);
  return serverEvents[0].connection;
}

afterEach(() => {
  for (const t of open.splice(0)) t.close();
  clock = 0;
});

describe("loopback transport (T7)", () => {
  it("opens both ends after the latency, delivers data, then closes both with a reason", async () => {
    const { s, c, connection } = await link({ latencyMs: 50 }, { latencyMs: 50 });
    expect(connection.state).toBe("connecting");
    expect(s.poll()).toEqual([]);
    expect(c.poll()).toEqual([]);

    // The server hears the connect after one way; the client hears it accepted after a round trip.
    clock = 50;
    const [serverOpen] = s.poll();
    expect(serverOpen.kind).toBe("open");
    const remote = serverOpen.connection;
    expect(remote.state).toBe("open");
    expect(c.poll()).toEqual([]);
    expect(connection.state).toBe("connecting");
    clock = 100;
    expect(describeEvents(c.poll())).toEqual(["open"]);
    expect(connection.state).toBe("open");

    connection.send("reliable", bytes(1));
    remote.send("reliable", bytes(2));
    clock = 150;
    expect(describeEvents(s.poll())).toEqual(["data:reliable:1"]);
    expect(describeEvents(c.poll())).toEqual(["data:reliable:2"]);

    connection.send("reliable", bytes(3));
    connection.close("bye");
    expect(connection.state).toBe("closed");
    expect(() => connection.send("reliable", bytes(4))).toThrow(/closed/);
    expect(describeEvents(c.poll())).toEqual(["close:bye"]);
    expect(remote.state).toBe("open");
    remote.send("reliable", bytes(5)); // The server hasn't heard yet: dropped, not thrown.
    clock = 200;
    // The data sent before the close arrives before it.
    expect(describeEvents(s.poll())).toEqual(["data:reliable:3", "close:Closed by the remote end: bye"]);
    expect(remote.state).toBe("closed");
    clock = 1000;
    expect(c.poll()).toEqual([]);
    expect(s.poll()).toEqual([]);
  });

  it("lets data sent while connecting wait for the open", async () => {
    const { s, connection } = await link({}, { latencyMs: 20 });
    connection.send("reliable", bytes(1));
    connection.send("unreliable", bytes(2));
    clock = 20;
    expect(describeEvents(s.poll())).toEqual(["open", "data:reliable:1", "data:unreliable:2"]);
  });

  it("never delivers early", async () => {
    const { s, c, connection } = await link({ latencyMs: 30 }, { latencyMs: 30, jitterMs: 10, random: () => 0.5 });
    openBoth(s, c);
    const sentAt = clock;
    connection.send("reliable", bytes(1));
    connection.send("unreliable", bytes(2));
    clock = sentAt + 34.999;
    expect(s.poll()).toEqual([]);
    clock = sentAt + 35;
    expect(describeEvents(s.poll())).toEqual(["data:reliable:1", "data:unreliable:2"]);
  });

  it("keeps reliable messages in order under jitter, and delays lost ones instead of dropping them", async () => {
    // Each send draws jitter, then loss until a transmission gets through: message 0 gets the most
    // jitter and is lost twice; the rest get half the jitter and aren't lost.
    const random = sequence(0.99, 0.0, 0.0, 0.99, ...Array<number>(10).fill(0.5));
    const { s, c, connection } = await link({}, { latencyMs: 40, jitterMs: 20, loss: 0.25, random });
    openBoth(s, c);

    const sentAt = clock;
    for (let i = 0; i < 6; i++) connection.send("reliable", bytes(i));
    const received: number[] = [];
    let firstAt = -1;
    for (let t = sentAt; t <= sentAt + 1000; t += 1) {
      clock = t;
      for (const e of s.poll()) {
        if (e.kind !== "data") continue;
        if (firstAt < 0) firstAt = t - sentAt;
        received.push(e.data[0]);
      }
    }
    expect(received).toEqual([0, 1, 2, 3, 4, 5]);
    // Message 0: 40 latency + 19.8 jitter + a round trip for each lost transmission; the rest
    // (due at 50) waited behind it.
    expect(firstAt).toBe(Math.ceil(40 + 19.8 + 2 * 80));
  });

  it("never drops reliable messages, even at total loss", async () => {
    const { s, c, connection } = await link({}, { latencyMs: 5, loss: 1 });
    openBoth(s, c);
    for (let i = 0; i < 20; i++) connection.send("reliable", bytes(i));
    clock += 100_000;
    expect(s.poll().map(e => (e.kind === "data" ? e.data[0] : -1))).toEqual([...Array(20).keys()]);
  });

  it("drops unreliable messages under loss", async () => {
    // Each send draws jitter, then loss: lose every other message.
    const random = sequence(0, 0.9, 0, 0.1);
    const { s, c, connection } = await link({}, { latencyMs: 10, loss: 0.5, random });
    openBoth(s, c);
    for (let i = 0; i < 10; i++) connection.send("unreliable", bytes(i));
    clock += 1000;
    expect(s.poll().map(e => (e.kind === "data" ? e.data[0] : -1))).toEqual([0, 2, 4, 6, 8]);
  });

  it("keeps unreliable messages latest-wins under jitter: stale ones are dropped on receipt", async () => {
    // Jitter per send: 0 gets 30 extra, 1 gets 0, 2 gets 20, 3 gets 0.
    const random = sequence(1, 0, 0, 0, 0.666667, 0, 0, 0);
    const { s, c, connection } = await link({}, { latencyMs: 10, jitterMs: 30, random });
    openBoth(s, c);
    const sentAt = clock;
    for (let i = 0; i < 4; i++) connection.send("unreliable", bytes(i));
    clock = sentAt + 10;
    expect(describeEvents(s.poll())).toEqual(["data:unreliable:1", "data:unreliable:3"]);
    clock = sentAt + 100;
    expect(s.poll()).toEqual([]); // 0 and 2 arrived after 3: stale.
  });

  it("applies conditions changed later, per transport or per connection", async () => {
    const { s, c, connection } = await link();
    const remote = openBoth(s, c);
    c.setConditions({ latencyMs: 100 });
    expect(c.conditions.latencyMs).toBe(100);
    let sentAt = clock;
    connection.send("reliable", bytes(1));
    clock = sentAt + 99;
    expect(s.poll()).toEqual([]);
    clock = sentAt + 100;
    expect(s.poll()).toHaveLength(1);

    (remote as LoopbackConnection).setConditions({ latencyMs: 7 });
    sentAt = clock;
    remote.send("reliable", bytes(2));
    clock = sentAt + 7;
    expect(describeEvents(c.poll())).toEqual(["data:reliable:2"]);
  });

  it("closes with a clear reason when nothing listens at the address", () => {
    const c = transport();
    const connection = c.connect("nowhere");
    connection.send("reliable", bytes(1)); // Not yet reported closed; dropped.
    expect(describeEvents(c.poll())).toEqual(['close:Nothing is listening at loopback address "nowhere".']);
    expect(connection.state).toBe("closed");
  });

  it("refuses a taken address, and frees it when the transport closes", async () => {
    const { address, s, c, connection } = await link({ latencyMs: 10 }, { latencyMs: 10 });
    const remote = openBoth(s, c);
    await expect(transport().listen(address)).rejects.toThrow(/already taken/);

    s.close();
    expect(remote.state).toBe("closed");
    expect(describeEvents(s.poll())).toEqual(["close:The transport was closed."]);
    clock += 10;
    expect(describeEvents(c.poll())).toEqual(["close:Closed by the remote end: The transport was closed."]);
    expect(connection.state).toBe("closed");

    const again = transport();
    await again.listen(address);
    c.connect(address);
    clock += 10;
    expect(again.poll().map(e => e.kind)).toEqual(["open"]);
  });

  it("closes a connection given up while connecting: the client at once, the server after the open", async () => {
    const { s, c, connection } = await link({ latencyMs: 50 }, { latencyMs: 50 });
    connection.close("changed my mind");
    expect(describeEvents(c.poll())).toEqual(["close:changed my mind"]);
    clock += 1000;
    expect(describeEvents(s.poll())).toEqual(["open", "close:Closed by the remote end: changed my mind"]);
    expect(c.poll()).toEqual([]);
  });

  it("doesn't tell a server about a connection its own close beat the open of", async () => {
    const { s, c, connection } = await link({ latencyMs: 50 }, { latencyMs: 50 });
    s.close();
    expect(s.poll()).toEqual([]);
    clock += 1000;
    expect(s.poll()).toEqual([]);
    // The client had been accepted, so it hears the open, then the close.
    expect(describeEvents(c.poll())).toEqual(["open", "close:Closed by the remote end: The transport was closed."]);
    expect(connection.state).toBe("closed");
  });

  it("copies messages on send", async () => {
    const { s, c, connection } = await link();
    openBoth(s, c);
    const buffer = bytes(1, 2, 3);
    connection.send("reliable", buffer);
    buffer[0] = 99;
    const [event] = s.poll();
    expect(event.kind === "data" && [...event.data]).toEqual([1, 2, 3]);
  });

  it("is created by name", async () => {
    const t = createTransport("loopback", { now, latencyMs: 5 });
    open.push(t as LoopbackTransport);
    expect(t).toBeInstanceOf(LoopbackTransport);
    expect((t as LoopbackTransport).conditions).toEqual({ latencyMs: 5 });
  });
});
