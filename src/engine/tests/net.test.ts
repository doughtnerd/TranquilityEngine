import { describe, expect, it } from "vitest";
import { createTransport, listTransports, registerTransport, type Transport } from "../net/Transport";
import { defineInput, defineRpc } from "../net/messages";
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

  it("stubs RPCs and inputs until their tasks", () => {
    expect(() => defineRpc("test.Ping", { t: f32 })).toThrow(/T10/);
    expect(() => defineInput("test.Move", { x: f32 })).toThrow(/T12/);
  });
});

describe("loopback transport (T7)", () => {
  it.todo("delivers reliable messages in order and unreliable ones latest-wins");
  it.todo("applies simulated latency, jitter and loss (loss delays reliable messages instead of dropping them)");
});

describe("WebSocket transport (T9)", () => {
  it.todo("connects a headless client World to a headless server World over a real socket in Node");
});

describe("connections, ticks and RPCs (T10)", () => {
  it.todo("a connection appears as a node with net.Connection on both sides, and goes when it closes");
  it.todo("clients agree on the server tick within one tick at 100 ms simulated latency");
  it.todo("RPCs arrive as buffer rows tagged with their connection, both ways");
});

describe("replication (T11)", () => {
  it.todo("a server-moved replicated node appears smoothly on two clients under simulated loss");
  it.todo("spawns by prefab and despawns match on every client; scene nodes match by id");
  it.todo("per-World components aren't created in Worlds whose tags they exclude");
});

describe("inputs (T12)", () => {
  it.todo("server-side movement driven by client input matches the client's input history under loss");
});

describe("prediction (T13)", () => {
  it.todo("the owned node responds at once at 150 ms latency and converges on the server's state");
});
