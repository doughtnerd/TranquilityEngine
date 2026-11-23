// Path choice (ADR 0380 "Which path each pair takes"; plan task L5): one case per row of the pair table, and the rules
// around it. Skipped until L5 fills `path.ts`.
import { describe, it } from "vitest";
import "./path";

describe("path choice", () => {
  it.skip("native ↔ native: WebSocket, either side listening", () => {});
  it.skip("native ↔ native where only one side can listen: WebSocket to that side", () => {});
  it.skip("page on http ↔ native: WebSocket to the native listener, from either end", () => {});
  it.skip("page on http ↔ page on http: WebRTC through the LAN rendezvous (the serving server or a native app's)", () => {});
  it.skip("page on http ↔ page on http without a LAN rendezvous: the hosted one, else unreachable (needs-rendezvous)", () => {});
  it.skip("page on https ↔ anything: WebRTC through the hosted rendezvous, else unreachable (needs-hosted-rendezvous)", () => {});
  it.skip("page on https never takes a LAN rendezvous, even when one is known (mixed content)", () => {});
  it.skip("a native side that can't listen makes its pair use WebRTC through a rendezvous", () => {});
  it.skip("a side without WebRTC that needs it makes the pair unreachable (no-webrtc); a WebSocket pair doesn't need it", () => {});
  it.skip("is symmetric: swapping local and remote swaps only the listener side", () => {});
});
