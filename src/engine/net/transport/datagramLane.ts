/**
 * The datagram lane (ADR 0333): one WebRTC peer connection and one unordered, unreliable data
 * channel beside a WebSocket connection, for its unreliable messages. Browser-safe: it uses the
 * standard `RTCPeerConnection` API from a constructor its owner gives it (the browser's, or the Node
 * server's node-datachannel polyfill), and its signalling goes out through a callback (the owner
 * sends it over the WebSocket).
 *
 * The server end offers and creates the channel; the client end answers. A lane that hasn't opened
 * within `connectTimeoutMs`, or whose peer connection fails, closes itself; its owner then keeps
 * the traffic on the WebSocket. Nothing here ever closes the WebSocket.
 */

/** The data channel's label; a channel by any other name is ignored. */
export const DATAGRAM_CHANNEL = "myco-u";

/** A signalling message, carried as JSON in a WebSocket signal frame. */
export type SignalMessage =
  | { readonly t: "offer" | "answer"; readonly sdp: string }
  | { readonly t: "candidate"; readonly candidate: string; readonly mid: string | null };

/** Read a signal frame's JSON, or null if it isn't a signalling message. */
export function parseSignal(text: string): SignalMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if ((v.t === "offer" || v.t === "answer") && typeof v.sdp === "string") return { t: v.t, sdp: v.sdp };
  if (v.t === "candidate" && typeof v.candidate === "string" && (v.mid === null || typeof v.mid === "string")) return { t: "candidate", candidate: v.candidate, mid: v.mid };
  return null;
}

/** An `RTCPeerConnection` constructor: the browser's, or one with its API (node-datachannel's polyfill). */
export type PeerConnectionConstructor = new (config?: RTCConfiguration) => RTCPeerConnection;

/** How a lane connects: everything but the owner's callbacks. */
export interface LaneSetup {
  /** The server offers; the client answers. */
  readonly role: "offer" | "answer";
  readonly PeerConnection: PeerConnectionConstructor;
  /**
   * Passed to the peer connection. Standard keys, plus any its implementation reads (node-datachannel
   * takes `portRangeBegin`, `portRangeEnd`, `enableIceUdpMux` and `bindAddress`).
   */
  readonly config: RTCConfiguration;
  /** Give up on a lane that hasn't opened by then. */
  readonly connectTimeoutMs: number;
  /** Rewrites each local ICE candidate line before it's sent (the server's `publicIp`). */
  readonly rewriteCandidate?: (candidate: string) => string;
}

/** What the lane tells its owner. */
export interface LaneCallbacks {
  /** Send a signalling message to the other end (over the WebSocket). */
  signal(message: SignalMessage): void;
  /** A datagram arrived. */
  receive(data: Uint8Array): void;
}

/** Signalling messages a lane accepts before it treats the other end as misbehaving. */
const MAX_SIGNALS = 64;

export class DatagramLane {
  state: "connecting" | "open" | "closed" = "connecting";
  /** Why it closed, for logs ("" while it hasn't). */
  reason = "";
  private readonly pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  /** Signalling is applied in order: each step waits for the one before (descriptions are async). */
  private chain: Promise<void> = Promise.resolve();
  private signals = 0;
  /** The other end's description has arrived (candidates before it wait in `early`). */
  private described = false;
  private early: SignalMessage[] = [];
  /** Local candidates found before this end's description went out; null once it has. */
  private unsent: SignalMessage[] | null = [];
  private timer: ReturnType<typeof setTimeout> | null;

