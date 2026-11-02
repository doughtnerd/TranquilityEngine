import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Assets,
  Engine,
  GameBehavior,
  GameObject,
  Replicated,
  Transform,
  behavior,
  defineComponent,
  defineInput,
  defineSystem,
  f32,
  field,
  i32,
  isResimulating,
  predictedTick,
  replicate,
  type BootstrapConfig,
  type LinkConfig,
} from "../index";
import { World } from "../core/World";
import { netSession } from "../net/session";
import { clientReplication } from "../net/replication/client";
import { clientPrediction, predictionStats, type PredictionStats } from "../net/prediction";

// ADR 0033 §6, T13: client prediction with rollback and re-simulation, over the loopback transport
// on a fake clock that advances with `engine.step`, so everything is deterministic.

let clock = 0;
const now = () => clock;
const DT = 1 / 60;
const engines: Engine[] = [];

afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  vi.restoreAllMocks();
});

function step(engine: Engine, frames = 1, after?: () => void): void {
  for (let i = 0; i < frames; i++) {
    clock += DT * 1000;
    engine.step(DT);
    after?.();
  }
}

/** A deterministic 0..1 sequence. */
function sequenceRandom(seed = 0.37): () => number {
  let x = seed;
  return () => (x = (x * 9301 + 0.49297) % 1);
}

/** The player's velocity: predicted. */
const Body = defineComponent("test.pred.Body", { vx: f32, pushes: i32 });
replicate(Body, { predicted: ["vx"] });

/** A behavior field the predicted system changes: predicted too. */
@behavior("test.pred.Fuel")
class Fuel extends GameBehavior {
  @field(Number, { predicted: true }) fuel = 1000;
}

const Steer = defineInput("test.pred.Steer", { x: i32 });

/** The input every client writes for a server tick: -1, 0 or 1, changing every 7 ticks. */
const inputFor = (tick: number) => [-1, 0, 1][Math.floor(tick / 7) % 3];
const SPEED = 0.25;

/** Per client World: what it wrote by tick; and what the predicted system ran, re-simulating or not. */
const written = new Map<string, Map<number, number>>();
const runs = new Map<string, { tick: number; x: number | null; resim: boolean }[]>();
/** Rows the predicted system saw, per World. */
const rowsSeen = new Map<string, number>();
/** Per test: server state by tick. */
let serverLog = new Map<number, { x: number; vx: number; fuel: number }>();
let writing = true;
/** Set by a test to change the input from a given tick on. */
let inputOverride: ((tick: number) => number | undefined) | null = null;

defineSystem({
  name: "test.pred.write",
  phase: "fixedUpdate",
  worlds: ["client"],
  run(_rows, ctx) {
    if (!writing) return;
    const tick = ctx.time.network!.serverTick;
    const x = inputOverride?.(tick) ?? inputFor(tick);
    Steer.write({ x });
    let log = written.get(ctx.world.name);
    if (!log) written.set(ctx.world.name, (log = new Map()));
    log.set(tick, x);
  },
});

defineSystem({
  name: "test.pred.move",
  phase: "fixedUpdate",
  predicted: true,
  worlds: ["client", "server"],
  query: [Transform, Body],
  run(rows, ctx) {
    for (const row of rows) {
      const input = Steer.of(row.node);
      rowsSeen.set(ctx.world.name, (rowsSeen.get(ctx.world.name) ?? 0) + 1);
      if (netSession(ctx.world)?.isClient) {
        let log = runs.get(ctx.world.name);
        if (!log) runs.set(ctx.world.name, (log = []));
        log.push({ tick: predictedTick(), x: input?.x ?? null, resim: isResimulating() });
      }
      if (!input) continue;
      row.transform.position.x += input.x * SPEED;
      row.node.getData(Body)!.vx = input.x;
      const fuel = row.node.getBehavior(Fuel);
      if (fuel) fuel.fuel -= Math.abs(input.x);
    }
  },
});

