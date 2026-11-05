import { GameBehavior, NavAgent, Time, Vector3, behavior, field } from "myco";
import { SeededRandom, goalNear, spawnSquare, type AgentKind, type AgentSpawner } from "../data";
import { Streamer } from "./Streamer";
import { Tour } from "./Tour";

/** A goal-picking state a crowd and a group member share. */
export interface Member {
  agent: NavAgent;
  /** Seconds until it picks a new goal (after arriving, or after the tour moved). */
  wait: number;
  /** The tour version its current goal was picked for; -1 = no goal. */
  goal: number;
  /** Seconds since the goal was set (its first steps still report the last goal's state). */
  age: number;
}

/**
 * One step of a member's goal picking: keeps following the current goal; on arriving (or failing) waits 1-4 s and
 * picks another; when the tour has moved on, picks one round the new waypoint after up to a second. Returns true
 * on an arrival.
 */
export function stepMember(m: Member, tour: Tour, random: SeededRandom, dt: number, pick: () => Vector3): boolean {
  m.age += dt;
  if (m.goal === tour.version) {
    const state = m.agent.pathState;
    if (m.age < 0.5 || (state !== "arrived" && state !== "failed")) return false;
    m.goal = -1;
    m.wait = random.range(1, 4);
    return state === "arrived";
  }
  if (m.goal !== -1) {
    // The tour moved on: a new goal soon (staggered, so the path searches spread over a second).
    m.goal = -1;
    m.wait = random.range(0, 1);
  }
  m.wait -= dt;
  if (m.wait > 0) return false;
  m.agent.setDestination(pick());
  m.goal = tour.version;
  m.age = 0;
  return false;
}

/**
 * A crowd of one agent type (Foxfire's Crowd): `count` prefabs spawned in a square round `center`, each sent to a
 * random spot within `spread` of the tour's waypoint (`height` metres up for flyers). An agent that arrives waits a
 * moment and picks another spot; when the goal moves on, everyone picks a spot round the new waypoint (staggered
 * over a second, so the path searches spread out). The random numbers are seeded: every run is the same.
 */
@behavior("navdemo.Crowd")
export class Crowd extends GameBehavior implements AgentSpawner {
  @field(String) kind: AgentKind = "walker";
  @field(String) prefab = "prefabs/walker.prefab.json";
  @field(Number) count = 10;
  @field(Vector3) center = new Vector3(0, 1.5, 0);
  @field(Number) spacing = 2.5;
  /** Goals are random spots within this radius of the waypoint. */
  @field(Number) spread = 18;
  /** Metres above the waypoint (flyers). */
  @field(Number) height = 0;
  @field(Number) seed = 1;

  private members: Member[] = [];
  private random = new SeededRandom(1);
  arrivals = 0;

  get agents(): NavAgent[] {
    return this.members.map((m) => m.agent);
  }

  start(): void {
    this.random = new SeededRandom(this.seed);
    const label = this.node.name.replace(/s$/, "");
    this.members = spawnSquare(this, this.prefab, this.node, this.count, this.center, this.spacing, label).map((agent) => ({ agent, wait: this.random.range(0, 1), goal: -1, age: 0 }));
  }

  fixedUpdate(): void {
    const tour = Tour.find();
    if (!tour) return;
    if (Streamer.find()?.settled === false) return; // the first goals wait for the chunks round the agents
    const dt = Time.fixedDeltaTime;
    for (const m of this.members) {
      const arrived = stepMember(m, tour, this.random, dt, () => {
        const t = tour.target;
        const [x, z] = this.random.inDisc(t.x, t.z, this.spread);
        return goalNear([x, t.y, z], m.agent.agentType, this.height);
      });
      if (arrived) this.arrivals++;
    }
  }
}
