import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLOUD_COST, CLOUD_RADIUS, inCloudAmong, type CloudSpot } from "../../../samples/pirates/scripts/data";
import { BOT_GHOST_SIGHT, BOT_SIGHT, EDGE_WARNING, botSpots, chartMarkers, chartPoint, chartedBy, compass, edgeMarker, edgeStatus, flagChartedBy, flagSeenBy, seenBy, type SeaShip } from "../../../samples/pirates/scripts/awareness";

// King of Pirates' situational awareness (samples/pirates/scripts/awareness.ts): the arena-edge warning, what the
// minimap shows a captain when fog clouds hide ships, where off-screen markers sit, and the fog cloud prefab's
// sizes agreeing with the concealment radius.

const SAMPLE = fileURLToPath(new URL("../../../samples/pirates/", import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(SAMPLE + path, "utf8"));

const ship = (team: number, x: number, z: number, more: Partial<SeaShip> = {}): SeaShip => ({ team, x, z, sunk: false, mine: false, ...more });

describe("King of Pirates: the arena's edge", () => {
  it("is inside, near (within the warning distance) or outside, with the way home", () => {
    expect(edgeStatus(0, 10, 80).state).toBe("inside");
    expect(edgeStatus(0, 80 - EDGE_WARNING - 1, 80).state).toBe("inside");
    expect(edgeStatus(0, 80 - EDGE_WARNING + 1, 80).state).toBe("near");
    expect(edgeStatus(79.9, 0, 80).state).toBe("near");
    const out = edgeStatus(60, 60, 80);
    expect(out.state).toBe("outside");
    expect(out.beyond).toBeCloseTo(Math.hypot(60, 60) - 80);
    expect(out.homeX).toBeCloseTo(-Math.SQRT1_2);
    expect(out.homeZ).toBeCloseTo(-Math.SQRT1_2);
  });

  it("names directions as the screen shows them: north up, east on the right (world -X)", () => {
    expect(compass(0, 1)).toBe("north");
    expect(compass(0, -1)).toBe("south");
    expect(compass(-1, 0)).toBe("east");
    expect(compass(1, 0)).toBe("west");
    expect(compass(1, 1)).toBe("north-west");
    // Outside in the north-east (screen up and right), the way back is south-west.
    const at = edgeStatus(-70, 70, 80);
    expect(compass(at.homeX, at.homeZ)).toBe("south-west");
  });
});

describe("King of Pirates: the minimap", () => {
  const clouds: CloudSpot[] = [{ team: 3, x: 20, z: 0 }];

  it("hides ships in another team's fog cloud from the viewer, but not the cloud's own team or the viewer's ship", () => {
    const hidden = ship(1, 25, 0);
    expect(seenBy(0, hidden, clouds)).toBe(false);
    expect(seenBy(3, hidden, clouds)).toBe(true); // the cloud's own team sees through it
    expect(seenBy(0, ship(0, 25, 0, { mine: true }), clouds)).toBe(true);
    expect(seenBy(0, ship(1, 20 + CLOUD_RADIUS + 1, 0), clouds)).toBe(true);
  });

  it("shows clouds, power-ups, the loose flag and the visible ships afloat, the viewer's marked", () => {
    const ships = [ship(0, 0, 0, { mine: true }), ship(1, 22, 3), ship(2, -30, 10), ship(4, 5, 5, { sunk: true })];
    const markers = chartMarkers({ viewer: 0, ships, clouds, flag: { x: 1, z: 2, carrier: -1 }, pickups: [{ x: 9, z: 9, power: 2 }] });
    expect(markers.map((m) => m.kind)).toEqual(["cloud", "pickup", "flag", "ship", "ship"]);
    const shipMarkers = markers.filter((m) => m.kind === "ship");
    expect(shipMarkers.map((m) => m.kind === "ship" && m.team)).toEqual([0, 2]); // team 1 is in the fog, team 4 sunk
    expect(shipMarkers[0]).toMatchObject({ mine: true, holder: false });
  });

  it("leaves out the flag while a hidden ship holds it, and marks a visible holder", () => {
    const ships = [ship(0, 0, 0, { mine: true }), ship(1, 22, 3), ship(2, -30, 10)];
    const hiddenHolder = chartMarkers({ viewer: 0, ships, clouds, flag: { x: 22, z: 3, carrier: 1 }, pickups: [] });
    expect(hiddenHolder.some((m) => m.kind === "flag")).toBe(false);
    expect(hiddenHolder.some((m) => m.kind === "ship" && m.team === 1)).toBe(false);
    expect(flagSeenBy(0, { x: 22, z: 3, carrier: 1 }, ships, clouds)).toBeNull();
    // The cloud's own team still sees the holder, and so the flag.
    expect(flagSeenBy(3, { x: 22, z: 3, carrier: 1 }, ships, clouds)).toEqual({ x: 22, z: 3, carrier: 1 });

    const visibleHolder = chartMarkers({ viewer: 0, ships, clouds, flag: { x: -30, z: 10, carrier: 2 }, pickups: [] });
    expect(visibleHolder.some((m) => m.kind === "flag")).toBe(false); // drawn as the holder's ring instead
    expect(visibleHolder.find((m) => m.kind === "ship" && m.team === 2)).toMatchObject({ holder: true });
  });

  it("puts north up and east (world -X) on the right", () => {
    expect(chartPoint(0, 0, 80, 160)).toEqual({ x: 80, y: 80 });
    expect(chartPoint(0, 80, 80, 160)).toEqual({ x: 80, y: 0 });
    expect(chartPoint(-80, 0, 80, 160)).toEqual({ x: 160, y: 80 });
  });
});

describe("King of Pirates: off-screen markers", () => {
  const insets = { top: 80, right: 40, bottom: 120, left: 40 };

  it("hide while the point is on screen, and clamp to the inset edge on the line from the middle", () => {
    expect(edgeMarker(640, 360, 20, 1280, 720, insets)).toBeNull();
    const right = edgeMarker(5000, 360, 20, 1280, 720, insets)!;
    expect(right.x).toBeCloseTo(1240);
    expect(right.y).toBeCloseTo(360);
    const up = edgeMarker(640, -4000, 20, 1280, 720, insets)!;
    expect(up).toEqual({ x: 640, y: 80 });
    // Behind the camera the point is mirrored.
    const behind = edgeMarker(5000, 360, -5, 1280, 720, insets)!;
    expect(behind.x).toBeCloseTo(40);
    // Inside the screen but under the bottom bar counts as off screen.
    expect(edgeMarker(640, 700, 20, 1280, 720, insets)).toEqual({ x: 640, y: 600 });
  });
});

describe("King of Pirates: the fog cloud", () => {
  it("hides ships within CLOUD_RADIUS (about twice the first version's 9 m)", () => {
    expect(CLOUD_RADIUS).toBeGreaterThanOrEqual(16);
    expect(inCloudAmong([{ team: 1, x: 0, z: 0 }], CLOUD_RADIUS - 0.5, 0)).toBe(true);
    expect(inCloudAmong([{ team: 1, x: 0, z: 0 }], CLOUD_RADIUS + 0.5, 0)).toBe(false);
  });

  it("has a NavCostVolume and a particle effect the size of its concealment radius", () => {
    const prefab = json("prefabs/fogcloud.prefab.json");
    const components = prefab.nodes.flatMap((n: { components: { type: string; data: Record<string, unknown> }[] }) => n.components);
    const volume = components.find((c: { type: string }) => c.type === "engine.NavCostVolume")!.data as { size: number[]; cost: number };
    expect(volume.size[0]).toBe(CLOUD_RADIUS * 2);
    expect(volume.size[2]).toBe(CLOUD_RADIUS * 2);
    expect(volume.cost).toBe(CLOUD_COST);

    const particles = components.find((c: { type: string }) => c.type === "engine.ParticleSystem")!.data as { effect: string };
    const effect = json(particles.effect.replace(/^asset:/, ""));
    for (const system of effect.systems) {
      const shape = system.initialize.blocks.find((b: { type: string }) => b.type === "init.positionCircle" || b.type === "init.positionCone").inputs;
      const size = system.initialize.blocks.find((b: { type: string }) => b.type === "init.size").inputs.size.random as number[];
      // The puffs spawn inside the cloud and their soft edges reach about its radius, no further.
      expect(shape.radius).toBeLessThanOrEqual(CLOUD_RADIUS);
      expect(shape.radius + size[0] / 2).toBeGreaterThanOrEqual(CLOUD_RADIUS);
      expect(shape.radius + size[1] / 4).toBeLessThanOrEqual(CLOUD_RADIUS + 2);
      expect(system.output.settings.texture).toBe("asset:textures/smoke.png");
    }
    expect(readFileSync(SAMPLE + "textures/smoke.png").subarray(1, 4).toString()).toBe("PNG");
  });
});

describe("King of Pirates: the weather's particle effects lie flat on the sea", () => {
  // The engine's emitter shapes lie in the horizontal (XZ) plane and emit up (+Y) unrotated, like
  // Unity's; a rotation of 90° about X stands them on edge, in a vertical sheet (the first version's mistake).
  const shapeOf = (system: { initialize: { blocks: { type: string; inputs: Record<string, unknown> }[] } }) => system.initialize.blocks.find((b) => b.type.startsWith("init.position"))!;

  it("the fog cloud's puffs fill a horizontal disc", () => {
    for (const system of json("effects/fogcloud.particles.json").systems) {
      const shape = shapeOf(system);
      expect(["init.positionCone", "init.positionCircle"]).toContain(shape.type);
      expect(shape.inputs.rotation).toEqual([0, 0, 0]);
      expect((shape.inputs.offset as number[])[1]).toBeLessThan(3); // just over the water
    }
    // The body spreads its puffs evenly over the disc (a cone's disc), drifting outward more than up.
    const body = shapeOf(json("effects/fogcloud.particles.json").systems[0]);
    expect(body.type).toBe("init.positionCone");
    expect(body.inputs.thickness).toBe(1);
    expect(body.inputs.angle as number).toBeGreaterThanOrEqual(60);
  });

  it("rain starts over a horizontal disc and falls straight down", () => {
    const system = json("effects/rain.particles.json").systems[0];
    const shape = shapeOf(system);
    expect(shape.type).toBe("init.positionCone");
    expect(shape.inputs.angle).toBe(0); // straight along the axis
    expect(shape.inputs.rotation).toEqual([180, 0, 0]); // the axis turned to point down
    expect(shape.inputs.radius as number).toBeGreaterThanOrEqual(35); // wider than the camera's view of the water
    expect(system.output.type).toBe("stretched");
  });
});

describe("King of Pirates: ghost ships and fog", () => {
  const clouds: CloudSpot[] = [{ team: 3, x: 20, z: 0 }];
  const ghost = ship(1, -30, 0, { ghost: true });

  it("leaves a ghost ship off enemies' minimaps, though they can see it on the water", () => {
    expect(seenBy(0, ghost, [])).toBe(true);
    expect(chartedBy(0, ghost, [])).toBe(false);
    expect(chartedBy(1, ghost, [])).toBe(true); // its own team charts it
    expect(chartedBy(0, ship(0, 5, 5, { mine: true, ghost: true }), [])).toBe(true); // and so does its captain
    const markers = chartMarkers({ viewer: 0, ships: [ship(0, 0, 0, { mine: true }), ghost, ship(2, 10, 10)], clouds: [], flag: null, pickups: [] });
    expect(markers.filter((m) => m.kind === "ship").map((m) => m.kind === "ship" && m.team)).toEqual([0, 2]);
  });

  it("hides a ship in someone else's fog cloud both on the water and on the chart", () => {
    const fogged = ship(2, 22, 0);
    expect(seenBy(0, fogged, clouds)).toBe(false);
    expect(chartedBy(0, fogged, clouds)).toBe(false);
    expect(chartedBy(3, fogged, clouds)).toBe(true);
  });

  it("hides the flag's marker while a ghost holds it, but the scoreboard still sees who has it", () => {
    const ships = [ship(0, 0, 0, { mine: true }), ghost];
    const theFlag = { x: -30, z: 0, carrier: 1 };
    expect(flagChartedBy(0, theFlag, ships, [])).toBeNull();
    expect(flagSeenBy(0, theFlag, ships, [])).toEqual(theFlag);
    expect(chartMarkers({ viewer: 0, ships, clouds: [], flag: theFlag, pickups: [] }).some((m) => m.kind === "flag" || (m.kind === "ship" && m.team === 1))).toBe(false);
    // A holder hidden in fog hides the flag from both.
    const fogged = [ship(0, 0, 0, { mine: true }), ship(2, 22, 0)];
    expect(flagSeenBy(0, { x: 22, z: 0, carrier: 2 }, fogged, clouds)).toBeNull();
    expect(flagChartedBy(0, { x: 22, z: 0, carrier: 2 }, fogged, clouds)).toBeNull();
  });

  it("lets bots spot ships they can see within their sight, ghosts only close by, and nothing in fog", () => {
    expect(botSpots(0, ship(1, 40, 0), [], 40)).toBe(true);
    expect(botSpots(0, ship(1, 60, 0), [], BOT_SIGHT + 1)).toBe(false);
    expect(botSpots(0, ghost, [], BOT_GHOST_SIGHT - 1)).toBe(true);
    expect(botSpots(0, ghost, [], BOT_GHOST_SIGHT + 1)).toBe(false);
    expect(botSpots(0, ship(2, 22, 0), clouds, 5)).toBe(false);
    expect(botSpots(3, ship(2, 22, 0), clouds, 5)).toBe(true); // the cloud's own team sees through it
    expect(botSpots(1, ship(1, 0, 0), [], 1)).toBe(false); // not its own team
    expect(BOT_GHOST_SIGHT).toBeLessThan(BOT_SIGHT);
  });
});
