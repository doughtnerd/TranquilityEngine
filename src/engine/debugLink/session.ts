// The build's end of a debug link (ADR 0376): one connection to a tool, its own protocol and session, never inside a
// game session (`net/session.ts`). It is driven by the frame, as transports are (ADR 0033: polled once per frame):
//
// - `frameStart()` polls the transport and handles what arrived: the tool's welcome, subscriptions, requests (answered
//   now), and commands, which are applied right after the poll, so every command lands at the frame start after it
//   arrived, before any World steps ("like any input").
// - `frameEnd(dt)` sends the samples that are due: each subscription at most at its topic's rate, on its topic's channel
//   (`DebugTopic.channel`, unreliable by default). Nothing is sent without a subscriber.
//
// Until the tool welcomes the build (after its accept prompt), the build only says hello and waits.
//
// **Either direction (ADR 0403).** A build that connects out sends `pair` (role build, its kind, the token of the code it
// was given) and then `hello` at once, without waiting for `paired` (`BuildSessionOptions.pair`): the tool answers the
// pair before it reads the hello, so the order the tool acts in is C1's, and a build reaches a tool in the same number
// of frames as before. A `paired` refusal closes the session with its sentence (`refusal`). A build that listens
// (`host.ts`'s `BuildListener`) answers the tool's `pair` itself and starts the session afterwards, without `pair`: the
// session then just says hello. A listener polls one transport for many connections, so it hands each session its own
// events (`frameStart(events)`); a session on a transport of its own polls it.
//
// **Reliable topics send several messages a frame** (the W0 review's question, for A2's take upload). On a due frame a
// `reliable` topic's subscription is sampled again, up to `RELIABLE_SAMPLES_PER_FRAME` times, while each call writes
// records; each call's records go as one message (so a topic that writes one 64 KiB chunk per call sends 64 KiB
// messages, plan §7a). An unreliable topic is sampled once per due frame: a second picture of the same frame is worth
// nothing. The bound keeps one subscription from flooding a socket: at the default 30 Hz it allows 8 x 64 KiB x 30 =
// about 15.7 MB/s, so a 32 MB profile ring uploads in about 2 s and the 256 MiB take cap in about 17 s.
import type { Transport, TransportConnection, TransportEvent } from "../net/Transport";
import {
  EnvelopeKind,
  decodeEnvelope,
  encodeEnvelope,
  jsonPayload,
  kindName,
  pairEnvelope,
  readJsonPayload,
  readPairReply,
  type DebugHello,
  type DebugPair,
  type DebugPairReply,
  type Envelope,
  type EnvelopeKindCode,
} from "./protocol";
import { RecordWriter } from "./records";
import type { DebugSubscription, DebugTopic } from "./topics";

/** A topic's default samples per second. */
export const DEFAULT_TOPIC_RATE = 30;
/** The most messages one subscription to a `reliable` topic sends in a due frame (see the head of this file). */
export const RELIABLE_SAMPLES_PER_FRAME = 8;

export type BuildSessionState = "connecting" | "waiting" | "accepted" | "closed";

export interface BuildSessionOptions {
  readonly transport: Transport;
  readonly connection: TransportConnection;
  readonly hello: DebugHello;
  /** The build's topics by name, loaded. */
  readonly topics: ReadonlyMap<string, DebugTopic>;
  /** Hears what the link wants to say (refusals, the tool going away). */
  readonly log?: (line: string) => void;
  /**
   * The `pair` a connecting build sends right before its hello (ADR 0403, C1). Absent: the session says hello only, as a
   * version 1 build did (a listening tool reads that as a tokenless build), or as a listening build does once it has
   * answered the tool's pair.
   */
  readonly pair?: DebugPair;
}

interface Subscription {
  readonly topic: string;
  readonly rate: number;
  readonly channel: "reliable" | "unreliable";
  readonly live: DebugSubscription;
  /** Seconds since its last sample; starts due. */
  elapsed: number;
}

/** @internal A build's link session over one connection. */
export class DebugLinkSession {
  private status: BuildSessionState = "connecting";
  private readonly subscriptions = new Map<number, Subscription>();
  private readonly writer = new RecordWriter();
  private frame = 0;
  private reason = "";
  private pairReply: DebugPairReply | null = null;

  constructor(private readonly options: BuildSessionOptions) {
    if (options.connection.state === "open") this.opened();
  }

  get state(): BuildSessionState {
    return this.status;
  }

  /** Why the session closed ("" while it's open). */
  get closedReason(): string {
    return this.reason;
  }

  /** The tool's answer to this build's `pair`: null before it arrives, or when the session sent none. */
  get paired(): DebugPairReply | null {
    return this.pairReply;
  }

