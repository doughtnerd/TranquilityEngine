import { afterEach, describe, expect, it, vi } from "vitest";
import type { Channel, TransportConnection, TransportEvent } from "../Transport";
import type { PeerConnectionConstructor } from "./datagramLane";
import {
  RELIABLE_CHANNEL,
  UNRELIABLE_CHANNEL,
  WEBRTC_MAX_MESSAGE_BYTES,
  WebRtcTransport,
  type WebRtcSignal,
  type WebRtcSignaller,
  type WebRtcTransportOptions,
} from "./webrtc";

// Node has no RTCPeerConnection, so these tests run the transport over a fake peer pair: two fake peer connections
// that "connect" once descriptions and a candidate have crossed both ways, and fake data channels that deliver in
// microtasks, in order on myco-r, and on myco-u with loss and reordering the test controls.

/** The fake network: delivery order, holds, loss. */
class FakeNet {
  /** While set, deliveries wait in `held` until `release`. */
  hold = false;
  /** Decides whether an unreliable message is lost (`n` counts myco-u messages sent on this net from 0). */
  lose: (n: number) => boolean = () => false;
  private unreliableSent = 0;
  private held: (() => void)[] = [];
  private heldUnreliable: (() => void)[] = [];
  readonly peers: FakePeerConnection[] = [];

  schedule(task: () => void, unreliable: boolean): void {
    if (this.hold) (unreliable ? this.heldUnreliable : this.held).push(task);
    else queueMicrotask(task);
  }

  /**
   * Lets held deliveries go: reliable ones in order, then unreliable ones in order; or, with `overtake`, unreliable
   * ones first and newest first (myco-u is unordered and doesn't wait behind myco-r).
   */
  release(overtake = false): void {
    this.hold = false;
    const reliable = this.held.splice(0);
    const unreliable = this.heldUnreliable.splice(0);
    if (overtake) unreliable.reverse();
    for (const task of overtake ? [...unreliable, ...reliable] : [...reliable, ...unreliable]) queueMicrotask(task);
  }

  lost(): boolean {
    return this.lose(this.unreliableSent++);
  }
}

class FakeChannel {
  readyState: RTCDataChannelState = "connecting";
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  peer: FakeChannel | null = null;
  /** Sizes of every message sent, for checking the 64 KiB ceiling. */
  readonly sent: number[] = [];
  private closeFired = false;

  constructor(
    readonly label: string,
    readonly ordered: boolean,
    readonly maxRetransmits: number | null,
    private readonly net: FakeNet,
  ) {}

  get unreliable(): boolean {
    return !this.ordered && this.maxRetransmits === 0;
  }

  send(data: Uint8Array): void {
    if (this.readyState !== "open") throw new Error("InvalidStateError: channel not open");
    if (data.byteLength > WEBRTC_MAX_MESSAGE_BYTES) throw new TypeError(`message of ${data.byteLength} bytes is over the maximum message size`);
    const bytes = data.slice();
    this.sent.push(bytes.byteLength);
    this.bufferedAmount += bytes.byteLength;
    this.net.schedule(() => {
      const before = this.bufferedAmount;
      this.bufferedAmount -= bytes.byteLength;
      if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) this.onbufferedamountlow?.();
      if (this.unreliable && this.net.lost()) return;
      if (this.peer?.readyState === "open") this.peer.onmessage?.({ data: bytes.buffer });
    }, this.unreliable);
  }

  /** Closes after what's already sent (the closing procedure), firing close at both ends. */
  close(): void {
    if (this.readyState === "closing" || this.readyState === "closed") return;
    this.readyState = "closing";
    this.net.schedule(() => {
      this.shut();
      this.peer?.shut();
    }, this.unreliable);
  }

  shut(fire = true): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    if (fire && !this.closeFired) {
      this.closeFired = true;
      this.onclose?.();
    }
  }

  open(): void {
    this.readyState = "open";
    this.onopen?.();
  }
}

