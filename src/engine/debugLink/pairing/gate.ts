// The token gate (ADR 0403 "Pairing code"): the listening (or waiting) side's check of the token in a connection's
// first message. 0403's rules, each one this gate implements:
//
// - "single use, expiring after 5 minutes": a token admits one connection; the code shown changes after it is used,
//   and after 5 minutes unused (`TOKEN_EXPIRY_MS`). The plan adds: the gate issues the next code itself after a use or
//   an expiry, so the overlay and the Connect dialog always show one that works (plan §12 finding 11).
// - "The token is checked in the connection's first message. Five wrong tokens lock a listener's LAN connections for a
//   minute" (`MAX_FAILURES`, `LOCK_MS`): while locked, every connection from another machine is refused (`locked`),
//   even with the right token; the count starts again when the lock ends, and a valid token resets it.
// - "Connections from the same machine need no code, as today": a same-machine connection is admitted with or without
//   a token, is never counted as a failure, never locked out and never uses the token up.
// - 0376's accept prompt stays for a tokenless connection from another machine: the gate answers `prompt` and the
//   caller asks (or, with nobody to ask, refuses with `no-token`). A tokenless connection is not a failure.
//
// A wrong token, an expired one and a used one are all failures (the reason differs only for the message). Time comes
// only from the injected clock, so tests step it.
import type { PairRefusalReason } from "../protocol";
import { PAIR_TOKEN_BITS } from "./code";

/** How long a token works unused, ms (0403: "expiring after 5 minutes"). */
export const TOKEN_EXPIRY_MS = 5 * 60_000;
/** Wrong tokens that lock LAN connections (0403: "Five wrong tokens"). */
export const MAX_FAILURES = 5;
/** How long the lock lasts, ms (0403: "for a minute"). */
export const LOCK_MS = 60_000;

/** One issued token. */
export interface IssuedToken {
  /** The token, 0..2^bits-1; the caller puts it in a code (`code.ts`). */
  readonly token: number;
  /** When it was issued and when it stops working, in the clock's ms. */
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** 1 for the first token, one more for each issued after it, so a view can tell a new code from the same one. */
  readonly serial: number;
}

export interface TokenGateOptions {
  /** The clock, ms (`performance.now()` in a build; a stepped value in tests). */
  now(): number;
  /** A uniformly random whole number in 0..2^bits-1 (`crypto.getRandomValues` in a build; a seeded source in tests). */
  randomToken(bits: number): number;
  /** Token bits: 30 for address codes and hosted room codes, 20 for LAN room codes (`code.ts`). Default 30. */
  readonly tokenBits?: number;
  /** Hears each token the gate issues (the first, and each after a use or an expiry), to show its code. */
  onIssued?(token: IssuedToken): void;
}

/** Where a connection comes from. */
export interface GateCaller {
  /** Whether the connection comes from this machine (loopback, or one of its own addresses). */
  readonly sameMachine: boolean;
}

/**
 * The gate's verdict on one connection:
 * - `admit`: let it in (`via` `token`: the current token, now used, and the next one issued; `same-machine`: no token
 *   needed);
 * - `prompt`: tokenless from another machine: ask a person (0376), or refuse with `no-token` when nobody can be asked;
 * - `refuse`: answer `paired` with the reason and close.
 */
export type GateVerdict =
  | { readonly verdict: "admit"; readonly via: "token" | "same-machine" }
  | { readonly verdict: "prompt" }
  | { readonly verdict: "refuse"; readonly reason: Extract<PairRefusalReason, "bad-token" | "expired" | "used" | "locked"> };

/** A listener's token gate. */
export class TokenGate {
  private readonly options: TokenGateOptions;
  private readonly bits: number;
  /** Tokens that stopped working, and why: a refused one says `used` or `expired`, anything else is `bad-token`. */
  private readonly retired = new Map<number, "used" | "expired">();
  private issued!: IssuedToken;
  private serial = 0;
  private failures = 0;
  /** The clock time the lock ends at, or null when LAN connections are not locked. */
  private lockEnd: number | null = null;

  constructor(options: TokenGateOptions) {
    this.options = options;
    this.bits = options.tokenBits ?? PAIR_TOKEN_BITS;
    this.issue(options.now());
  }

  /** The token to show now; a token that expired is replaced (and `onIssued` hears the new one) before it is returned. */
  current(): IssuedToken {
    this.refresh(this.options.now());
    return this.issued;
  }

  /** Whether LAN connections are locked now, and until when (clock ms); null when not locked. */
  lockedUntil(): number | null {
    return this.lockState(this.options.now());
  }

  /** Checks a connection's token (undefined: it sent none), applying the rules above. */
  check(token: number | undefined, from: GateCaller): GateVerdict {
    const now = this.options.now();
    if (from.sameMachine) return { verdict: "admit", via: "same-machine" };
    this.refresh(now);
    if (this.lockState(now) !== null) return { verdict: "refuse", reason: "locked" };
    if (token === undefined) return { verdict: "prompt" };
    if (token === this.issued.token) {
      this.retired.set(token, "used");
      this.failures = 0;
      this.issue(now);
      return { verdict: "admit", via: "token" };
    }
    const reason = this.retired.get(token) ?? "bad-token";
    this.failures += 1;
    if (this.failures >= MAX_FAILURES) this.lockEnd = now + LOCK_MS;
    return { verdict: "refuse", reason };
  }

  /** Issues the next token once the current one has expired; the expired one is remembered so it is refused as expired. */
  private refresh(now: number): void {
    if (now < this.issued.expiresAt) return;
    this.retired.set(this.issued.token, "expired");
    this.issue(now);
  }

  /** The lock's end, or null when not locked; a lock that has ended starts the failure count again from zero. */
  private lockState(now: number): number | null {
    if (this.lockEnd === null) return null;
    if (now < this.lockEnd) return this.lockEnd;
    this.lockEnd = null;
    this.failures = 0;
    return null;
  }

  private issue(now: number): void {
    const token = this.options.randomToken(this.bits);
    this.retired.delete(token);
    this.serial += 1;
    this.issued = { token, issuedAt: now, expiresAt: now + TOKEN_EXPIRY_MS, serial: this.serial };
    this.options.onIssued?.(this.issued);
  }
}
