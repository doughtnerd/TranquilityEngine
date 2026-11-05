import { AssetRef, GameBehavior, MeshRenderer, NavAgent, NavGroup, Time, Vector3, behavior, field } from "myco";
import { SeededRandom, goalNear, spawnSquare, type AgentKind, type AgentSpawner } from "../data";
import { Streamer } from "./Streamer";
import { Tour } from "./Tour";

/**
 * Fills the NavGroup on its node (Foxfire's group with its members as children): spawns `count` members in a square
 * round the group, off its formation (they take their slots on the way), joins them, paints the arrow when the
 * formation is a mask, and sends the group to a spot round the tour's waypoint whenever the goal moves (and to
 * another spot there once it arrives). The group plans once; each member keeps to its slot.
 *
 * Members are spawned beside the group node, not under it: the group body moves its own node.
 */
@behavior("navdemo.GroupLeader")
export class GroupLeader extends GameBehavior implements AgentSpawner {
  @field(String) kind: AgentKind = "walkerGroup";
  @field(String) prefab = "prefabs/walker.prefab.json";
  @field(Number) count = 9;
  @field(Number) spacing = 2.5;
  /** The members' colour (each group its own). */
  @field(AssetRef) material = "";
  /** A painted formation, front row first: `#` is a slot (used when the NavGroup's formation is "mask"). */
  @field([String]) mask: string[] = [];
  /** Metres above the waypoint (flyer groups). */
  @field(Number) height = 0;
  @field(Number) spread = 10;
  @field(Number) seed = 7;

  private members: NavAgent[] = [];
  private random = new SeededRandom(7);
  private goal = -1;
  private age = 0;
  private pause = 0;
  arrivals = 0;

  get agents(): NavAgent[] {
    return this.members;
  }

  get group(): NavGroup | null {
    return this.node.getBehavior(NavGroup);
  }

  start(): void {
    this.random = new SeededRandom(this.seed);
    const group = this.group;
    const parent = this.node.scene ?? this.node.parent;
    if (!group || !parent) return;
    const centre = this.transform.position.clone();
    this.members = spawnSquare(this, this.prefab, parent, this.count, centre, this.spacing, `${this.node.name} member`);
    for (const agent of this.members) {
      const look = agent.node.getBehavior(MeshRenderer);
      if (look && this.material) look.material = this.material;
      group.join(agent);
    }
    if (group.formation === "mask" && this.mask.length > 0) {
      const width = Math.max(...this.mask.map((row) => row.length));
      const bits: boolean[] = [];
      for (const row of this.mask) for (let x = 0; x < width; x++) bits.push(row[x] === "#");
      group.setMask(bits, width, this.mask.length);
    }
  }

  fixedUpdate(): void {
    const tour = Tour.find();
    const group = this.group;
    if (!tour || !group) return;
    if (Streamer.find()?.settled === false) return; // the first goals wait for the chunks round the agents
    const dt = Time.fixedDeltaTime;
    this.age += dt;
    if (this.goal === tour.version) {
      const state = group.pathState;
      if (this.age < 0.5 || (state !== "arrived" && state !== "failed")) return;
      if (state === "arrived") this.arrivals++;
      this.goal = -1;
      this.pause = this.random.range(3, 6); // a breather, then another spot round the same waypoint
      return;
    }
    if (this.goal !== -1) {
      this.goal = -1;
      this.pause = this.random.range(0, 1);
    }
    this.pause -= dt;
    if (this.pause > 0) return;
    const t = tour.target;
    const [x, z] = this.random.inDisc(t.x, t.z, this.spread);
    group.setDestination(goalNear(new Vector3(x, t.y, z), group.agentType, this.height));
    this.goal = tour.version;
    this.age = 0;
  }
}