let nextPeerId = 1;

class FakePeerConnection {
  readonly id = nextPeerId++;
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  connectionState: RTCPeerConnectionState = "new";
  onicecandidate: ((event: { candidate: { candidate: string; sdpMid: string | null } | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: { channel: FakeChannel }) => void) | null = null;
  readonly channels: FakeChannel[] = [];
  readonly remoteCandidates: RTCIceCandidateInit[] = [];
  remote: FakePeerConnection | null = null;
  private linked = false;

  constructor(
    readonly config: RTCConfiguration | undefined,
    private readonly net: FakeNet,
  ) {
    net.peers.push(this);
  }

  createDataChannel(label: string, init: RTCDataChannelInit = {}): FakeChannel {
    const channel = new FakeChannel(label, init.ordered ?? true, init.maxRetransmits ?? null, this.net);
    this.channels.push(channel);
    return channel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: `fake-sdp ${this.id}` };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    if (!this.remoteDescription) throw new Error("no remote offer");
    return { type: "answer", sdp: `fake-sdp ${this.id}` };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
    queueMicrotask(() => {
      this.onicecandidate?.({ candidate: { candidate: `candidate:${this.id} 1 udp 2122260223 ${this.id}.local 50000 typ host`, sdpMid: "0" } });
      this.onicecandidate?.({ candidate: null });
    });
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
    const id = Number(description.sdp?.split(" ")[1]);
    this.remote = this.net.peers.find((p) => p.id === id) ?? null;
    this.tryConnect();
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteDescription) throw new Error("candidate before the remote description");
    this.remoteCandidates.push(candidate);
    this.tryConnect();
  }

  close(): void {
    this.connectionState = "closed";
    for (const channel of this.channels) {
      channel.shut(false); // a closing peer connection fires nothing at its own channels
      const peer = channel.peer;
      if (peer) queueMicrotask(() => peer.shut());
    }
  }

  /** The network failed under this peer connection. */
  fail(): void {
    this.connectionState = "failed";
    this.onconnectionstatechange?.();
  }

  private ready(): boolean {
    return !!this.localDescription && !!this.remoteDescription && this.remoteCandidates.length > 0 && this.connectionState !== "closed";
  }

  private tryConnect(): void {
    const remote = this.remote;
    if (!remote || this.linked || !this.ready() || !remote.ready() || remote.remote !== this) return;
    this.linked = remote.linked = true;
    const offerer = this.localDescription!.type === "offer" ? this : remote;
    const answerer = offerer === this ? remote : this;
    queueMicrotask(() => {
      for (const local of [...offerer.channels]) {
        const mirrored = new FakeChannel(local.label, local.ordered, local.maxRetransmits, this.net);
        mirrored.peer = local;
        local.peer = mirrored;
        answerer.channels.push(mirrored);
        answerer.ondatachannel?.({ channel: mirrored });
      }
      for (const pc of [offerer, answerer]) {
        pc.connectionState = "connected";
        pc.onconnectionstatechange?.();
        for (const channel of pc.channels) channel.open();
      }
    });
  }
}

/** One room: a signaller per side, relaying to each other while open. */
class FakeSignaller implements WebRtcSignaller {
  state: "connecting" | "open" | "closed" = "connecting";
  closedReason = "";
  other: FakeSignaller | null = null;
  connectedCalls = 0;
  private inbox: WebRtcSignal[] = [];

  constructor(
    readonly role: "offer" | "answer",
    readonly log: string[],
  ) {}

  send(signal: WebRtcSignal): void {
    if (this.state !== "open") return;
    this.log.push(`${this.role}:${signal.t}${signal.t === "candidate" && signal.candidate === "" ? "-end" : ""}`);
    this.other?.inbox.push(signal);
  }

  poll(): WebRtcSignal[] {
    return this.inbox.splice(0);
  }

