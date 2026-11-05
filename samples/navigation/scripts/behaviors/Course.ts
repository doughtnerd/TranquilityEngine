import { GameBehavior, GameObject, NavAgent, Time, Vector3, behavior, field } from "myco";
import { SeededRandom, goalNear, type AgentKind, type AgentSpawner } from "../data";

/**
 * A course's agents (Foxfire's Course, in the west chunk): `count` prefabs at the `start` end, shuttling between
 * the ends every `interval` seconds. The jump course's Jumpers can only get along by jumping; the climb course's
 * Climbers walk up a wall and along a roof's underside past the lava. `goal` (a marker) shows the end they're
 * heading for.
 */
@behavior("navdemo.Course")
export class Course extends GameBehavior implements AgentSpawner {
  @field(String) kind: AgentKind = "jumper";
  @field(String) prefab = "prefabs/jumper.prefab.json";
  @field(Number) count = 6;
  /** The ends (the agents' pivot heights): they start at `from`. */
  @field(Vector3) from = new Vector3(0, 0, 0);
  @field(Vector3) to = new Vector3(0, 0, 0);
  /** Seconds before the agents turn round for the other end. */
  @field(Number) interval = 15;
  @field(GameObject) goal: GameObject | null = null;
  @field(Number) seed = 5;

  private members: { agent: NavAgent; arrived: boolean }[] = [];
  private random = new SeededRandom(5);
  private towardsEnd = true;
  private timer = 0;
  private age = 0;
  arrivals = 0;

  get agents(): NavAgent[] {
    return this.members.map((m) => m.agent);
  }

  /** The end the agents are heading for. */
  get target(): Vector3 {
    return (this.towardsEnd ? this.to : this.from).clone();
  }

  start(): void {
    this.random = new SeededRandom(this.seed);
    // Three abreast, rows two metres apart behind the start line (the Unity generator's layout).
    const spacing = 2, columns = 3;
    const along = Math.sign(this.to.z - this.from.z) || 1;
    for (let i = 0; i < this.count; i++) {
      const row = Math.floor(i / columns);
      const position = new Vector3(this.from.x + ((i % columns) - (columns - 1) / 2) * spacing, this.from.y, this.from.z - along * (row * spacing - 2));
      const node = this.instantiate(this.prefab, { parent: this.node, position });
      node.name = `${node.name} ${i + 1}`; // "Jumper 1": the prefab's name
      const agent = node.getBehavior(NavAgent);
      if (agent) this.members.push({ agent, arrived: false });
    }
    this.send();
  }

  fixedUpdate(): void {
    const dt = Time.fixedDeltaTime;
    this.timer += dt;
    this.age += dt;
    if (this.interval > 0 && this.timer >= this.interval) {
      this.towardsEnd = !this.towardsEnd;
      this.send();
    }
    if (this.age < 0.5) return;
    for (const m of this.members) {
      if (m.arrived || m.agent.pathState !== "arrived") continue;
      m.arrived = true;
      this.arrivals++;
    }
  }

  /** Sends every agent to a spot near the current end (spread across the corridor so they don't queue on a point). */
  private send(): void {
    this.timer = 0;
    this.age = 0;
    const t = this.target;
    for (const m of this.members) {
      const x = t.x + this.random.range(-2, 2);
      const z = t.z + this.random.range(-2, 2);
      m.agent.setDestination(goalNear([x, t.y, z], m.agent.agentType, 0));
      m.arrived = false;
    }
    if (this.goal?.transform) this.goal.transform.position.set(t.x, 0.5, t.z);
  }
}
