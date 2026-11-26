import { afterEach, describe, expect, it } from "vitest";
import { createSocket } from "node:dgram";
import { createTransport, type Transport, type TransportConnection, type TransportEvent } from "../net/Transport";
import { hostCandidateRewriter, type PeerConnectionConstructor } from "../net/transport/datagramLane";
import { DEFAULT_MAX_DATAGRAM_BYTES, WebSocketTransport, type RtcSetup, type SocketLike } from "../net/transport/websocket";
import "../../server/websocketServer"; // registers the Node "websocket" transport: it listens, and its connections get node-datachannel's WebRTC
import type { ListenAddress } from "../../server/websocketServer";

// ADR 0333: the WebSocket transport's datagram lane, over real sockets and real WebRTC (node-datachannel)
// on this machine. Clients made with createTransport("websocket") are the Node transport, which can open
// a lane; `new WebSocketTransport()` is the browser transport, which can't here (Node has no RTCPeerConnection).

type NodeTransport = Transport & { readonly address: ListenAddress | null };

const open: Transport[] = [];
afterEach(() => {
  for (const transport of open.splice(0)) transport.close();
});

function node(options: Record<string, unknown> = {}): NodeTransport {
  const transport = createTransport("websocket", options) as NodeTransport;
  open.push(transport);
  return transport;
}

async function listening(options: Record<string, unknown> = {}): Promise<NodeTransport> {
  const s = node(options);
  await s.listen("ws://127.0.0.1:0");
  return s;
}