  /** The tool's refusal of this build's `pair` (the session closed after it), or null. */
  get refusal(): Extract<DebugPairReply, { accepted: false }> | null {
    return this.pairReply && !this.pairReply.accepted ? this.pairReply : null;
  }

  /** Subscriptions live now. */
  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Handles what arrived, then applies its commands. Call at every frame start, before the Worlds step. `events`: this
   * connection's events, from a listener that polls one transport for every connection; absent, the session polls the
   * transport itself.
   */
  frameStart(events?: Iterable<TransportEvent>): void {
    if (this.status === "closed") return;
    const commands: Envelope[] = [];
    for (const event of events ?? this.options.transport.poll()) {
      if (event.connection !== this.options.connection) continue;
      if (event.kind === "open") this.opened();
      else if (event.kind === "close") this.closed(event.reason);
      else {
        const decoded = decodeEnvelope(event.data);
        if ("refused" in decoded) {
          // Not this protocol (a malformed envelope, another version): say so, then close (ADR 0376).
          this.send("reliable", { kind: EnvelopeKind.error, topic: "", id: 0, payload: jsonPayload({ message: decoded.refused }) });
          this.log(`closing: ${decoded.refused}`);
          this.close(`The build closed the debug link: ${decoded.refused}`);
          return;
        }
        const e = decoded.envelope;
        if (e.kind === EnvelopeKind.command) commands.push(e);
        else this.handle(e);
      }
      if ((this.status as BuildSessionState) === "closed") return; // the poll may close it
    }
    for (const e of commands) this.applyCommand(e);
  }

  /** Sends what's due after a frame of `dt` real seconds. Call at every frame end. */
  frameEnd(dt: number): void {
    if (this.status !== "accepted") return;
    this.frame++;
    for (const [id, sub] of this.subscriptions) {
      sub.elapsed += Math.max(0, dt);
      if (sub.elapsed + 1e-9 < 1 / sub.rate && sub.elapsed !== Infinity) continue;
      sub.elapsed = 0;
      const calls = sub.channel === "reliable" ? RELIABLE_SAMPLES_PER_FRAME : 1;
      for (let i = 0; i < calls; i++) {
        try {
          sub.live.sample(this.writer, this.frame);
        } catch (err) {
          this.writer.take();
          this.log(`the "${sub.topic}" topic failed to sample: ${(err as Error)?.message ?? err}`);
          break;
        }
        if (this.writer.count === 0) break;
        this.send(sub.channel, { kind: EnvelopeKind.sample, topic: sub.topic, id, payload: this.writer.take() });
      }
    }
  }

  /** Ends the session: its subscriptions close and the connection closes. */
  close(reason = "The build closed the debug link."): void {
    if (this.status === "closed") return;
    if (this.options.connection.state !== "closed") this.options.connection.close(reason);
    this.closed(reason);
  }

  private opened(): void {
    if (this.status !== "connecting") return;
    this.status = "waiting";
    if (this.options.pair) this.send("reliable", pairEnvelope(this.options.pair));
    this.send("reliable", { kind: EnvelopeKind.hello, topic: "", id: 0, payload: jsonPayload(this.options.hello) });
  }

  private closed(reason: string): void {
    if (this.status === "closed") return;
    this.status = "closed";
    this.reason = reason;
    for (const sub of this.subscriptions.values()) sub.live.close();
    this.subscriptions.clear();
  }