  connected(): void {
    this.connectedCalls++;
  }

  close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.closedReason ||= "closed by its owner";
  }
}

interface Room {
  readonly log: string[];
  readonly offer: FakeSignaller;
  readonly answer: FakeSignaller;
  readonly addresses: string[];
  open(): void;
}

function room(): Room {
  const log: string[] = [];
  const offer = new FakeSignaller("offer", log);
  const answer = new FakeSignaller("answer", log);
  offer.other = answer;
  answer.other = offer;
  return {
    log,
    offer,
    answer,
    addresses: [],
    open() {
      offer.state = answer.state = "open";
    },
  };
}

function fakePeers(net: FakeNet): PeerConnectionConstructor {
  return class extends FakePeerConnection {
    constructor(config?: RTCConfiguration) {
      super(config, net);
    }
  } as unknown as PeerConnectionConstructor;
}

const transports: WebRtcTransport[] = [];
afterEach(() => {
  for (const t of transports.splice(0)) t.close();
  vi.useRealTimers();
});

function transport(r: Room, net: FakeNet, options: Partial<WebRtcTransportOptions> = {}): WebRtcTransport {
  const t = new WebRtcTransport({
    signaller: (address, role) => {
      r.addresses.push(`${role} ${address}`);
      return role === "offer" ? r.offer : r.answer;
    },
    PeerConnection: fakePeers(net),
    ...options,
  });
  transports.push(t);
  return t;
}

/** Let microtasks (fake deliveries, signalling steps) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** Poll both transports until `done` holds for the events so far. */
async function pollUntil(ts: WebRtcTransport[], done: (events: TransportEvent[][]) => boolean, rounds = 500): Promise<TransportEvent[][]> {
  const events: TransportEvent[][] = ts.map(() => []);
  for (let i = 0; i < rounds; i++) {
    ts.forEach((t, k) => events[k].push(...t.poll()));
    if (done(events)) return events;
    await flush();
  }
  throw new Error(`Gave up; got ${JSON.stringify(events.map((list) => list.map((e) => (e.kind === "close" ? `close:${e.reason}` : e.kind))))}`);
}

/** Poll for `rounds` rounds and return everything. */
async function settle(ts: WebRtcTransport[], rounds = 20): Promise<TransportEvent[][]> {
  let n = 0;
  return pollUntil(ts, () => ++n > rounds, rounds + 2);
}

const opened = (list: TransportEvent[]) => list.some((e) => e.kind === "open");
const closes = (list: TransportEvent[]) => list.flatMap((e) => (e.kind === "close" ? [e.reason] : []));
const data = (list: TransportEvent[], channel: Channel) => list.flatMap((e) => (e.kind === "data" && e.channel === channel ? [e.data] : []));

/** A connected pair: `host` listened (answers), `join` connected (offers). */
async function pair(options: Partial<WebRtcTransportOptions> = {}) {
  const net = new FakeNet();
  const r = room();
  const host = transport(r, net, options);
  const join = transport(r, net, options);
  await host.listen("room-1");
  const toHost = join.connect("room-1");
  r.open();
  const [hostEvents] = await pollUntil([host, join], ([h, j]) => opened(h) && opened(j));
  const toJoin = hostEvents.find((e) => e.kind === "open")!.connection;
  return { net, r, host, join, toHost, toJoin };
}

function pattern(size: number, seed = 0): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

function channelOf(net: FakeNet, label: string, side: "offer" | "answer"): FakeChannel {
  const pc = net.peers.find((p) => p.localDescription?.type === side)!;
  return pc.channels.find((c) => c.label === label)!;
}

