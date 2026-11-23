// The token gate (ADR 0380; plan task L3): single use, the next code issued after a use or an expiry, 5-minute expiry,
// 5 failures lock LAN connections for 60 s, same-machine bypass, all on an injected clock. Skipped until L3 fills
// `gate.ts`.
import { describe, it } from "vitest";
import "./gate";

describe("the token gate", () => {
  it.skip("issues a first token at once and tells onIssued", () => {});
  it.skip("admits the current token once (via token), then issues the next one; the used token is refused as used", () => {});
  it.skip("expires a token after 5 minutes on the clock: current() issues the next one, the old one is refused as expired", () => {});
  it.skip("refuses a wrong token as bad-token", () => {});
  it.skip("locks LAN connections for 60 s after 5 failures: even the right token is refused as locked", () => {});
  it.skip("counts again from zero once the lock ends; a valid token resets the count", () => {});
  it.skip("admits a same-machine connection with no token, a wrong token, or while locked, without using the token or counting a failure", () => {});
  it.skip("answers prompt for a tokenless connection from another machine, without counting a failure", () => {});
  it.skip("draws tokens of tokenBits bits (30 by default, 20 for a LAN room code)", () => {});
});