  private handle(e: Envelope): void {
    if (e.kind === EnvelopeKind.paired) {
      if (!this.options.pair || this.pairReply || this.status !== "waiting") return this.error(e, "this build didn't ask to pair");
      const read = readJsonPayload(e.payload);
      const reply = "refused" in read ? read : readPairReply(read.value);
      if ("refused" in reply) {
        const line = `The tool's answer to the pairing didn't make sense (${reply.refused}).`;
        this.log(line);
        this.close(line);
        return;
      }
      this.pairReply = reply.reply;
      if (!reply.reply.accepted) {
        this.log(`the tool refused the pairing: ${reply.reply.message}`);
        this.close(reply.reply.message);
      }
      return;
    }
    if (e.kind === EnvelopeKind.welcome) {
      if (this.status === "waiting") this.status = "accepted";
      return;
    }
    if (e.kind === EnvelopeKind.error) {
      const read = readJsonPayload(e.payload);
      const message = "value" in read && read.value && typeof (read.value as { message?: unknown }).message === "string" ? (read.value as { message: string }).message : "an error";
      this.log(`the tool said: ${message}`);
      return;
    }
    if (this.status !== "accepted") return this.error(e, "the tool hasn't accepted this build yet");
    if (e.kind === EnvelopeKind.unsubscribe) {
      const sub = this.subscriptions.get(e.id);
      if (sub && sub.topic === e.topic) {
        this.subscriptions.delete(e.id);
        sub.live.close();
      }
      return;
    }
    if (e.kind !== EnvelopeKind.subscribe && e.kind !== EnvelopeKind.request) return this.error(e, `a build doesn't take ${kindName(e.kind)} messages`);
    const topic = this.options.topics.get(e.topic);
    if (!topic) return this.error(e, `this build has no "${e.topic}" topic`);
    const params = readJsonPayload(e.payload);
    if ("refused" in params) return this.error(e, params.refused);
    if (e.kind === EnvelopeKind.subscribe) {
      this.subscriptions.get(e.id)?.live.close();
      this.subscriptions.delete(e.id);
      let made: ReturnType<DebugTopic["subscribe"]>;
      try {
        made = topic.subscribe(params.value);
      } catch (err) {
        return this.error(e, (err as Error)?.message ?? String(err));
      }
      if ("refused" in made) return this.error(e, made.refused);
      const rate = topic.rate !== undefined && Number.isFinite(topic.rate) && topic.rate > 0 ? topic.rate : DEFAULT_TOPIC_RATE;
      this.subscriptions.set(e.id, { topic: e.topic, rate, channel: topic.channel === "reliable" ? "reliable" : "unreliable", live: made, elapsed: Infinity });
      return;
    }
    const body = (params.value ?? {}) as { method?: unknown; params?: unknown };
    if (typeof body.method !== "string" || !topic.request) return this.error(e, `the "${e.topic}" topic doesn't answer that request`);
    let result: unknown;
    try {
      result = topic.request(body.method, body.params);
    } catch (err) {
      return this.error(e, (err as Error)?.message ?? String(err));
    }
    const answer = (value: unknown) => this.reply(e, EnvelopeKind.reply, value === undefined ? null : value);
    // A plain result is answered in this frame; a promise when it settles.
    if (result && typeof (result as PromiseLike<unknown>).then === "function") (result as PromiseLike<unknown>).then(answer, (err: unknown) => this.error(e, (err as Error)?.message ?? String(err)));
    else answer(result);
  }

  private applyCommand(e: Envelope): void {
    if (this.status !== "accepted") return this.error(e, "the tool hasn't accepted this build yet");
    const topic = this.options.topics.get(e.topic);
    if (!topic?.command) return this.error(e, `this build has no "${e.topic}" topic that takes commands`);
    const read = readJsonPayload(e.payload);
    if ("refused" in read) return this.error(e, read.refused);
    const body = (read.value ?? {}) as { name?: unknown; params?: unknown };
    if (typeof body.name !== "string") return this.error(e, "a command needs a name");
    try {
      topic.command(body.name, body.params);
    } catch (err) {
      this.error(e, (err as Error)?.message ?? String(err));
    }
  }

  private reply(to: Envelope, kind: EnvelopeKindCode, value: unknown): void {
    let payload: Uint8Array;
    try {
      payload = jsonPayload(value);
    } catch (err) {
      return this.error(to, `the reply couldn't be encoded: ${(err as Error)?.message ?? err}`);
    }
    this.send("reliable", { kind, topic: to.topic, id: to.id, payload });
  }

  private error(to: Envelope, message: string): void {
    this.send("reliable", { kind: EnvelopeKind.error, topic: to.topic, id: to.id, payload: jsonPayload({ message }) });
  }

  private send(channel: "reliable" | "unreliable", e: Envelope): void {
    if (this.status === "closed" || this.options.connection.state !== "open") return;
    this.options.connection.send(channel, encodeEnvelope(e));
  }

  private log(line: string): void {
    this.options.log?.(`[myco] debug link: ${line}`);
  }
}

/** A transport's remote address without its port ("192.168.1.20:51234" → "192.168.1.20", "[::1]:5" → "::1"). */
function remoteHost(remote: string): string {
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(remote);
  if (bracket) return bracket[1]!;
  // A server names a peer `address:port` (an IPv6 address unbracketed): the port is the last part.
  const port = /^(.+):\d+$/.exec(remote);
  return port && !port[1]!.endsWith(":") ? port[1]! : remote;
}

/**
 * @internal Whether a connection whose transport names its far end `remote` comes from this machine (ADR 0403: "Connections
 * from the same machine need no code"): a loopback address, an in-process loopback link, or one of `ownAddresses` (the
 * machine's interface addresses). Both listening sides (`host.ts`'s build listener, `client.ts`'s tool listener) decide
 * the accept rule with it.
 */
export function sameMachineRemote(remote: string, ownAddresses: readonly string[] = []): boolean {
  if (remote.startsWith("loopback-")) return true;
  const host = remoteHost(remote).toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  if (host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  return ownAddresses.some((a) => a.toLowerCase() === host);
}
