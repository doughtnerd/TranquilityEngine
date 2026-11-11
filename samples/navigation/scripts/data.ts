// The navigation sample's shared pieces (ADR 0065): the world's layout, as tools/generate.mjs lays
// it out, and a seeded random number generator, so a run plays out the same way every time.
import { GameObject, Navigation, NavAgent, Vector3, type Vec3Input } from "myco";

/** The chunks' squares (metres) and the world's 3×3 grid of them, centred on the origin. */
export const CHUNK_SIZE = 128;
/** Chunk 1 is south-west, 5 the centre, 9 north-east (like a numpad). North is +z. */
export const CHUNK_NAMES = ["South-west", "South", "South-east", "West", "Centre", "East", "North-west", "North", "North-east"];

/** The chunk index (0-8) whose square holds (x, z), or -1 outside the world. */
export function chunkIndexAt(x: number, z: number): number {
  const cx = Math.floor((x + CHUNK_SIZE * 1.5) / CHUNK_SIZE);
  const row = Math.floor((z + CHUNK_SIZE * 1.5) / CHUNK_SIZE); // 0 south, 2 north
  if (cx < 0 || cx > 2 || row < 0 || row > 2) return -1;
  return row * 3 + cx;
}

/** The centre of chunk `i` (y 0). */
export function chunkCentre(i: number): Vector3 {
  return new Vector3(((i % 3) - 1) * CHUNK_SIZE, 0, (Math.floor(i / 3) - 1) * CHUNK_SIZE);
}

/** mulberry32: a small seeded generator (the same numbers on every machine). */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** A number in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** A point in the disc of `radius` round (x, z). */
  inDisc(x: number, z: number, radius: number): [number, number] {
    const a = this.next() * Math.PI * 2;
    const d = Math.sqrt(this.next()) * radius;
    return [x + Math.cos(a) * d, z + Math.sin(a) * d];
  }
}

/** The kinds of agent the sample spawns (what the HUD counts and the tests check). */
export type AgentKind = "walker" | "flyer" | "walkFly" | "jumper" | "climber" | "walkerGroup" | "flyerGroup" | "walkFlyGroup";

/** What a spawner reports about its agents. */
export interface AgentSpawner {
  readonly kind: AgentKind;
  readonly agents: readonly NavAgent[];
  /** Goals reached so far (arrivals). */
  readonly arrivals: number;
}

/**
 * A goal near `point` for an agent: on the navmesh when the chunk there is loaded (so it isn't inside a pillar),
 * `height` metres up for flyers. Unloaded chunks leave the point as it is: the agent heads for the edge of loaded
 * space and continues once the chunk streams in.
 */
export function goalNear(point: Vec3Input, agentType: string, height: number): Vector3 {
  const p = Vector3.from(point);
  if (height > 0) return new Vector3(p.x, p.y + height, p.z);
  const snapped = Navigation.isReady ? Navigation.nearestPoint(p, agentType, 6) : null;
  return snapped ? snapped.point : p;
}

/** Spawns `count` prefabs in a square of `spacing` round `centre` under `parent`. */
export function spawnSquare(owner: { instantiate(path: string, options: { parent: GameObject; position: Vec3Input; name: string }): GameObject }, prefab: string, parent: GameObject, count: number, centre: Vector3, spacing: number, label: string): NavAgent[] {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const agents: NavAgent[] = [];
  for (let i = 0; i < count; i++) {
    const x = centre.x + ((i % columns) - (columns - 1) / 2) * spacing;
    const z = centre.z + (Math.floor(i / columns) - (columns - 1) / 2) * spacing;
    const node = owner.instantiate(prefab, { parent, position: [x, centre.y, z], name: `${label} ${i + 1}` });
    const agent = node.getBehavior(NavAgent);
    if (agent) agents.push(agent);
  }
  return agents;
}
