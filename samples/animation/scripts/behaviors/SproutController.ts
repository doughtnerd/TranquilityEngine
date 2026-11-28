import { Animator, GameBehavior, GameObject, Input, Mathf, Time, behavior, field, sequence, tween, type AnimationEvent } from "myco";

/**
 * Drives the Sprout's animation graph (graphs/sprout.animgraph.json) through its parameters, never by naming states:
 * `speed` (0–2) picks Idle or Move and, in Move, where the blend space sits between Idle, Sway and Wiggle; a `Hop`
 * request takes either state to Hop, which comes back on its own. Up/Down (or W/S) change the speed, Space hops, P
 * toggles the autopilot (on until a key is pressed). The hop clip's `land` notify kicks up a ring of dust.
 */
@behavior("demo.SproutController")
export class SproutController extends GameBehavior {
  /** The ring that puffs out when the Sprout lands. */
  @field(GameObject) dust: GameObject | null = null;
  /** Speed change per second while Up or Down is held. */
  @field(Number) acceleration = 1.5;

  /** The graph's `speed` parameter as last set, 0–2. */
  speed = 0;
  /** True while the speed comes from a slow wave and hops come every few seconds. */
  autopilot = true;
  /** Landings heard from the hop clip's `land` notify. */
  landings = 0;
  /** Read the keyboard; off, set `speed`, `autopilot` and call `hop()` from other code (tests, touch controls). */
  useKeyboard = true;

  private anim: Animator | null = null;
  private nextHop = 4;

  awake(): void {
    this.anim = this.node.getBehavior(Animator);
  }

  update(): void {
    if (this.useKeyboard) this.readKeys();
    if (this.autopilot) {
      // A slow wave from standing still (below 0.15 the graph goes back to Idle) to a wiggle, and a hop every 5 s.
      this.speed = Mathf.clamp(1.1 * Math.sin(Time.time * 0.45 - 1) + 0.7, 0, 2);
      if (Time.time >= this.nextHop) {
        this.nextHop = Time.time + 5;
        this.hop();
      }
    }
    this.anim?.set("speed", this.speed);
  }

  /** Ask the graph for a hop. The request stays open for a quarter second; a state that can hop takes it. */
  hop(): void {
    this.anim?.request("Hop");
  }

  /** The hop clip's `land` notify (an `event` track key at 0.72 s). */
  land(_e: AnimationEvent): void {
    this.landings++;
    const dust = this.dust?.transform;
    if (!dust) return;
    dust.scale = [0.3, 0.02, 0.3];
    void sequence(tween(dust, "scale", [1.8, 0.04, 1.8], { duration: 0.25, ease: "outQuad" }), tween(dust, "scale", [0, 0, 0], { duration: 0.3, ease: "inQuad" }));
  }

  private readKeys(): void {
    const up = Input.getKey("arrowup") || Input.getKey("w");
    const down = Input.getKey("arrowdown") || Input.getKey("s");
    if (up || down) {
      this.autopilot = false;
      this.speed = Mathf.clamp(this.speed + (up ? 1 : -1) * this.acceleration * Time.deltaTime, 0, 2);
    }
    if (Input.getKeyDown("space")) {
      this.autopilot = false;
      this.hop();
    }
    if (Input.getKeyDown("p")) {
      this.autopilot = !this.autopilot;
      this.nextHop = Time.time + 1;
    }
  }
}