  constructor(
    private readonly setup: LaneSetup,
    private readonly callbacks: LaneCallbacks,
  ) {
    this.pc = new setup.PeerConnection(setup.config);
    this.pc.onicecandidate = (event) => {
      const c = event.candidate;
      if (!c || !c.candidate || this.state === "closed") return; // null: gathering finished
      const message: SignalMessage = { t: "candidate", candidate: this.rewrite(c.candidate), mid: c.sdpMid ?? null };
      if (this.unsent) this.unsent.push(message); // the description goes first
      else this.callbacks.signal(message);
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === "failed" || s === "closed") this.close(`peer connection ${s}`);
    };
    this.timer = setTimeout(() => {
      if (this.state === "connecting") this.close(`didn't open within ${setup.connectTimeoutMs} ms`);
    }, setup.connectTimeoutMs);
    if (setup.role === "offer") {
      this.attach(this.pc.createDataChannel(DATAGRAM_CHANNEL, { ordered: false, maxRetransmits: 0 }));
      this.step(async () => {
        await this.pc.setLocalDescription(await this.pc.createOffer());
        this.sendDescription("offer");
      });
    } else {
      this.pc.ondatachannel = (event) => {
        if (event.channel.label !== DATAGRAM_CHANNEL || this.channel) return event.channel.close();
        this.attach(event.channel);
      };
    }
  }

  /** Bytes given to `send` that the channel hasn't sent yet. */
  get bufferedAmount(): number {
    return this.channel?.bufferedAmount ?? 0;
  }

  /** Send one datagram. False when the lane isn't open (the caller sends it another way). */
  send(data: Uint8Array): boolean {
    if (this.state !== "open" || !this.channel) return false;
    try {
      this.channel.send(data as Uint8Array<ArrayBuffer>);
      return true;
    } catch {
      this.close("send failed");
      return false;
    }
  }

  /** A signalling message from the other end. */
  handleSignal(message: SignalMessage): void {
    if (this.state === "closed") return;
    if (++this.signals > MAX_SIGNALS) return this.close("too many signalling messages");
    if (message.t === "candidate") {
      if (!this.described) this.early.push(message);
      else this.step(() => this.addCandidate(message));
      return;
    }
    const expected = this.setup.role === "offer" ? "answer" : "offer";
    if (message.t !== expected || this.described) return this.close(`unexpected ${message.t}`);
    this.described = true; // candidates queued after this wait for it on the chain
    this.step(async () => {
      await this.pc.setRemoteDescription({ type: message.t, sdp: message.sdp });
      for (const early of this.early.splice(0)) await this.addCandidate(early);
      if (this.setup.role === "answer") {
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.sendDescription("answer");
      }
    });
  }

  close(reason = "closed"): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.reason = reason;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const channel = this.channel;
    this.channel = null;
    try {
      channel?.close();
    } catch {
      // Already closing.
    }
    try {
      this.pc.close();
    } catch {
      // Already closed.
    }
  }

  private attach(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      if (this.state !== "connecting") return;
      this.state = "open";
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    };
    channel.onclose = () => this.close("data channel closed");
    channel.onmessage = (event: MessageEvent) => {
      if (this.state !== "open") return;
      const data: unknown = event.data;
      if (data instanceof ArrayBuffer) this.callbacks.receive(new Uint8Array(data));
      else if (ArrayBuffer.isView(data)) this.callbacks.receive(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      // Text messages aren't part of the protocol; they're dropped like a lost datagram.
    };
  }

  private addCandidate(message: SignalMessage): Promise<void> {
    if (message.t !== "candidate") return Promise.resolve();
    return this.pc.addIceCandidate({ candidate: message.candidate, sdpMid: message.mid ?? undefined });
  }

  private sendDescription(t: "offer" | "answer"): void {
    const sdp = this.pc.localDescription?.sdp;
    if (!sdp || this.state === "closed") throw new Error(`no local ${t}`);
    this.callbacks.signal({ t, sdp: this.setup.rewriteCandidate ? rewriteSdpCandidates(sdp, this.setup.rewriteCandidate) : sdp });
    for (const candidate of this.unsent ?? []) this.callbacks.signal(candidate);
    this.unsent = null;
  }

  private rewrite(candidate: string): string {
    return this.setup.rewriteCandidate ? this.setup.rewriteCandidate(candidate) : candidate;
  }

  /** Run `work` after the signalling before it; a failure closes the lane. */
  private step(work: () => Promise<void>): void {
    this.chain = this.chain.then(async () => {
      if (this.state === "closed") return;
      try {
        await work();
      } catch (error) {
        this.close(`signalling failed: ${(error as Error).message}`);
      }
    });
  }
}

/** Apply `rewrite` to every `a=candidate:` line of an SDP. */
function rewriteSdpCandidates(sdp: string, rewrite: (candidate: string) => string): string {
  return sdp.replace(/^a=(candidate:[^\r\n]*)/gm, (_line, candidate: string) => `a=${rewrite(candidate)}`);
}

/**
 * A rewriter that puts `address` in every host candidate (`candidate:<foundation> <component>
 * <transport> <priority> <address> <port> typ host …`), for a server behind one-to-one NAT that
 * knows its public address. Other candidate types (srflx, relay) already carry outside addresses.
 */
export function hostCandidateRewriter(address: string): (candidate: string) => string {
  return (candidate) => {
    const parts = candidate.split(" ");
    if (parts.length < 8 || parts[6] !== "typ" || parts[7] !== "host") return candidate;
    parts[4] = address;
    return parts.join(" ");
  };
}
