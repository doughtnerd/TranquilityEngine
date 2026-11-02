/**
 * Transports (ADR 0033): how bytes move between Worlds. Internal to the engine; game code sees
 * connections and RPCs, never sockets. Transports are polled once per World frame instead of
 * calling back, which fits the frame loop and the engine's no-event-system rule (ADR 0017).
 *
 * Implementations: loopback (T7), WebSocket (T9). WebRTC comes later, with a signalling server.
 */

/**
 * `reliable`: every message arrives, in order (RPCs, spawns, acks).
 * `unreliable`: messages may be lost; stale ones (older than the newest received) are dropped
 * (snapshots, inputs).
 */
export type Channel = "reliable" | "unreliable";

export type ConnectionState = "connecting" | "open" | "closed";

/** One end of a connection between two Worlds. */
export interface TransportConnection {
  /** Unique per transport instance. */
  readonly id: number;
  /** Human-readable peer address, for logs and the network panel. */
  readonly remote: string;
  readonly state: ConnectionState;
  /** Queue a message. Throws if the connection is closed. Large reliable messages are split by the transport. */
  send(channel: Channel, data: Uint8Array): void;
  close(reason?: string): void;
}

/** What happened since the last `poll()`. */
export type TransportEvent =
  | { kind: "open"; connection: TransportConnection }
  | { kind: "data"; connection: TransportConnection; channel: Channel; data: Uint8Array }
  | { kind: "close"; connection: TransportConnection; reason: string };

/** A transport endpoint owned by one World. A server listens; a client connects. */
export interface Transport {
  /** Server side: start accepting connections at `address` (meaning is transport-specific). */
  listen(address: string): Promise<void>;
  /** Client side: start connecting. The connection opens later (an `open` event from `poll`). */
  connect(address: string): TransportConnection;
  /** Everything that happened since the last call, in order. Called once per World frame. */
  poll(): TransportEvent[];
  /** Close every connection and stop listening. */
  close(): void;
}

/** Simulated network conditions (the loopback, and the editor's network sliders). */
export interface LinkConditions {
  /** One-way delay in milliseconds. */
  latencyMs?: number;
  /** Random extra delay, 0..jitterMs. */
  jitterMs?: number;
  /** Probability 0..1 that an unreliable message is dropped. Reliable ones are delayed instead (as by a retransmit). */
  loss?: number;
}

export type TransportFactory = (options: Record<string, unknown>) => Transport;

const factories = new Map<string, TransportFactory>();

/** Make a transport available by name to bootstrap links and `WorldHandle.connect`. */
export function registerTransport(name: string, factory: TransportFactory): void {
  factories.set(name, factory);
}

/** Create a transport by name. Throws, naming the registered ones, if there's no such transport. */
export function createTransport(name: string, options: Record<string, unknown> = {}): Transport {
  const factory = factories.get(name);
  if (!factory) throw new Error(`There's no transport "${name}" (registered: ${[...factories.keys()].join(", ") || "none"}).`);
  return factory(options);
}

/** @internal Registered transport names (for the Worlds panel). */
export function listTransports(): string[] {
  return [...factories.keys()];
}
