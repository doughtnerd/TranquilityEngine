import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { createTransport, type Transport, type TransportConnection, type TransportEvent } from "../net/Transport";
import { DEFAULT_WEBSOCKET_LIMITS, WebSocketConnection, decodeFrame, encodeFrame, WebSocketTransport } from "../net/transport/websocket";
import { NodeWebSocketTransport, parseListenAddress } from "../../server/websocketServer";

// ADR 0033, T9: the WebSocket transport over real sockets on port 0. The client is the
// browser-safe transport on Node's global WebSocket; the server is the Node side (ADR 0035).

const open: Transport[] = [];
afterEach(() => {
  for (const transport of open.splice(0)) transport.close();
});

function server(): NodeWebSocketTransport {
  const transport = new NodeWebSocketTransport();
  open.push(transport);
  return transport;
}

function client(): WebSocketTransport {
  const transport = new WebSocketTransport();
  open.push(transport);
  return transport;
}

async function listening(path = ""): Promise<{ server: NodeWebSocketTransport; url: string }> {
  const s = server();
  await s.listen(`ws://127.0.0.1:0${path}`);
  return { server: s, url: s.address!.url };
}

/** Poll each transport until `done` holds for the events collected so far (one list per transport). */
async function pollUntil(transports: Transport[], done: (events: TransportEvent[][]) => boolean, timeoutMs = 3000): Promise<TransportEvent[][]> {
  const events: TransportEvent[][] = transports.map(() => []);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    transports.forEach((t, i) => events[i].push(...t.poll()));
    if (done(events)) return events;
    if (Date.now() > deadline) throw new Error(`Timed out; got ${JSON.stringify(events.map((list) => list.map((e) => e.kind)))}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const has = (kind: TransportEvent["kind"], count = 1) => (list: TransportEvent[]) => list.filter((e) => e.kind === kind).length >= count;
const dataOf = (list: TransportEvent[]) => list.flatMap((e) => (e.kind === "data" ? [{ channel: e.channel, bytes: [...e.data] }] : []));

/** A connected pair: the client's connection and the server's. */
async function connected(): Promise<{ s: NodeWebSocketTransport; c: WebSocketTransport; toServer: TransportConnection; toClient: TransportConnection }> {
  const { server: s, url } = await listening();
  const c = client();
  const toServer = c.connect(url);
  expect(toServer.state).toBe("connecting");
  const [serverEvents] = await pollUntil([s, c], ([se, ce]) => has("open")(se) && has("open")(ce));
  const accepted = serverEvents.find((e) => e.kind === "open")!.connection;
  return { s, c, toServer, toClient: accepted };
}

describe("WebSocket framing (T9)", () => {
  it("prefixes a 1-byte channel header and rejects reserved flags", () => {
    expect([...encodeFrame("reliable", new Uint8Array([7, 8]))]).toEqual([0, 7, 8]);
    expect([...encodeFrame("unreliable", new Uint8Array([7]))]).toEqual([1, 7]);
    const decoded = decodeFrame(new Uint8Array([1, 9]));
    expect(typeof decoded !== "string" && decoded.channel).toBe("unreliable");
    expect(decodeFrame(new Uint8Array([0x02, 9]))).toMatch(/unknown frame flags/);
    expect(decodeFrame(new Uint8Array([]))).toMatch(/empty/);
  });

  it("parses listen addresses", () => {
    expect(parseListenAddress(7777)).toEqual({ port: 7777, path: "/" });
    expect(parseListenAddress(":0")).toEqual({ port: 0, path: "/" });
    expect(parseListenAddress("ws://0.0.0.0:7777/game")).toEqual({ host: "0.0.0.0", port: 7777, path: "/game" });
    expect(parseListenAddress("localhost:9000")).toEqual({ host: "localhost", port: 9000, path: "/" });
    expect(() => parseListenAddress("wss://example.com:1")).toThrow(/only ws:\/\//);
  });
});

describe("WebSocket transport (T9)", () => {
  it("connects a headless client to a headless server over a real socket in Node", async () => {
    const { s, toServer, toClient } = await connected();
    expect(toServer.state).toBe("open");
    expect(toClient.state).toBe("open");
    expect(toClient.remote).toMatch(/127\.0\.0\.1:\d+$/);
    expect(s.address!.port).toBeGreaterThan(0);
  });

  it("carries data both ways on both channels, in order", async () => {
    const { s, c, toServer, toClient } = await connected();
    toServer.send("reliable", new Uint8Array([1]));
    toServer.send("unreliable", new Uint8Array([2, 2]));
    toServer.send("reliable", new Uint8Array([3]));
    toClient.send("unreliable", new Uint8Array([4]));
    toClient.send("reliable", new Uint8Array([]));
    const [se, ce] = await pollUntil([s, c], ([se, ce]) => has("data", 3)(se) && has("data", 2)(ce));
    expect(dataOf(se)).toEqual([
      { channel: "reliable", bytes: [1] },
      { channel: "unreliable", bytes: [2, 2] },
      { channel: "reliable", bytes: [3] },
    ]);
    expect(dataOf(ce)).toEqual([
      { channel: "unreliable", bytes: [4] },
      { channel: "reliable", bytes: [] },
    ]);
    expect(se.every((e) => e.kind !== "data" || e.connection === toClient)).toBe(true);
  });

  it("keeps order across many messages and carries large ones", async () => {
    const { s, toServer } = await connected();
    for (let i = 0; i < 200; i++) toServer.send(i % 3 ? "unreliable" : "reliable", new Uint8Array([i]));
    const big = new Uint8Array(1 << 20).map((_, i) => i & 0xff);
    toServer.send("reliable", big);
    const [se] = await pollUntil([s], ([se]) => has("data", 201)(se));
    const data = dataOf(se);
    expect(data.slice(0, 200).map((d) => d.bytes[0])).toEqual([...Array(200).keys()]);
    expect(data[200].bytes.length).toBe(big.length);
    expect(data[200].bytes[12345]).toBe(12345 & 0xff);
  });

  it("queues sends made while connecting and delivers them after open", async () => {
    const { server: s, url } = await listening();
    const c = client();
    const connection = c.connect(url);
    connection.send("reliable", new Uint8Array([9]));
    connection.send("unreliable", new Uint8Array([10]));
    const [se] = await pollUntil([s, c], ([se]) => has("data", 2)(se));
    expect(dataOf(se)).toEqual([
      { channel: "reliable", bytes: [9] },
      { channel: "unreliable", bytes: [10] },
    ]);
  });

  it("closes from the client side with a reason", async () => {
    const { s, c, toServer, toClient } = await connected();
    toServer.close("bye from client");
    expect(toServer.state).toBe("closed");
    expect(() => toServer.send("reliable", new Uint8Array([1]))).toThrow(/closed/);
    const [se, ce] = await pollUntil([s, c], ([se, ce]) => has("close")(se) && has("close")(ce));
    expect(se.find((e) => e.kind === "close")).toMatchObject({ connection: toClient, reason: "bye from client" });
    expect(ce.filter((e) => e.kind === "close")).toEqual([{ kind: "close", connection: toServer, reason: "bye from client" }]);
    expect(toClient.state).toBe("closed");
  });

  it("closes from the server side with a reason", async () => {
    const { s, c, toServer, toClient } = await connected();
    toClient.close("kicked");
    const [, ce] = await pollUntil([s, c], ([, ce]) => has("close")(ce));
    expect(ce.find((e) => e.kind === "close")).toMatchObject({ connection: toServer, reason: "kicked" });
    expect(toServer.state).toBe("closed");
  });

  it("closing the server closes its clients", async () => {
    const { s, c, toServer } = await connected();
    s.close();
    expect(s.address).toBeNull();
    const [se, ce] = await pollUntil([s, c], ([se, ce]) => has("close")(se) && has("close")(ce));
    expect(se.find((e) => e.kind === "close")).toMatchObject({ reason: "server closed" });
    expect(ce.find((e) => e.kind === "close")).toMatchObject({ connection: toServer, reason: "server closed" });
  });

  it("reports a close event when connecting to a closed port", async () => {
    const free = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });
    const c = client();
    const connection = c.connect(`ws://127.0.0.1:${free}`);
    const [ce] = await pollUntil([c], ([ce]) => has("close")(ce));
    expect(ce.map((e) => e.kind)).toEqual(["close"]);
    expect(ce[0]).toMatchObject({ connection, reason: expect.stringMatching(/connection failed/) });
    expect(connection.state).toBe("closed");
  });

  it("only accepts upgrades on the listen path", async () => {
    const { server: s, url } = await listening("/game");
    expect(url).toMatch(/\/game$/);
    const c = client();
    const good = c.connect(url);
    const bad = c.connect(url.replace("/game", "/other"));
    const [, ce] = await pollUntil([s, c], ([, ce]) => has("open")(ce) && has("close")(ce));
    expect(ce.find((e) => e.kind === "open")!.connection).toBe(good);
    expect(ce.find((e) => e.kind === "close")!.connection).toBe(bad);
  });

  it("refuses to listen in the client-only transport, and on a port in use", async () => {
    await expect(client().listen("ws://0.0.0.0:7777")).rejects.toThrow(/Node server: import .*src\/server/);
    const { server: s } = await listening();
    await expect(server().listen(`127.0.0.1:${s.address!.port}`)).rejects.toThrow(/Can't listen/);
  });

  it("registers as \"websocket\", with the Node server's listening transport once it's imported", async () => {
    const transport = createTransport("websocket");
    open.push(transport);
    expect(transport).toBeInstanceOf(NodeWebSocketTransport);
    await transport.listen("0");
    expect((transport as NodeWebSocketTransport).address!.port).toBeGreaterThan(0);
  });
});