/** Poll each transport until `done` holds for the events so far (one list per transport). */
async function pollUntil(transports: Transport[], done: (events: TransportEvent[][]) => boolean, timeoutMs = 5000): Promise<TransportEvent[][]> {
  const events: TransportEvent[][] = transports.map(() => []);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    transports.forEach((t, i) => events[i].push(...t.poll()));
    if (done(events)) return events;
    if (Date.now() > deadline) throw new Error(`Timed out; got ${JSON.stringify(events.map((list) => list.map((e) => e.kind)))}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Keep polling (so nothing is held back) for `ms`. */
async function settle(transports: Transport[], ms: number): Promise<TransportEvent[][]> {
  const until = Date.now() + ms;
  return pollUntil(transports, () => Date.now() >= until, ms + 1000);
}

const payloads = (list: TransportEvent[], channel: "reliable" | "unreliable") =>
  list.flatMap((e) => (e.kind === "data" && e.channel === channel ? [[...e.data]] : []));

/** A client connected to `s`: both connections, once open. */
async function connect(s: NodeTransport, c: Transport): Promise<{ toServer: TransportConnection; toClient: TransportConnection }> {
  const toServer = c.connect(s.address!.url);
  const [se] = await pollUntil([s, c], ([se, ce]) => se.some((e) => e.kind === "open") && ce.some((e) => e.kind === "open"));
  return { toServer, toClient: se.find((e) => e.kind === "open")!.connection };
}

/** Wait until both ends' lanes are open. */
async function lanesOpen(transports: Transport[], ...connections: TransportConnection[]): Promise<void> {
  await pollUntil(transports, () => connections.every((c) => c.maxDatagramBytes !== undefined));
}

/** A free UDP port on this machine. */
async function freeUdpPort(): Promise<number> {
  const socket = createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const { port } = socket.address();
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}

/** Whether a UDP socket can bind `port` on every interface. */
async function udpPortFree(port: number): Promise<boolean> {
  const socket = createSocket("udp4");
  const ok = await new Promise<boolean>((resolve) => {
    socket.once("error", () => resolve(false));
    socket.bind(port, () => resolve(true));
  });
  socket.close();
  return ok;
}

describe("the WebSocket transport's datagram lane (ADR 0333)", () => {
  it("opens a WebRTC data channel for a client that asks, and every message still arrives", async () => {
    const s = await listening();
    const c = node();
    const { toServer, toClient } = await connect(s, c);
    await lanesOpen([s, c], toServer, toClient);
    expect(toServer.maxDatagramBytes).toBe(DEFAULT_MAX_DATAGRAM_BYTES - 4);
    expect(toClient.maxDatagramBytes).toBe(DEFAULT_MAX_DATAGRAM_BYTES - 4);

    // Small unreliable messages go as datagrams; on this machine none is lost.
    for (let i = 0; i < 20; i++) toServer.send("unreliable", new Uint8Array([i]));
    let [se] = await pollUntil([s, c], ([se]) => payloads(se, "unreliable").some((p) => p[0] === 19));
    expect(payloads(se, "unreliable").length).toBeGreaterThan(0);
    // Whatever arrived is in sending order: a message older than one delivered is dropped, never delivered late.
    const firsts = payloads(se, "unreliable").map((p) => p[0]);
    expect(firsts).toEqual([...firsts].sort((a, b) => a - b));

    // Reliable messages, and an unreliable one too big for a datagram, go over the socket.
    toClient.send("reliable", new Uint8Array([1, 2, 3]));
    const big = new Uint8Array(5000).fill(7);
    toClient.send("unreliable", big);
    const [, ce] = await pollUntil([s, c], ([, ce]) => payloads(ce, "reliable").length === 1 && payloads(ce, "unreliable").length === 1);
    expect(payloads(ce, "reliable")).toEqual([[1, 2, 3]]);
    expect(payloads(ce, "unreliable")[0]).toHaveLength(5000);

    // And datagrams after it still arrive (each path has its own sequence numbers, ADR 0398).
    toClient.send("unreliable", new Uint8Array([42]));
    [, se] = await pollUntil([s, c], ([, ce2]) => payloads(ce2, "unreliable").some((p) => p[0] === 42));
  });

  it("closing the socket closes the lane; the other end sees one close", async () => {
    const s = await listening();
    const c = node();
    const { toServer, toClient } = await connect(s, c);
    await lanesOpen([s, c], toServer, toClient);
    toServer.close("bye");
    const [se] = await pollUntil([s, c], ([se]) => se.some((e) => e.kind === "close"));
    expect(se.filter((e) => e.kind === "close")).toHaveLength(1);
    expect(toServer.maxDatagramBytes).toBeUndefined();
    expect(toClient.maxDatagramBytes).toBeUndefined();
  });

  it("a client without WebRTC never asks, and stays on its socket", async () => {
    const s = await listening();
    const c = new WebSocketTransport(); // the browser transport, on Node's WebSocket: no RTCPeerConnection here
    open.push(c);
    const { toServer, toClient } = await connect(s, c);
    toServer.send("unreliable", new Uint8Array([5]));
    const [se] = await settle([s, c], 300);
    expect(payloads(se, "unreliable")).toEqual([[5]]);
    expect(toServer.maxDatagramBytes).toBeUndefined();
    expect(toClient.maxDatagramBytes).toBeUndefined();
  });

  it("webrtc: false on either end keeps the connection on its socket", async () => {
    for (const [serverOptions, clientOptions] of [
      [{ webrtc: false }, {}],
      [{}, { webrtc: false }],
    ]) {
      const s = await listening(serverOptions);
      const c = node(clientOptions);
      const { toServer, toClient } = await connect(s, c);
      toClient.send("unreliable", new Uint8Array([6]));
      const [, ce] = await settle([s, c], 400);
      expect(payloads(ce, "unreliable")).toEqual([[6]]);
      expect(toServer.maxDatagramBytes).toBeUndefined();
      expect(toClient.maxDatagramBytes).toBeUndefined();
    }
  });

  it("gives up on a lane that doesn't open in time; unreliable messages keep arriving over the socket", async () => {
    const s = await listening({ webrtc: { connectTimeoutMs: 1 } });
    const c = node({ webrtc: { connectTimeoutMs: 1 } });
    const { toServer, toClient } = await connect(s, c);
    await settle([s, c], 300);
    expect(toServer.maxDatagramBytes).toBeUndefined();
    expect(toClient.maxDatagramBytes).toBeUndefined();
    for (let i = 0; i < 5; i++) toServer.send("unreliable", new Uint8Array([i]));
    toServer.send("reliable", new Uint8Array([99]));
    const [se] = await pollUntil([s, c], ([se]) => payloads(se, "reliable").length === 1);
    expect(payloads(se, "unreliable")).toEqual([[0], [1], [2], [3], [4]]);
  });

  it("puts every connection's channel on one UDP port with udpPort, and publicIp in the server's candidates", async () => {
    const udpPort = await freeUdpPort();
    const s = await listening({ webrtc: { udpPort, publicIp: "127.0.0.1" } });
    const [a, b] = [node(), node()];
    const first = await connect(s, a);
    const second = await connect(s, b);
    await lanesOpen([s, a, b], first.toServer, first.toClient, second.toServer, second.toClient);
    expect(await udpPortFree(udpPort)).toBe(false); // the server's channels hold it
    first.toClient.send("unreliable", new Uint8Array([1]));
    second.toClient.send("unreliable", new Uint8Array([2]));
    const [, ae, be] = await pollUntil([s, a, b], ([, ae, be]) => payloads(ae, "unreliable").length > 0 && payloads(be, "unreliable").length > 0);
    expect(payloads(ae, "unreliable")).toEqual([[1]]);
    expect(payloads(be, "unreliable")).toEqual([[2]]);
  });

  it("refuses bad webrtc options", () => {
    expect(() => node({ webrtc: "yes" })).toThrow(/must be false or an object/);
    expect(() => node({ webrtc: { udpPort: 0 } })).toThrow(/udpPort must be a port/);
    expect(() => node({ webrtc: { publicIp: " " } })).toThrow(/publicIp must be an address/);
    expect(() => node({ webrtc: { maxDatagramBytes: 10 } })).toThrow(/maxDatagramBytes must be a whole number/);
  });

  it("puts a public address in host candidates only", () => {
    const rewrite = hostCandidateRewriter("203.0.113.7");
    expect(rewrite("candidate:1 1 UDP 2122317823 10.0.0.5 50000 typ host")).toBe("candidate:1 1 UDP 2122317823 203.0.113.7 50000 typ host");
    const srflx = "candidate:2 1 UDP 1686052607 198.51.100.2 50000 typ srflx raddr 10.0.0.5 rport 50000";
    expect(rewrite(srflx)).toBe(srflx);
    expect(rewrite("garbage")).toBe("garbage");
  });
});

/**
 * A client transport over sockets it's handed (as websocket.test.ts's), with or without a lane setup
 * whose peer connection never loads: the framing rules, without a network.
 */
class FakeSocketTransport extends WebSocketTransport {
  constructor(private readonly canAsk: boolean) {
    super();
  }
  protected override rtcSetup(role: RtcSetup["role"]): RtcSetup | null {
    return this.canAsk ? { role, load: async () => null, config: {}, maxDatagramBytes: 1100, connectTimeoutMs: 1000 } : null;
  }
  connectOver(socket: SocketLike) {
    return this.addConnection("fake", socket, this.rtcSetup("answer"));
  }
}

function fake(canAsk: boolean) {
  const sent: Uint8Array[] = [];
  const transport = new FakeSocketTransport(canAsk);
  const c = transport.connectOver({ send: (d) => void sent.push(d), close: () => {} });
  c.handleOpen();
  const events: TransportEvent[] = [];
  return {
    c,
    sent,
    get events() {
      events.push(...transport.poll());
      return events;
    },
  };
}

const signal = (message: object) => new Uint8Array([0x02, ...new TextEncoder().encode(JSON.stringify(message))]);
const sequenced = (seq: number, ...payload: number[]) => new Uint8Array([0x05, seq >>> 24, (seq >>> 16) & 255, (seq >>> 8) & 255, seq & 255, ...payload]);

describe("datagram lane framing (ADR 0333)", () => {
  it("a client that didn't ask closes on a signal frame, and nobody accepts sequenced frames before an offer", () => {
    const plain = fake(false);
    plain.c.handleMessage(signal({ t: "offer", sdp: "v=0" }));
    expect(plain.events.at(-1)).toMatchObject({ kind: "close", reason: expect.stringMatching(/signal frame this end didn't ask for/) });

    const early = fake(true);
    early.c.handleMessage(sequenced(1, 9));
    expect(early.events.at(-1)).toMatchObject({ kind: "close", reason: expect.stringMatching(/sequenced frame before negotiation/) });

    const malformed = fake(true);
    malformed.c.handleMessage(new Uint8Array([0x02, 123]));
    expect(malformed.events.at(-1)).toMatchObject({ kind: "close", reason: expect.stringMatching(/malformed signal frame/) });
  });

  it("after an offer, unreliable frames carry sequence numbers both ways and stale ones are dropped", () => {
    const f = fake(true);
    f.c.send("unreliable", new Uint8Array([1])); // before the offer: unsequenced
    f.c.handleMessage(signal({ t: "offer", sdp: "v=0" }));
    f.c.send("unreliable", new Uint8Array([2]));
    f.c.send("unreliable", new Uint8Array([3]));
    f.c.send("reliable", new Uint8Array([4]));
    expect(f.sent.map((frame) => [...frame])).toEqual([
      [0x01, 1],
      [0x05, 0, 0, 0, 0, 2],
      [0x05, 0, 0, 0, 1, 3],
      [0x00, 4],
    ]);
    // Received: delivered in sequence; one older than the newest is dropped, across the 32-bit wrap too.
    f.c.handleMessage(sequenced(0xfffffffe, 10));
    f.c.handleMessage(sequenced(1, 11));
    f.c.handleMessage(sequenced(0xffffffff, 12)); // older than 1 across the wrap: stale
    f.c.handleMessage(sequenced(1, 13)); // a repeat: stale
    f.c.handleMessage(sequenced(2, 14));
    const got = f.events.flatMap((e) => (e.kind === "data" ? [[...e.data]] : []));
    expect(got).toEqual([[10], [11], [14]]);
    expect(f.c.maxDatagramBytes).toBeUndefined(); // no peer connection here, so no lane
  });
});

/** A data channel that records what it's sent; the test hands it incoming datagrams. */
class FakeChannel {
  readonly label = "myco-u";
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  send(data: Uint8Array): void {
    this.sent.push(new Uint8Array(data));
  }
  close(): void {}
}

/** An `RTCPeerConnection` that opens its one data channel as soon as it reads the other end's offer. */
class FakePeerConnection {
  static readonly made: FakePeerConnection[] = [];
  readonly channel = new FakeChannel();
  connectionState = "new";
  localDescription: { type: string; sdp: string } | null = null;
  onicecandidate: unknown = null;
  onconnectionstatechange: unknown = null;
  ondatachannel: ((event: { channel: FakeChannel }) => void) | null = null;
  constructor() {
    FakePeerConnection.made.push(this);
  }
  createDataChannel(): FakeChannel {
    return this.channel;
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "v=0" };
  }
  async setLocalDescription(description: { type: string; sdp: string }) {
    this.localDescription = description;
  }
  async setRemoteDescription() {
    this.ondatachannel?.({ channel: this.channel });
    this.channel.onopen?.();
  }
  async addIceCandidate() {}
  close(): void {}
}

/** A client transport over a fake socket whose lane opens on a fake peer connection, with no network. */
class FakeLaneTransport extends WebSocketTransport {
  protected override rtcSetup(role: RtcSetup["role"]): RtcSetup | null {
    return { role, load: async () => FakePeerConnection as unknown as PeerConnectionConstructor, config: {}, maxDatagramBytes: 1100, connectTimeoutMs: 1000 };
  }
  connectOver(socket: SocketLike) {
    return this.addConnection("fake", socket, this.rtcSetup("answer"));
  }
}

/** A negotiated connection whose lane is open: what it sent on its socket and as datagrams, and what it delivered. */
async function laned() {
  const sent: Uint8Array[] = [];
  const transport = new FakeLaneTransport();
  const c = transport.connectOver({ send: (d) => void sent.push(new Uint8Array(d)), close: () => {} });
  c.handleOpen();
  c.handleMessage(signal({ t: "offer", sdp: "v=0" }));
  for (let i = 0; i < 10 && c.maxDatagramBytes === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(c.maxDatagramBytes).toBe(1096);
  const pc = FakePeerConnection.made.at(-1)!;
  sent.splice(0); // the answer
  const events: TransportEvent[] = [];
  return {
    c,
    sent,
    datagrams: pc.channel.sent,
    receiveDatagram: (datagram: Uint8Array) => pc.channel.onmessage!({ data: datagram.slice().buffer }),
    get delivered() {
      events.push(...transport.poll());
      return events.flatMap((e) => (e.kind === "data" && e.channel === "unreliable" ? [[...e.data]] : []));
    },
  };
}

describe("unreliable messages too big for a datagram (ADR 0398)", () => {
  it("go over the socket in the socket's own sequence; datagrams around them keep theirs", async () => {
    const a = await laned();
    a.c.send("unreliable", new Uint8Array([1]));
    a.c.send("unreliable", new Uint8Array(2000).fill(2));
    a.c.send("unreliable", new Uint8Array([3]));
    expect(a.datagrams.map((d) => [...d])).toEqual([
      [0, 0, 0, 0, 1],
      [0, 0, 0, 1, 3],
    ]);
    expect(a.sent).toHaveLength(1);
    expect([...a.sent[0].subarray(0, 6)]).toEqual([0x05, 0, 0, 0, 0, 2]);
  });

  it("still arrive when datagrams sent after them overtake them; each path still drops its own stale messages", async () => {
    const a = await laned();
    const b = await laned();
    a.c.send("unreliable", new Uint8Array([1]));
    a.c.send("unreliable", new Uint8Array(2000).fill(2));
    a.c.send("unreliable", new Uint8Array([3]));
    // The datagrams arrive first (the socket's copy is held up behind a lost TCP segment).
    for (const datagram of a.datagrams) b.receiveDatagram(datagram);
    b.c.handleMessage(a.sent[0]);
    expect(b.delivered.map((p) => (p.length > 1 ? `big ${p.length}` : p[0]))).toEqual([1, 3, "big 2000"]);
    // A repeat on either path is still stale.
    b.receiveDatagram(a.datagrams[0]);
    b.c.handleMessage(a.sent[0]);
    expect(b.delivered).toHaveLength(3);
  });
});