defineSystem({
  name: "test.pred.log",
  phase: "lateUpdate",
  worlds: ["server"],
  run(_rows, ctx) {
    const session = netSession(ctx.world)!;
    for (const rep of ctx.world._componentsOfType(Replicated)) {
      const node = rep.node;
      if (!node.getData(Body)) continue;
      serverLog.set(session.tick, { x: node.transform!.position.x, vx: node.getData(Body)!.vx, fuel: node.getBehavior(Fuel)!.fuel });
    }
  },
});

Assets.addSource(
  Assets.fromObject({
    "prefabs/pred-player.json": {
      format: "tranquility.scene@1",
      nodes: [
        {
          id: "player",
          name: "Player",
          components: [
            { type: "net.Replicated", data: { mode: "predicted" } },
            { type: "engine.Transform", data: { position: [0, 0, 0] } },
            { type: "test.pred.Body", data: { vx: 0, pushes: 0 } },
            { type: "test.pred.Fuel" },
          ],
        },
      ],
    },
  }),
);

async function create(bootstrap: BootstrapConfig): Promise<Engine> {
  const engine = await Engine.create({ headless: true, bootstrap });
  engines.push(engine);
  return engine;
}

/** Client Worlds `P1`, `P2`… linked to `Server` over loopback with `options`. */
function clientsAndServer(count: number, options: Record<string, unknown> = {}): BootstrapConfig {
  const names = Array.from({ length: count }, (_, i) => `P${i + 1}`);
  const links: LinkConfig[] = names.map((n, i) => ({ from: n, to: "Server", transport: "loopback", options: { now, random: sequenceRandom(0.11 + i * 0.2), ...options } }));
  return { worlds: [...names.map((name) => ({ name, tags: ["client"] })), { name: "Server", tags: ["server"] }], links };
}

function world(engine: Engine, name: string): World {
  return engine._world(name)!;
}

/** A started game: P1 owns a predicted player the server spawned; settled for 3 s. */
async function start(options: Record<string, unknown>, clients = 1) {
  written.clear();
  runs.clear();
  serverLog = new Map();
  writing = true;
  inputOverride = null;
  const engine = await create(clientsAndServer(clients, options));
  const server = world(engine, "Server");
  const session = clientReplication(world(engine, "P1"))!.session;
  for (let i = 0; i < 120 && session.serverPeer?.state !== "open"; i++) step(engine);
  const p1Id = session.serverPeer!.id;
  expect(p1Id).toBeGreaterThan(0);
  const player = World._runIn(server, () => GameObject.instantiate("prefabs/pred-player.json"));
  World._runIn(server, () => (player.getBehavior(Replicated)!.ownerId = p1Id));
  step(engine, 180);
  return { engine, server, player };
}

/** A client World's ghost of the player. */
function ghostIn(engine: Engine, name: string): GameObject {
  for (const g of clientReplication(world(engine, name))!.ghosts.values()) if (g.binding) return g.binding.node;
  throw new Error(`no ghost in ${name}`);
}

/** The player's state as P1 predicts it, after each step, by its newest predicted tick. */
function trackClient(engine: Engine) {
  const log = new Map<number, { x: number; vx: number; fuel: number }>();
  const p1 = world(engine, "P1");
  return {
    log,
    sample: () => {
      const ghost = ghostIn(engine, "P1");
      log.set(clientPrediction(p1)!.lastSimulated, { x: ghost.transform!.position.x, vx: ghost.getData(Body)!.vx, fuel: ghost.getBehavior(Fuel)!.fuel });
    },
  };
}

const stats = (engine: Engine, name = "P1") => predictionStats(world(engine, name))!;
const delta = (a: PredictionStats, b: PredictionStats) => Object.fromEntries(Object.keys(a).map((k) => [k, (b as never)[k] - (a as never)[k]])) as unknown as PredictionStats;

/** The server's state for `tick` equals P1's prediction for it. */
function expectSame(client: { x: number; vx: number; fuel: number } | undefined, server: { x: number; vx: number; fuel: number } | undefined, what: string): void {
  expect(client, what).toBeDefined();
  expect(server, what).toBeDefined();
  expect(client!.x, what).toBeCloseTo(server!.x, 6);
  expect(client!.vx, what).toBe(server!.vx);
  expect(client!.fuel, what).toBeCloseTo(server!.fuel, 4);
}