// Fixes from the wave 2 review: limits and back-pressure.
describe("limits and back-pressure", () => {
  /** A connection over a fake socket (the browser path's logic, without a network). */
  function fakeConnection(bufferedAmount = 0) {
    const sent: Uint8Array[] = [];
    const closes: [number | undefined, string | undefined][] = [];
    const socket = { bufferedAmount, send: (d: Uint8Array) => void sent.push(d), close: (code?: number, reason?: string) => void closes.push([code, reason]) };
    const events: TransportEvent[] = [];
    const c = new WebSocketConnection(1, "fake", socket, events, () => {}, { ...DEFAULT_WEBSOCKET_LIMITS, maxMessageBytes: 16, maxQueuedBytes: 40 });
    c.handleOpen();
    return { c, socket, sent, closes, events };
  }

  it("drops unreliable sends while the send buffer is backed up, and closes when reliable data can't drain", () => {
    const f = fakeConnection(DEFAULT_WEBSOCKET_LIMITS.unreliableBacklogBytes + 1);
    f.c.send("unreliable", new Uint8Array([1]));
    expect(f.sent).toHaveLength(0);
    expect(f.c.droppedUnreliable).toBe(1);
    f.c.send("reliable", new Uint8Array([2]));
    expect(f.sent).toHaveLength(1); // reliable data is never dropped
    f.socket.bufferedAmount = DEFAULT_WEBSOCKET_LIMITS.maxBacklogBytes + 1;
    f.c.send("reliable", new Uint8Array([3]));
    expect(f.c.state).toBe("closed");
    expect(f.events.at(-1)).toMatchObject({ kind: "close", reason: expect.stringMatching(/too slow/) });
  });

  it("closes a connection that sends a message too big, or floods between polls", () => {
    const big = fakeConnection();
    big.c.handleMessage(encodeFrame("reliable", new Uint8Array(17)).buffer);
    expect(big.closes[0]).toEqual([1009, expect.stringMatching(/too big/)]);

    const flood = fakeConnection();
    for (let i = 0; i < 3; i++) flood.c.handleMessage(encodeFrame("reliable", new Uint8Array(15)).buffer);
    expect(flood.closes[0]).toEqual([1009, expect.stringMatching(/flooding/)]);
  });

  it("reports the browser's failed connect (no reason, code 1006) and a lost connection", () => {
    const failing = new WebSocketConnection(2, "fake", { send() {}, close() {} }, [], () => {});
    failing.handleError("");
    failing.handleClose(1006, "");
    expect(failing.state).toBe("closed");
    const f = fakeConnection();
    f.c.handleClose(1006, "");
    expect(f.events.at(-1)).toMatchObject({ kind: "close", reason: "connection lost (code 1006)" });
  });

  it("the Node server refuses frames over the size limit before buffering them", async () => {
    const s = new NodeWebSocketTransport({ limits: { maxMessageBytes: 1024 } });
    open.push(s);
    await s.listen("ws://127.0.0.1:0");
    const c = client();
    const connection = c.connect(s.address!.url);
    await pollUntil([c, s], ([ce, se]) => ce.some((e) => e.kind === "open") && se.some((e) => e.kind === "open"));
    connection.send("reliable", new Uint8Array(4096));
    const [clientEvents] = await pollUntil([c, s], ([ce]) => ce.some((e) => e.kind === "close"));
    expect(clientEvents.find((e) => e.kind === "close")).toBeDefined();
  });
});
