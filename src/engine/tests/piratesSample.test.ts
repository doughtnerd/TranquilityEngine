import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, Replicated } from "../index";
import type { World } from "../core/World";
import { readProject } from "../../server/project";
// The sample's scripts, registered as loading the project's scripts would (ADR 0031).
import { Ship, type ShipView } from "../../../samples/pirates/scripts/data";
import "../../../samples/pirates/scripts/systems";
import "../../../samples/pirates/scripts/client";
import "../../../samples/pirates/scripts/bots";
import "../../../samples/pirates/scripts/behaviors/Actors";
import "../../../samples/pirates/scripts/behaviors/Splash";
import "../../../samples/pirates/scripts/behaviors/FollowCamera";
import "../../../samples/pirates/scripts/behaviors/Hud";

// King of Pirates (samples/pirates) played headless from its own bootstrap: a server World and a
// client World linked over loopback, the island bay scene in both. The client's ship spawns and
// sails, bots fill the other slots, hunt and fire broadsides, ships take damage and sink, and the
// client sees the server's ships.

const SAMPLE = fileURLToPath(new URL("../../../samples/pirates", import.meta.url));
const STEP = 1 / 60;

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
  vi.restoreAllMocks();
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function shipsIn(world: World): { rep: Replicated; data: ShipView; x: number; z: number }[] {
  return world
    ._componentsOfType(Replicated)
    .filter((r) => r.node.isValid && r.node.hasData(Ship))
    .map((r) => ({ rep: r, data: r.node.getData(Ship) as ShipView, x: r.node.transform!.position.x, z: r.node.transform!.position.z }));
}

describe("the King of Pirates sample", () => {
  it("spawns the player's ship and bots, which sail, fight and sink ships, as the client sees", { timeout: 120_000 }, async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(" ")));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const project = await readProject(SAMPLE);
    Assets.addSource(project.assets);
    const engine = await Engine.create({ headless: true, project: project.settings });
    engines.push(engine);
    const server = engine._world("Server")!, client = engine._world("Client")!;
    expect(server && client).toBeTruthy();

    let start: Map<number, { x: number; z: number }> | null = null;
    let maxSinks = 0, minHp = 100;
    for (let i = 0; i < 150 * 60; i++) {
      engine.step(STEP);
      if (i % 10 === 0) await settle();
      const ships = shipsIn(server);
      if (!start && ships.length === 4) start = new Map(ships.map((s) => [s.data.team, { x: s.x, z: s.z }]));
      for (const s of ships) {
        maxSinks = Math.max(maxSinks, s.data.sinks);
        minHp = Math.min(minHp, s.data.hp);
      }
    }

    const ships = shipsIn(server);
    expect(ships).toHaveLength(4);
    expect(ships.filter((s) => s.data.bot)).toHaveLength(3);
    const player = ships.find((s) => !s.data.bot)!;
    expect(player.rep.ownerId).toBeGreaterThan(0);
    // Everyone sailed somewhere.
    for (const s of ships) {
      const from = start!.get(s.data.team)!;
      expect(Math.hypot(s.x - from.x, s.z - from.z) + s.data.sinks).toBeGreaterThan(5);
    }
    // The bots fought: someone was hurt, and someone sank.
    expect(minHp).toBeLessThan(100);
    expect(maxSinks).toBeGreaterThan(0);

    // The client sees the same four ships and owns the player's, predicted.
    const seen = shipsIn(client);
    expect(seen).toHaveLength(4);
    const mine = seen.filter((s) => s.rep.isOwnedLocally);
    expect(mine).toHaveLength(1);
    expect(mine[0].rep.isPredictedLocally).toBe(true);
    expect(errors).toEqual([]);
  });
});