describe("client prediction (T13)", () => {
  it("moves the owned player on the tick it's input at 150 ms latency, and matches the server exactly", async () => {
    const { engine, server } = await start({ latencyMs: 150 });
    const serverSession = netSession(server)!;
    const p1 = world(engine, "P1");
    const client = trackClient(engine);
    const before = stats(engine);

    // From tick T0 on the input is +1: the client moves on T0 itself, long before the server gets there.
    const T0 = clientPrediction(p1)!.lastSimulated + 10;
    inputOverride = (t) => (t >= T0 && t < T0 + 30 ? 1 : t >= T0 + 30 ? 0 : undefined);
    let serverTickAtT0 = -1;
    step(engine, 240, () => {
      client.sample();
      if (clientPrediction(p1)!.lastSimulated === T0 && serverTickAtT0 < 0) serverTickAtT0 = serverSession.tick;
    });
    expect(client.log.get(T0)!.x - client.log.get(T0 - 1)!.x).toBeCloseTo(SPEED, 6);
    expect(client.log.get(T0)!.vx).toBe(1);
    // The client runs 150 ms (9 ticks) plus the command slack (2) ahead of the server; without
    // prediction it would see the move a whole round trip plus the slack (about 20 ticks) later.
    expect(T0 - serverTickAtT0).toBeGreaterThanOrEqual(10);

    // Every tick the client predicted (once the server has simulated it) is the server's state.
    let compared = 0;
    for (const [tick, state] of client.log) {
      if (!serverLog.has(tick)) continue;
      expectSame(state, serverLog.get(tick), `tick ${tick}`);
      compared++;
    }
    expect(compared).toBeGreaterThan(200);
    const d = delta(before, stats(engine));
    expect(d.mispredictions).toBe(0);
    expect(d.rollbacks).toBe(0);
    expect(d.resimulatedTicks).toBe(0);
  });

  it("stays right under jitter and 10% loss, and converges when corrected", async () => {
    const { engine, server, player } = await start({ latencyMs: 100, jitterMs: 20, loss: 0.1 });
    const client = trackClient(engine);
    const before = stats(engine);
    step(engine, 600, client.sample); // 10 s
    const d = delta(before, stats(engine));
    // Deterministic movement and inputs that arrive in time (redundancy covers the loss): no misprediction at all.
    expect(d.mispredictions).toBe(0);
    expect(d.rollbacks).toBe(0);
    expect(d.predictedTicks).toBeGreaterThanOrEqual(590);
    expect(ghostIn(engine, "P1").getBehavior(Fuel)!.fuel).toBeLessThan(700); // it did move

    // Nudges the client can't predict, while it keeps steering: corrected, then right again.
    for (let i = 0; i < 3; i++) {
      World._runIn(server, () => (player.transform!.position.x += 0.5));
      step(engine, 40, client.sample);
    }
    const corrected = delta(before, stats(engine));
    expect(corrected.rollbacks).toBeGreaterThanOrEqual(1);
    expect(corrected.rollbacks).toBeLessThanOrEqual(3);
    step(engine, 120, client.sample);
    let compared = 0;
    const last = [...client.log.keys()].at(-1)!;
    for (const [tick, state] of client.log) {
      if (!serverLog.has(tick) || tick < last - 60) continue;
      expectSame(state, serverLog.get(tick), `tick ${tick}`);
      compared++;
    }
    expect(compared).toBeGreaterThan(30);
    expect(delta(before, stats(engine)).rollbacks).toBe(corrected.rollbacks);
  });

  it("rolls back once when the server moves the player in a way the client can't predict, and replays each tick's input", async () => {
    const { engine, server, player } = await start({ latencyMs: 80 });
    const client = trackClient(engine);
    step(engine, 30, client.sample);
    const before = stats(engine);
    const p1Runs = runs.get("P1")!;
    const runsBefore = p1Runs.length;

    // The server teleports the player (50 units: it snaps rather than blends).
    World._runIn(server, () => (player.transform!.position.x += 50));
    step(engine, 90, client.sample);

    const d = delta(before, stats(engine));
    expect(d.mispredictions).toBe(1);
    expect(d.rollbacks).toBe(1);
    expect(d.resimulatedTicks).toBeGreaterThan(5);
    expect(stats(engine).lastError).toBeCloseTo(50, 3);
    expect(stats(engine).maxError).toBeGreaterThanOrEqual(50 - 1e-3);

    // The re-simulation ran each tick with the input written for it.
    const resims = p1Runs.slice(runsBefore).filter((r) => r.resim);
    expect(resims.length).toBe(d.resimulatedTicks);
    const log = written.get("P1")!;
    for (const r of resims) expect(r.x, `re-simulated tick ${r.tick}`).toBe(log.get(r.tick));

    // The client ends at the server's state, tick for tick, and isn't smoothing a teleport.
    const last = [...client.log.keys()].at(-1)!;
    for (let t = last - 40; t <= last; t++) if (serverLog.has(t)) expectSame(client.log.get(t), serverLog.get(t), `tick ${t}`);
    expect(Math.abs(ghostIn(engine, "P1").transform!.position.x - client.log.get(last)!.x)).toBe(0);
  });

  it("blends a small correction's rendered position over about 100 ms, keeping the simulation exact", async () => {
    const { engine, server, player } = await start({ latencyMs: 50 });
    const p1 = world(engine, "P1");
    const prediction = clientPrediction(p1)!;
    step(engine, 10);
    const before = stats(engine);
    World._runIn(server, () => (player.transform!.position.x += 1));
    // Find the frame the correction lands in.
    let frames = 0;
    while (stats(engine).rollbacks === before.rollbacks && frames++ < 60) step(engine);
    expect(stats(engine).rollbacks).toBe(before.rollbacks + 1);
    const ghost = ghostIn(engine, "P1");
    type Shown = { sx: number } | null;
    const tracked = (prediction as unknown as { ghosts: Map<unknown, { shown: Shown; smoothing: object | null }> }).ghosts;
    const p = [...tracked.values()][0];
    // Drawn behind the corrected (simulated) position by most of the unit, then less each frame.
    let gap = p.shown!.sx - ghost.transform!.position.x;
    expect(gap).toBeGreaterThan(0.7);
    expect(gap).toBeLessThan(1 + 1e-6);
    for (let i = 0; i < 4; i++) {
      step(engine);
      const next = p.shown!.sx - ghost.transform!.position.x;
      expect(next).toBeLessThan(gap);
      gap = next;
    }
    step(engine, 4); // past 100 ms: drawn where simulated
    expect(p.smoothing).toBeNull();
    expect(p.shown).toBeNull();
    // The simulation itself was never offset: it matches the server.
    const client = trackClient(engine);
    step(engine, 40, client.sample);
    const last = [...client.log.keys()].at(-1)!;
    for (let t = last - 20; t <= last; t++) if (serverLog.has(t)) expectSame(client.log.get(t), serverLog.get(t), `tick ${t}`);
  });

  it("runs each predicted tick once when serverTick skips ticks or stays on one for two steps", async () => {
    const { engine } = await start({ latencyMs: 60 });
    const p1 = world(engine, "P1");
    const client = trackClient(engine);
    step(engine, 20, client.sample);
    const before = stats(engine);
    const runsBefore = runs.get("P1")!.length;
    const time = netSession(p1)!.time as { serverTick: number };
    const startTick = time.serverTick;
    // serverTick never goes back: jumping it 3 ahead skips two ticks, then the next two steps stay on it.
    time.serverTick += 3;
    step(engine, 30, client.sample);
    const endTick = clientPrediction(p1)!.lastSimulated;

    const d = delta(before, stats(engine));
    // (the tick estimate also wobbles on its own now and then: at least these)
    expect(d.catchUpTicks).toBeGreaterThanOrEqual(2);
    expect(d.skippedSteps).toBeGreaterThanOrEqual(2);
    expect(30 - d.skippedSteps + d.catchUpTicks).toBe(endTick - startTick);
    expect(d.droppedTicks).toBe(0);
    expect(d.predictedTicks).toBe(endTick - startTick);
    // Outside re-simulation, every tick ran exactly once, in order, with its input (a skipped tick: the newest written before it).
    const first = runs.get("P1")!.slice(runsBefore).filter((r) => !r.resim);
    expect(first.map((r) => r.tick)).toEqual(Array.from({ length: endTick - startTick }, (_, i) => startTick + 1 + i));
    const log = written.get("P1")!;
    const writtenFor = (tick: number) => {
      while (!log.has(tick)) tick--;
      return log.get(tick);
    };
    for (const r of first) expect(r.x, `tick ${r.tick}`).toBe(writtenFor(r.tick));
    // The server got the same inputs for the skipped ticks, so nothing was mispredicted.
    expect(d.mispredictions).toBe(0);
    step(engine, 40, client.sample);
    const last = [...client.log.keys()].at(-1)!;
    for (let t = startTick; t <= last - 20; t++) if (serverLog.has(t) && client.log.has(t)) expectSame(client.log.get(t), serverLog.get(t), `tick ${t}`);
  });

  it("catches up at most 8 skipped ticks and drops the rest", async () => {
    const { engine } = await start({ latencyMs: 30 });
    const p1 = world(engine, "P1");
    const before = stats(engine);
    (netSession(p1)!.time as { serverTick: number }).serverTick += 20;
    step(engine, 1);
    const d = delta(before, stats(engine));
    expect(d.catchUpTicks).toBe(8);
    expect(d.droppedTicks).toBe(19 - 8); // ticks +1 … +19 were skipped; +20 is the step's own
    // The prediction is now behind by the dropped ticks' moves; the next snapshot corrects it.
    step(engine, 60);
    expect(delta(before, stats(engine)).rollbacks).toBeLessThanOrEqual(1);
  });

  it("keeps other players' ghosts interpolated, and runs predicted systems on nothing else", async () => {
    const { engine } = await start({ latencyMs: 40 }, 2);
    const p2 = world(engine, "P2");
    step(engine, 60);
    const ghost = ghostIn(engine, "P2");
    expect(ghost.getBehavior(Replicated)!.isPredictedLocally).toBe(false);
    expect(runs.get("P2") ?? []).toEqual([]); // P2's predicted system had no rows
    expect(stats(engine, "P2").predictedTicks).toBeGreaterThan(0);
    // Drawn at the interpolation tick, between the server's states.
    const net = p2.time.network!;
    const a = serverLog.get(net.interpolationTick)!.x;
    const b = serverLog.get(net.interpolationTick + 1)!.x;
    expect(ghost.transform!.position.x).toBeCloseTo(a + (b - a) * net.interpolationFraction, 3);
    // P1 predicts its own player ahead of what P2 shows.
    expect(clientPrediction(world(engine, "P1"))!.lastSimulated).toBeGreaterThan(net.interpolationTick + 5);
  });

  it("runs predicted systems like any other in Worlds that aren't networked, and only in fixedUpdate", async () => {
    const engine = await create({ worlds: [{ name: "Solo", tags: ["client"] }] });
    const solo = world(engine, "Solo");
    const node = World._runIn(solo, () => GameObject.instantiate("prefabs/pred-player.json"));
    rowsSeen.clear();
    step(engine, 5);
    expect(rowsSeen.get("Solo")).toBe(5); // once per fixed step, on every node it queries
    expect(node.getData(Body)!.vx).toBe(0); // no session: Move.of gives null
    expect(predictionStats(solo)).toBeNull();
    expect(solo.systemNames().includes("test.pred.move")).toBe(true);
    expect(() => defineSystem({ name: "test.pred.bad", phase: "update", predicted: true, run() {} })).toThrow(/fixedUpdate/);
  });
});
