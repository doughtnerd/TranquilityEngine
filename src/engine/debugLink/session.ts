// The build's end of a debug link (ADR 0376): one connection to a tool, its own protocol and session, never inside a
// game session (`net/session.ts`). It is driven by the frame, as transports are (ADR 0033: polled once per frame):
//
// - `frameStart()` polls the transport and handles what arrived: the tool's welcome, subscriptions, requests (answered
//   now), and commands, which are applied right after the poll, so every command lands at the frame start after it
//   arrived, before any World steps ("like any input").
// - `frameEnd(dt)` sends the samples that are due: each subscription at most at its topic's rate, on the unreliable
//   channel. Nothing is sent without a subscriber.
//
// Until the tool welcomes the build (after its accept prompt), the build only says hello and waits.
import type { Transport, TransportConnection } from "../net/Transport";
import { EnvelopeKind, decodeEnvelope, encodeEnvelope, jsonPayload, kindName, readJsonPayload, type DebugHello, type Envelope, type EnvelopeKindCode } from "./protocol";
import { RecordWriter } from "./records";
import type { DebugSubscription, DebugTopic } from "./topics";

/** A topic's default samples per second. */
export const DEFAULT_TOPIC_RATE = 30;

export type BuildSessionState = "connecting" | "waiting" | "accepted" | "closed";

export interface BuildSessionOptions {
  readonly transport: Transport;
  readonly connection: TransportConnection;
  readonly hello: DebugHello;
  /** The build's topics by name, loaded. */
  readonly topics: ReadonlyMap<string, DebugTopic>;
  /** Hears what the link wants to say (refusals, the tool going away). */
  readonly log?: (line: string) => void;
}

interface Subscription {
  readonly topic: string;
  readonly rate: number;
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

  /** Subscriptions live now. */
  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  /** Handles what arrived, then applies its commands. Call at every frame start, before the Worlds step. */
  frameStart(): void {
    if (this.status === "closed") return;
    const commands: Envelope[] = [];
    for (const event of this.options.transport.poll()) {
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
      try {
        sub.live.sample(this.writer, this.frame);
      } catch (err) {
        this.writer.take();
        this.log(`the "${sub.topic}" topic failed to sample: ${(err as Error)?.message ?? err}`);
        continue;
      }
      if (this.writer.count === 0) continue;
      this.send("unreliable", { kind: EnvelopeKind.sample, topic: sub.topic, id, payload: this.writer.take() });
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
      this.subscriptions.set(e.id, { topic: e.topic, rate, live: made, elapsed: Infinity });
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