describe("webrtc transport: signalling and opening", () => {
  it("offers from connect, answers from listen, and opens once both channels do", async () => {
    const net = new FakeNet();
    const r = room();
    const host = transport(r, net);
    const join = transport(r, net);
    await host.listen("wss://rendezvous/room ABC");
    const toHost = join.connect("wss://rendezvous/room ABC");
    expect(r.addresses).toEqual(["answer wss://rendezvous/room ABC", "offer wss://rendezvous/room ABC"]);
    expect(toHost.state).toBe("connecting");
    expect(toHost.remote).toBe("wss://rendezvous/room ABC");
    expect(toHost.maxDatagramBytes).toBeUndefined();

    // Nothing is signalled while the signallers are still connecting; it waits, then goes in order.
    await settle([host, join], 5);
    expect(r.log).toEqual([]);
    r.open();
    const [h, j] = await pollUntil([host, join], ([h, j]) => opened(h) && opened(j));

    expect(r.log[0]).toBe("offer:offer");
    expect(r.log.indexOf("answer:answer")).toBeGreaterThan(0);
    expect(r.log.filter((s) => s === "offer:candidate").length).toBeGreaterThan(0);
    expect(r.log.filter((s) => s === "answer:candidate").length).toBeGreaterThan(0);
    // Each side's candidates follow its description.
    expect(r.log.indexOf("offer:candidate")).toBeGreaterThan(r.log.indexOf("offer:offer"));
    expect(r.log.indexOf("answer:candidate")).toBeGreaterThan(r.log.indexOf("answer:answer"));
    expect(r.offer.connectedCalls).toBe(1);
    expect(r.answer.connectedCalls).toBe(1);
    expect(j.filter((e) => e.kind === "open").map((e) => e.connection)).toEqual([toHost]);
    expect(toHost.state).toBe("open");
    expect(h.find((e) => e.kind === "open")!.connection.state).toBe("open");
    expect(toHost.maxDatagramBytes).toBe(WEBRTC_MAX_MESSAGE_BYTES - 4);
  });

  it("makes myco-r reliable and ordered and myco-u unordered with no retransmits", async () => {
    const { net } = await pair();
    const r = channelOf(net, RELIABLE_CHANNEL, "offer");
    const u = channelOf(net, UNRELIABLE_CHANNEL, "offer");
    expect([r.ordered, r.maxRetransmits]).toEqual([true, null]);
    expect([u.ordered, u.maxRetransmits]).toEqual([false, 0]);
    expect(r.binaryType).toBe("arraybuffer");
    expect(channelOf(net, RELIABLE_CHANNEL, "answer").binaryType).toBe("arraybuffer");
  });

  it("uses host candidates only by default (no ICE servers)", async () => {
    const { net } = await pair();
    for (const pc of net.peers) expect(pc.config).toEqual({ iceServers: [] });
  });

  it("passes ICE servers from its options", async () => {
    const iceServers = [{ urls: "stun:stun.example:3478" }, { urls: ["turn:turn.example"], username: "u", credential: "c" }];
    const { net } = await pair({ iceServers });
    for (const pc of net.peers) expect(pc.config).toEqual({ iceServers: [{ urls: "stun:stun.example:3478" }, { urls: ["turn:turn.example"], username: "u", credential: "c" }] });
  });

  it("delivers messages sent while connecting once it opens", async () => {
    const net = new FakeNet();
    const r = room();
    const host = transport(r, net);
    const join = transport(r, net);
    await host.listen("room");
    const toHost = join.connect("room");
    toHost.send("reliable", new Uint8Array([1]));
    toHost.send("unreliable", new Uint8Array([2]));
    toHost.send("reliable", new Uint8Array([3]));
    r.open();
    const [h] = await pollUntil([host, join], ([h]) => data(h, "reliable").length === 2 && data(h, "unreliable").length === 1);
    expect(data(h, "reliable").map((d) => [...d])).toEqual([[1], [3]]);
    expect(data(h, "unreliable").map((d) => [...d])).toEqual([[2]]);
  });

  it("closes the connecting side with the signaller's reason when signalling ends before it opens", async () => {
    const net = new FakeNet();
    const r = room();
    const join = transport(r, net);
    const toHost = join.connect("room");
    r.offer.state = "closed";
    r.offer.closedReason = "room expired";
    const [j] = await pollUntil([join], ([j]) => closes(j).length > 0);
    expect(closes(j)).toEqual(["connection failed: signalling closed (room expired)"]);
    expect(toHost.state).toBe("closed");
    expect(() => toHost.send("reliable", new Uint8Array(1))).toThrow(`Can't send on closed connection ${toHost.id} (room).`);
  });

  it("reports nothing for a listening session that fails before it opens", async () => {
    const net = new FakeNet();
    const r = room();
    const host = transport(r, net);
    await host.listen("room");
    r.answer.state = "closed";
    r.answer.closedReason = "room expired";
    const [h] = await settle([host], 10);
    expect(h).toEqual([]);
  });

  it("keeps working after the signaller closes once connected", async () => {
    const { host, join, toHost, r } = await pair();
    r.offer.close();
    r.answer.close();
    toHost.send("reliable", new Uint8Array([9]));
    const [h] = await pollUntil([host, join], ([h]) => data(h, "reliable").length === 1);
    expect([...data(h, "reliable")[0]]).toEqual([9]);
    expect(toHost.state).toBe("open");
  });

  it("gives up on a connection that doesn't open within connectTimeoutMs", async () => {
    vi.useFakeTimers();
    const net = new FakeNet();
    const r = room();
    const join = transport(r, net, { connectTimeoutMs: 1000 });
    join.connect("room"); // nobody answers
    r.open();
    await settle([join], 3);
    vi.advanceTimersByTime(999);
    expect(join.poll()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(closes(join.poll())).toEqual(["connection failed: didn't open within 1000 ms"]);
    expect(r.offer.state).toBe("closed");
  });

  it("closes on an unexpected signal", async () => {
    const net = new FakeNet();
    const r = room();
    const join = transport(r, net);
    join.connect("room");
    r.open();
    r.answer.send({ t: "offer", sdp: "fake-sdp 999" }); // the offering side expects an answer
    const [j] = await pollUntil([join], ([j]) => closes(j).length > 0);
    expect(closes(j)).toEqual(["connection failed: protocol error: unexpected offer"]);
  });

  it("needs a signaller and an RTCPeerConnection", () => {
    expect(() => new WebRtcTransport({} as WebRtcTransportOptions)).toThrow('The "webrtc" transport needs a signaller option');
    expect(() => new WebRtcTransport({ signaller: () => room().offer })).toThrow('The "webrtc" transport needs RTCPeerConnection');
  });
});

describe("webrtc transport: myco-r, the reliable channel", () => {
  it("delivers reliable messages in order, both ways", async () => {
    const { host, join, toHost, toJoin } = await pair();
    for (let i = 0; i < 50; i++) toHost.send("reliable", new Uint8Array([i]));
    for (let i = 0; i < 50; i++) toJoin.send("reliable", new Uint8Array([100 + i]));
    const [h, j] = await pollUntil([host, join], ([h, j]) => data(h, "reliable").length === 50 && data(j, "reliable").length === 50);
    expect(data(h, "reliable").map((d) => d[0])).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(data(j, "reliable").map((d) => d[0])).toEqual(Array.from({ length: 50 }, (_, i) => 100 + i));
    expect(h.every((e) => e.kind !== "data" || e.connection === toJoin)).toBe(true);
  });

  it.each([
    ["64 KiB - 1", WEBRTC_MAX_MESSAGE_BYTES - 1, 2],
    ["64 KiB", WEBRTC_MAX_MESSAGE_BYTES, 2],
    ["64 KiB + 1", WEBRTC_MAX_MESSAGE_BYTES + 1, 2],
    ["5 MB", 5_000_000, Math.ceil(5_000_000 / (WEBRTC_MAX_MESSAGE_BYTES - 1))],
  ])("round-trips a %s reliable message in 64 KiB data channel messages", async (_name, size, minFrames) => {
    const { net, host, join, toHost } = await pair({ maxMessageBytes: 8 * 1024 * 1024 });
    const message = pattern(size, size & 0xff);
    toHost.send("reliable", new Uint8Array([7]));
    toHost.send("reliable", message);
    toHost.send("reliable", new Uint8Array([8]));
    const [h] = await pollUntil([host, join], ([h]) => data(h, "reliable").length === 3, 5000);
    const got = data(h, "reliable");
    expect([...got[0]]).toEqual([7]);
    expect(got[1].byteLength).toBe(size);
    expect(Buffer.from(got[1]).equals(Buffer.from(message))).toBe(true);
    expect([...got[2]]).toEqual([8]);
    const sent = channelOf(net, RELIABLE_CHANNEL, "offer").sent;
    expect(Math.max(...sent)).toBeLessThanOrEqual(WEBRTC_MAX_MESSAGE_BYTES);
    expect(sent.length).toBeGreaterThanOrEqual(minFrames);
  });

  it("closes a connection that receives a message over maxMessageBytes", async () => {
    const net = new FakeNet();
    const r = room();
    const host = transport(r, net, { maxMessageBytes: 100_000 });
    const join = transport(r, net);
    await host.listen("room");
    const toHost = join.connect("room");
    r.open();
    await pollUntil([host, join], ([h, j]) => opened(h) && opened(j));
    toHost.send("reliable", pattern(100_000));
    toHost.send("reliable", pattern(100_001));
    const [h, j] = await pollUntil([host, join], ([h, j]) => closes(h).length > 0 && closes(j).length > 0);
    expect(data(h, "reliable").map((d) => d.byteLength)).toEqual([100_000]);
    expect(closes(h)[0]).toMatch(/^message too big \(over 100000 bytes/);
    expect(closes(j)).toEqual(closes(h)); // the reason reaches the sender, as a WebSocket close's does
  });

  it("closes as too slow when the reliable backlog is over 8 MiB", async () => {
    const { net, host, join, toHost } = await pair({ maxMessageBytes: 16 * 1024 * 1024 });
    net.hold = true;
    toHost.send("reliable", pattern(5_000_000));
    toHost.send("reliable", pattern(5_000_000));
    expect(toHost.state).toBe("open");
    toHost.send("reliable", pattern(10));
    expect(toHost.state).toBe("closed");
    net.release();
    const [h, j] = await pollUntil([host, join], ([h, j]) => closes(h).length > 0 && closes(j).length > 0);
    expect(closes(j)[0]).toMatch(/^too slow: \d+ bytes waiting to send$/);
    expect(closes(h)).toEqual(closes(j));
  });
});

describe("webrtc transport: myco-u, the unreliable channel", () => {
  it("delivers unreliable messages on myco-u, both ways", async () => {
    const { net, host, join, toHost, toJoin } = await pair();
    toHost.send("unreliable", new Uint8Array([1, 2]));
    toJoin.send("unreliable", new Uint8Array([3, 4]));
    const [h, j] = await pollUntil([host, join], ([h, j]) => data(h, "unreliable").length === 1 && data(j, "unreliable").length === 1);
    expect([...data(h, "unreliable")[0]]).toEqual([1, 2]);
    expect([...data(j, "unreliable")[0]]).toEqual([3, 4]);
    expect(channelOf(net, UNRELIABLE_CHANNEL, "offer").sent).toEqual([6]); // 4-byte sequence number + payload
    expect(channelOf(net, RELIABLE_CHANNEL, "offer").sent).toEqual([]);
  });

  it("loses what myco-u loses, without closing", async () => {
    const { net, host, join, toHost } = await pair();
    net.lose = (n) => n % 2 === 1;
    for (let i = 0; i < 10; i++) toHost.send("unreliable", new Uint8Array([i]));
    toHost.send("reliable", new Uint8Array([99]));
    const [h] = await pollUntil([host, join], ([h]) => data(h, "reliable").length === 1);
    await settle([host, join]).then(([more]) => h.push(...more));
    expect(data(h, "unreliable").map((d) => d[0])).toEqual([0, 2, 4, 6, 8]);
    expect(toHost.state).toBe("open");
  });

  it("drops an unreliable message that isn't newer than the newest delivered", async () => {
    const { net, host, join, toHost } = await pair();
    net.hold = true;
    for (let i = 0; i < 5; i++) toHost.send("unreliable", new Uint8Array([i]));
    net.release(true); // myco-u is unordered: they arrive newest first
    const [h] = await settle([host, join]);
    expect(data(h, "unreliable").map((d) => d[0])).toEqual([4]);
    toHost.send("unreliable", new Uint8Array([5]));
    const [h2] = await pollUntil([host, join], ([h]) => data(h, "unreliable").length === 1);
    expect(data(h2, "unreliable").map((d) => d[0])).toEqual([5]);
  });

  it("sends an unreliable message too big for one data channel message on myco-r, sequenced", async () => {
    const { net, host, join, toHost } = await pair();
    net.lose = () => true; // everything on myco-u is lost
    const fits = pattern(WEBRTC_MAX_MESSAGE_BYTES - 4, 1);
    const over = pattern(WEBRTC_MAX_MESSAGE_BYTES - 3, 2);
    const large = pattern(300_000, 3);
    toHost.send("unreliable", fits);
    toHost.send("unreliable", over);
    const [h] = await pollUntil([host, join], ([h]) => data(h, "unreliable").length === 1);
    toHost.send("unreliable", large); // after myco-r has drained (a backed-up one drops it, latest-wins)
    await pollUntil([host, join], ([more]) => (h.push(...more.splice(0)), data(h, "unreliable").length === 2));
    const got = data(h, "unreliable");
    expect(Buffer.from(got[0]).equals(Buffer.from(over))).toBe(true);
    expect(Buffer.from(got[1]).equals(Buffer.from(large))).toBe(true);
    expect(channelOf(net, UNRELIABLE_CHANNEL, "offer").sent).toEqual([WEBRTC_MAX_MESSAGE_BYTES]);
    expect(Math.max(...channelOf(net, RELIABLE_CHANNEL, "offer").sent)).toBeLessThanOrEqual(WEBRTC_MAX_MESSAGE_BYTES);
  });

  it("drops a large unreliable message while myco-r's backlog is over 64 KiB (latest-wins)", async () => {
    const { net, host, join, toHost } = await pair();
    net.hold = true;
    toHost.send("reliable", pattern(70_000));
    toHost.send("unreliable", pattern(100_000));
    expect(channelOf(net, RELIABLE_CHANNEL, "offer").sent.length).toBe(2); // the reliable message's two fragments only
    net.release();
    const [h] = await pollUntil([host, join], ([h]) => data(h, "reliable").length === 1);
    await settle([host, join]).then(([more]) => h.push(...more));
    expect(data(h, "unreliable")).toEqual([]);
    expect(toHost.state).toBe("open");
  });

  it("drops a large unreliable message that would arrive after a newer one", async () => {
    const { net, host, join, toHost } = await pair();
    net.hold = true;
    toHost.send("unreliable", pattern(200_000)); // seq 0, on myco-r
    toHost.send("unreliable", new Uint8Array([1])); // seq 1, on myco-u
    net.release(true);
    // myco-u's message overtakes; the older large one is then stale.
    const [h] = await settle([host, join], 40);
    const got = data(h, "unreliable");
    expect(got.map((d) => d.byteLength)).toEqual([1]);
  });

  it("drops unreliable sends while myco-u's send buffer holds over 64 KiB (latest-wins), never reliable ones", async () => {
    const { net, host, join, toHost } = await pair();
    net.hold = true;
    toHost.send("unreliable", pattern(40_000, 1)); // buffer 0 before: sent
    toHost.send("unreliable", pattern(40_000, 2)); // 40,004 before: sent
    toHost.send("unreliable", pattern(40_000, 3)); // 80,008 before: dropped
    for (let i = 0; i < 3; i++) toHost.send("reliable", pattern(40_000, 10 + i));
    expect(channelOf(net, UNRELIABLE_CHANNEL, "offer").sent.length).toBe(2);
    net.release();
    const [h] = await pollUntil([host, join], ([h]) => data(h, "reliable").length === 3);
    await settle([host, join]).then(([more]) => h.push(...more));
    expect(data(h, "unreliable").map((d) => d[0])).toEqual([pattern(1, 1)[0], pattern(1, 2)[0]]);
    expect(data(h, "reliable").length).toBe(3);
  });
});

describe("webrtc transport: closing", () => {
  async function closeFrom(side: "join" | "host") {
    const p = await pair();
    const [closer, other] = side === "join" ? [p.toHost, p.toJoin] : [p.toJoin, p.toHost];
    closer.send("reliable", pattern(200_000, 5)); // sent before the close: it arrives first
    closer.close("bye for now");
    expect(closer.state).toBe("closed");
    expect(() => closer.send("reliable", new Uint8Array(1))).toThrow(`Can't send on closed connection ${closer.id}`);
    const [h, j] = await pollUntil([p.host, p.join], ([h, j]) => closes(h).length > 0 && closes(j).length > 0);
    const [closerEvents, otherEvents] = side === "join" ? [j, h] : [h, j];
    return { closer, other, closerEvents, otherEvents, p };
  }

  it.each(["join", "host"] as const)("a close from the %s side reaches the other with its reason, after what was sent before it", async (side) => {
    const { other, closerEvents, otherEvents, p } = await closeFrom(side);
    expect(closes(closerEvents)).toEqual(["bye for now"]);
    expect(closes(otherEvents)).toEqual(["bye for now"]);
    const got = data(otherEvents, "reliable");
    expect(got.length).toBe(1);
    expect(Buffer.from(got[0]).equals(Buffer.from(pattern(200_000, 5)))).toBe(true);
    expect(other.state).toBe("closed");
    const more = await settle([p.host, p.join]);
    expect(more.flat()).toEqual([]); // exactly one close each
    for (const pc of p.net.peers) expect(pc.connectionState).toBe("closed");
  });

  it("closes as lost when the peer connection fails", async () => {
    const { net, host, join, toHost } = await pair();
    net.peers.find((pc) => pc.localDescription?.type === "offer")!.fail();
    const [, j] = await pollUntil([host, join], ([, j]) => closes(j).length > 0);
    expect(closes(j)).toEqual(["connection lost: peer connection failed"]);
    expect(toHost.state).toBe("closed");
  });

  it("closes as lost when a channel closes under it", async () => {
    const { net, host, join } = await pair();
    channelOf(net, UNRELIABLE_CHANNEL, "answer").close();
    const [h, j] = await pollUntil([host, join], ([h, j]) => closes(h).length > 0 && closes(j).length > 0);
    expect(closes(h)).toEqual([`connection lost: ${UNRELIABLE_CHANNEL} closed`]);
    expect(closes(j)).toEqual([`connection lost: ${UNRELIABLE_CHANNEL} closed`]);
  });

  it("closes every connection when the transport closes", async () => {
    const { host, join, toHost, toJoin } = await pair();
    join.close();
    expect(toHost.state).toBe("closed");
    const [h, j] = await pollUntil([host, join], ([h, j]) => closes(h).length > 0 && closes(j).length > 0);
    expect(closes(j)).toEqual(["transport closed"]);
    expect(closes(h)).toEqual(["transport closed"]);
    expect((toJoin as TransportConnection).state).toBe("closed");
  });
});
