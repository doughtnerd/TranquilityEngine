import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, NavAgent, NavGate, Navigation, SceneManager } from "../index";
import { releaseBakeCaches } from "../nav/bake";
import { clearNavBakeCache } from "../nav/navigationSystems";
import { readProject } from "../../server/project";
// The sample's scripts, registered as loading the project's scripts would (ADR 0031).
import { chunkIndexAt, type AgentKind } from "../../../samples/navigation/scripts/data";
import { GateTimer } from "../../../samples/navigation/scripts/behaviors/GateTimer";
import { Streamer } from "../../../samples/navigation/scripts/behaviors/Streamer";
import { Tour } from "../../../samples/navigation/scripts/behaviors/Tour";
import { Hud, spawners } from "../../../samples/navigation/scripts/behaviors/Hud";
import "../../../samples/navigation/scripts/behaviors/CameraRig";

// ADR 0065, W7: the navigation sample (samples/navigation, a port of Foxfire's Streaming Demo) played headless: the
// project read from disk as the dedicated server reads it, its main scene run for 75 s of fixed steps. Every kind
// of agent moves and reaches goals, the crowds and groups cross chunk seams, the streamer loads chunk scenes ahead
// of the agents and unloads them behind, the gate toggles, and the console stays quiet.

const SAMPLE = fileURLToPath(new URL("../../../samples/navigation", import.meta.url));
const STEP = 1 / 60;
const SECONDS = 75; // the goal's first waypoint (south-east, through the door) and the start of the second

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
  vi.restoreAllMocks();
});
afterAll(() => releaseBakeCaches());

/** Lets chunk loads (bake file reads, the navigation and physics modules) finish between steps. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Track {
  kind: AgentKind;
  agent: NavAgent;
  start: { x: number; z: number };
  /** The chunks it has stood in. */
  chunks: Set<number>;
  flew: boolean;
}

/** Path warnings (agents whose goal or start is outside the chunk they plan in for a moment) are Foxfire's normal noise, rate-limited by the runtime. */
const PATH_WARNING = /path failed|more path warnings/;

