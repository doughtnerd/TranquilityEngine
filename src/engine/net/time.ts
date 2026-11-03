/**
 * Network time (ADR 0033): ticks and round-trip time on Worlds joined by a transport. Read it as
 * `Time.network`, `this.time.network` or `ctx.time.network`. Kept up to date by the World's network
 * session (`session.ts`), which explains how clients estimate the server's tick.
 */
export interface NetworkTime {
  /** This World's simulation tick: fixed steps since it started simulating the networked game. */
  readonly tick: number;
  /** Clients: the server tick being predicted (ahead of the server by about RTT/2 plus the command slack, so inputs arrive in time). Servers: `tick`. */
  readonly serverTick: number;
  /** Clients: the tick remote objects are drawn at, behind the latest snapshot by the interpolation buffer. Servers: `tick`. */
  readonly interpolationTick: number;
  /** 0..1 progress between `interpolationTick` and the next tick. */
  readonly interpolationFraction: number;
  /** Clients: smoothed round-trip time in milliseconds. Servers: 0 (per-connection RTT is on each Connection). */
  readonly rtt: number;
  /** Fixed simulation ticks per second, shared by client and server. */
  readonly tickRate: number;
}
