// The rendezvous's messages (ADR 0380 "Rendezvous"; plan task R1). Skipped until R1 fills the codecs in `protocol.ts`.
import { describe, it } from "vitest";
import "./protocol";

describe("the rendezvous messages", () => {
  it.skip("round-trips every client message: join (each seat and endpoint kind), offer, answer, candidate, end of candidates, connected, leave", () => {});
  it.skip("round-trips every server message: joined, peer-joined, peer-left, the three signals, error (each reason), expired", () => {});
  it.skip("refuses JSON that isn't an object, an unknown type, or a field of the wrong type (bad-message)", () => {});
  it.skip("refuses a message past RENDEZVOUS_MAX_MESSAGE_BYTES (too-big), and won't encode one", () => {});
  it.skip("refuses bytes that aren't UTF-8", () => {});
  it.skip("reads a join of another version (the server answers version)", () => {});
});