describe("the navigation sample (ADR 0065)", () => {
  it("streams chunks around the agents, and every kind of agent moves, crosses chunks and reaches goals", { timeout: 240_000 }, async () => {
    const warnings: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warnings.push(args.map(String).join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(" ")));
    vi.spyOn(console, "log").mockImplementation(() => {}); // the runtime's route and seam reports

    const project = await readProject(SAMPLE);
    clearNavBakeCache();
    Assets.clearSources();
    Assets.addSource(project.assets);
    const engine = await Engine.create({ headless: true, project: project.settings });
    engines.push(engine);
    await SceneManager.load("scenes/main.scene.json");
    const streamer = Streamer.find()!;
    const tour = Tour.find()!;
    const gate = GateTimer.find()!;
    expect(streamer).not.toBeNull();
    expect(tour).not.toBeNull();
    expect(gate).not.toBeNull();

    const tracks: Track[] = [];
    const loadedSeen = new Set<string>();
    const runtimeMatches: boolean[] = [];
    let gatesSeen = 0;
    let maxLoaded = 0;
    for (let i = 0; i < SECONDS * 60; i++) {
      engine.step(STEP);
      if (i % 4 === 0) await settle();
      if (tracks.length === 0) {
        for (const s of spawners()) {
          for (const agent of s.agents) {
            const p = agent.transform.position;
            tracks.push({ kind: s.kind, agent, start: { x: p.x, z: p.z }, chunks: new Set([chunkIndexAt(p.x, p.z)]), flew: false });
          }
        }
      }
      if (i % 30 !== 0) continue;
      for (const t of tracks) {
        const p = t.agent.transform.position;
        t.chunks.add(chunkIndexAt(p.x, p.z));
        if (t.agent.mode === "flying") t.flew = true;
      }
      const loaded = streamer.loadedNames;
      for (const name of loaded) loadedSeen.add(name);
      maxLoaded = Math.max(maxLoaded, loaded.length);
      // Once a chunk scene is in, its NavChunk is in the runtime by the next step.
      runtimeMatches.push(Navigation.loadedChunks.length === loaded.length);
      for (const g of GameObject.findObjectsOfType(NavGate)) {
        gatesSeen++;
        expect(g.open).toBe(gate.open);
      }
    }

    const kinds = new Map<AgentKind, Track[]>();
    for (const t of tracks) kinds.set(t.kind, [...(kinds.get(t.kind) ?? []), t]);
    const arrivals = new Map<AgentKind, number>();
    for (const s of spawners()) arrivals.set(s.kind, (arrivals.get(s.kind) ?? 0) + s.arrivals);
    const report = [...kinds].map(([kind, ts]) => ({
      kind,
      agents: ts.length,
      moved: ts.filter((t) => Math.hypot(t.agent.transform.position.x - t.start.x, t.agent.transform.position.z - t.start.z) > 8).length,
      crossed: ts.filter((t) => t.chunks.size > 1).length,
      flew: ts.filter((t) => t.flew).length,
      arrivals: arrivals.get(kind) ?? 0,
    }));
    const row = (kind: AgentKind) => report.find((r) => r.kind === kind)!;
    const summary = JSON.stringify({ report, loaded: streamer.loadedNames, loadedSeen: [...loadedSeen], loads: streamer.loads, unloads: streamer.unloads, warnings: warnings.length });

    // The agents the generator asks for, of every kind.
    expect([...kinds.keys()].sort()).toEqual(["climber", "flyer", "flyerGroup", "jumper", "walkFly", "walkFlyGroup", "walker", "walkerGroup"]);
    expect(tracks.length).toBeGreaterThanOrEqual(100);

    // Every kind moves. The crowds and groups leave the centre through the door for the south-east, crossing seams;
    // the course agents stay in the west chunk's courses.
    for (const r of report) expect(r.moved, `${r.kind} moved: ${summary}`).toBeGreaterThanOrEqual(Math.ceil(r.agents * 0.75));
    for (const kind of ["walker", "flyer", "walkFly", "walkerGroup", "flyerGroup", "walkFlyGroup"] as const) {
      expect(row(kind).crossed, `${kind} crossed chunks: ${summary}`).toBeGreaterThanOrEqual(Math.ceil(row(kind).agents * 0.5));
    }
    for (const kind of ["jumper", "climber"] as const) {
      for (const t of kinds.get(kind)!) expect(chunkIndexAt(t.agent.transform.position.x, t.agent.transform.position.z), summary).toBe(3);
    }
    // Flyers and walk-and-fly agents fly (the walk-and-fly agents hop the pillars and the wall).
    expect(row("flyer").flew, summary).toBe(row("flyer").agents);
    expect(row("walkFly").flew, summary).toBeGreaterThan(0);

    // Goals reached: the crowds at their spots round the waypoint, the course agents at their ends, the groups.
    for (const kind of ["walker", "flyer", "walkFly", "jumper", "climber"] as const) expect(row(kind).arrivals, `${kind} arrivals: ${summary}`).toBeGreaterThan(0);
    expect(row("walkerGroup").arrivals + row("flyerGroup").arrivals + row("walkFlyGroup").arrivals, `group arrivals: ${summary}`).toBeGreaterThan(0);

    // Streaming: the chunks near the agents loaded as they came near (the south-east only once the crowds headed
    // there), some unloaded behind them, never all nine at once; the runtime's chunks follow the scenes.
    expect(tour.index).toBe(1);
    for (const name of ["Centre", "South", "South-east", "West", "East"]) expect(loadedSeen.has(name), `${name}: ${summary}`).toBe(true);
    expect(streamer.loads, summary).toBeGreaterThanOrEqual(6);
    expect(streamer.unloads, summary).toBeGreaterThan(0);
    expect(maxLoaded, summary).toBeLessThan(9);
    expect(runtimeMatches.filter((m) => !m).length, summary).toBeLessThanOrEqual(2);
    expect(Navigation.loadedChunks.length).toBe(streamer.loadedNames.length);

    // The gate toggled every 20 s (and the centre chunk's NavGate followed while it was loaded); the HUD reports.
    expect(gate.toggles).toBe(3);
    expect(gatesSeen).toBeGreaterThan(0);
    const hud = GameObject.findObjectOfType(Hud)!;
    expect(hud.lines()[0]).toMatch(/^Chunks loaded \(\d\/9\): /);
    expect(hud.lines().some((l) => /^Walkers: 30 /.test(l))).toBe(true);

    // No errors; warnings are only the runtime's rate-limited path warnings (at most 5 a second), and not many.
    expect(errors).toEqual([]);
    expect(warnings.filter((w) => !PATH_WARNING.test(w))).toEqual([]);
    expect(warnings.length, `${warnings.slice(0, 10).join("\n")}\n${summary}`).toBeLessThan(SECONDS * 1.5);
  });
});
