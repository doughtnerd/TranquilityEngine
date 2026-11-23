// Two `WebRtcTransport`s signalling through two rendezvous clients and one rendezvous server (plan task R1). The fake
// peer pair below is copied from `net/transport/webrtc.test.ts` (tests don't import across test files).
import { afterEach, describe, expect, it } from "vitest";
import { createTransport, type TransportEvent } from "../../net/Transport";
import "../../net/transport/loopback";
import type { PeerConnectionConstructor } from "../../net/transport/datagramLane";
import { WEBRTC_MAX_MESSAGE_BYTES, WebRtcTransport } from "../../net/transport/webrtc";
import { RendezvousClient } from "./client";
import { RendezvousServer } from "./server";

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

function fakePeers(net: FakeNet): PeerConnectionConstructor {
  return class extends FakePeerConnection {
    constructor(config?: RTCConfiguration) {
      super(config, net);
    }
  } as unknown as PeerConnectionConstructor;
}

const cleanup: { close(): void }[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c.close();
});

/** Let microtasks (fake deliveries, signalling steps) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe("two webrtc transports signalling through a rendezvous", () => {
  it("connects, forgets the room, and carries a reliable message", async () => {
    const net = new FakeNet();
    const server = new RendezvousServer({ transport: createTransport("loopback"), now: () => 0 });
    cleanup.push(server);
    await server.listen("integration-rendezvous");

    const clients: RendezvousClient[] = [];
    const host = new WebRtcTransport({
      PeerConnection: fakePeers(net),
      signaller: (address) => {
        const c = RendezvousClient.openRoom({ transport: createTransport("loopback"), url: address, kind: "page-http", draw: () => ({ room: 5, token: 77 }) });
        clients.push(c);
        return c;
      },
    });
    const guest = new WebRtcTransport({
      PeerConnection: fakePeers(net),
      signaller: (address) => {
        const c = RendezvousClient.joinRoom({ transport: createTransport("loopback"), url: address, kind: "native", room: 5, token: 77 });
        clients.push(c);
        return c;
      },
    });
    cleanup.push(host, guest);

    await host.listen("integration-rendezvous");
    const toHost = guest.connect("integration-rendezvous");
    expect(clients[0].room).toBe(5);
    expect(clients[0].token).toBe(77);

    const received: number[][] = [];
    let sent = false;
    for (let i = 0; i < 400 && received.length === 0; i++) {
      server.poll();
      for (const e of host.poll()) if (e.kind === "data" && e.channel === "reliable") received.push([...e.data]);
      guest.poll();
      if (!sent && toHost.state === "open") {
        toHost.send("reliable", new Uint8Array([9, 8, 7]));
        sent = true;
      }
      await flush();
    }
    expect(received).toEqual([[9, 8, 7]]);
    expect(clients[0].peerKind).toBe("native");
    expect(clients[1].peerKind).toBe("page-http");

    // Both peers reported connected: the room is forgotten and both signalling sessions are over.
    for (let i = 0; i < 10; i++) {
      server.poll();
      host.poll();
      guest.poll();
      await flush();
    }
    expect(server.roomCount).toBe(0);
    expect(clients.every((c) => c.state === "closed")).toBe(true);
    expect(toHost.state).toBe("open");
  });
});

