import { describe, expect, it } from "vitest";
import { createTransport, listTransports, registerTransport, type Transport } from "../net/Transport";
import { defineInput } from "../net/messages";
import { f32 } from "../index";

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

  it("stubs inputs until their task", () => {
    expect(() => defineInput("test.Move", { x: f32 })).toThrow(/T12/);
  });
});

// Connections, ticks and RPCs (T10) are tested in session.test.ts and sessionWebSocket.test.ts;
// replication and per-World components (T11) in replication.test.ts.

describe("inputs (T12)", () => {
  it.todo("server-side movement driven by client input matches the client's input history under loss");
});

describe("prediction (T13)", () => {
  it.todo("the owned node responds at once at 150 ms latency and converges on the server's state");
});
