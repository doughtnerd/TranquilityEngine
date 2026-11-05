import { GameBehavior, GameObject, Input, Time, Vector3, behavior, field } from "myco";

/**
 * The goal's tour of the world's features (Foxfire's StreamingDemoGoal): it sits at one waypoint for `interval`
 * seconds, then moves to the next (G moves it at once). The crowds and groups head for spots round it, so the
 * agents cross the world chunk by chunk and the streamer loads the chunks ahead and unloads those behind.
 */
@behavior("navdemo.Tour")
export class Tour extends GameBehavior {
  @field([Vector3]) waypoints: Vector3[] = [];
  @field([String]) names: string[] = [];
  /** Seconds at each waypoint; 0 = only when G is pressed. */
  @field(Number) interval = 60;

  /** The waypoint the goal is at. */
  index = 0;
  /** Bumped each time the goal moves, so followers know to pick new goals. */
  version = 0;
  private timer = 0;

  /** The tour in the current World, if any. */
  static find(): Tour | null {
    return GameObject.findObjectOfType(Tour);
  }

  /** Where the goal is now. */
  get target(): Vector3 {
    return this.waypoints[this.index]?.clone() ?? this.transform.position.clone();
  }

  get waypointName(): string {
    return this.names[this.index] ?? `waypoint ${this.index + 1}`;
  }

  /** Seconds until the goal moves on. */
  get timeLeft(): number {
    return this.interval > 0 ? Math.max(0, this.interval - this.timer) : Infinity;
  }

  start(): void {
    this.place();
  }

  fixedUpdate(): void {
    this.timer += Time.fixedDeltaTime;
    if (this.interval > 0 && this.timer >= this.interval) this.next();
  }

  update(): void {
    if (Input.getKeyDown("g")) this.next();
  }

  /** Moves the goal to its next waypoint. */
  next(): void {
    if (this.waypoints.length === 0) return;
    this.index = (this.index + 1) % this.waypoints.length;
    this.timer = 0;
    this.version++;
    this.place();
  }

  private place(): void {
    const p = this.target;
    this.transform.position.set(p.x, p.y + 1, p.z);
  }
}
