import { describe, expect, it } from "vitest";
import { createTransport, listTransports, registerTransport, type Transport } from "../net/Transport";

// ADR 0033. The contract (wave 0) is tested here; each `todo` is a task's "done when" from
// docs/architecture/worlds-and-netcode-plan.md, for the implementer to fill in.

describe("the netcode contract (C2)", () => {
  it("creates transports by registered name, and names the choices when there's none", () => {
    const fake: Transport = { listen: async () => {}, connect: () => { throw new Error("no"); }, poll: () => [], close: () => {} };
    registerTransport("test.fake", () => fake);
    expect(createTransport("test.fake")).toBe(fake);
    expect(listTransports()).toContain("test.fake");
    expect(() => createTransport("nope")).toThrow(/There's no transport "nope" \(registered: .*test\.fake/);
  });
});

// Connections, ticks and RPCs (T10) are tested in session.test.ts and sessionWebSocket.test.ts;
// input streams (T12) in input.test.ts.

describe("replication (T11)", () => {
  it.todo("a server-moved replicated node appears smoothly on two clients under simulated loss");
  it.todo("spawns by prefab and despawns match on every client; scene nodes match by id");
  it.todo("per-World components aren't created in Worlds whose tags they exclude");
});

describe("prediction (T13)", () => {
  it.todo("the owned node responds at once at 150 ms latency and converges on the server's state");
});
