// A fake `RTCPeerConnection` pair for tests of the `webrtc` transport over a rendezvous (plan tasks R1, R5): Node has no
// WebRTC. Copied from `net/transport/webrtc.test.ts` (as `rendezvous/webrtc.integration.test.ts` copies it), so the
// room-code tests of the engine and the editor share one copy. Imported only by tests; nothing in the engine reaches it.
import type { PeerConnectionConstructor } from "../net/transport/datagramLane";
import { WEBRTC_MAX_MESSAGE_BYTES } from "../net/transport/webrtc";

/** The fake network: delivery order. */
export class FakeNet {
  readonly peers: FakePeerConnection[] = [];

  schedule(task: () => void): void {
    queueMicrotask(task);
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
  private closeFired = false;

  constructor(
    readonly label: string,
    readonly ordered: boolean,
    readonly maxRetransmits: number | null,
    private readonly net: FakeNet,
  ) {}

  send(data: Uint8Array): void {
    if (this.readyState !== "open") throw new Error("InvalidStateError: channel not open");
    if (data.byteLength > WEBRTC_MAX_MESSAGE_BYTES) throw new TypeError(`message of ${data.byteLength} bytes is over the maximum message size`);
    const bytes = data.slice();
    this.bufferedAmount += bytes.byteLength;
    this.net.schedule(() => {
      const before = this.bufferedAmount;
      this.bufferedAmount -= bytes.byteLength;
      if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) this.onbufferedamountlow?.();
      if (this.peer?.readyState === "open") this.peer.onmessage?.({ data: bytes.buffer });
    });
  }

  /** Closes after what's already sent (the closing procedure), firing close at both ends. */
  close(): void {
    if (this.readyState === "closing" || this.readyState === "closed") return;
    this.readyState = "closing";
    this.net.schedule(() => {
      this.shut();
      this.peer?.shut();
    });
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

/** A peer connection constructor whose instances meet on `net` (one net per test: peers find each other by id there). */
export function fakePeers(net: FakeNet = new FakeNet()): PeerConnectionConstructor {
  return class extends FakePeerConnection {
    constructor(config?: RTCConfiguration) {
      super(config, net);
    }
  } as unknown as PeerConnectionConstructor;
}

/** Lets microtasks (fake deliveries, signalling steps) run. */
export async function flushPeers(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
