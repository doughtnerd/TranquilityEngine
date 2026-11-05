import { GameBehavior, GameObject, Input, NavGate, Time, behavior, field } from "myco";

/**
 * Opens and closes the world's gates (Foxfire's StreamingDemoGate): every `interval` seconds, or when H is
 * pressed. A closed NavGate blocks paths through its box, so walkers go round the ends of the centre's fence;
 * a gate's "Barrier" child stands in the opening while it's closed and rises `lift` metres when it opens.
 *
 * It lives in the always-loaded main scene and keeps the state itself, so a gate whose chunk streams back in
 * takes the current state.
 */
@behavior("navdemo.GateTimer")
export class GateTimer extends GameBehavior {
  /** Seconds between opening and closing; 0 = only when H is pressed. */
  @field(Number) interval = 20;
  @field(Number) lift = 4;
  @field(Boolean) open = true;

  private timer = 0;
  /** Times toggled so far. */
  toggles = 0;

  /** The gate timer in the current World, if any. */
  static find(): GateTimer | null {
    return GameObject.findObjectOfType(GateTimer);
  }

  /** Seconds until the next toggle. */
  get timeLeft(): number {
    return this.interval > 0 ? Math.max(0, this.interval - this.timer) : Infinity;
  }

  fixedUpdate(): void {
    this.timer += Time.fixedDeltaTime;
    if (this.interval > 0 && this.timer >= this.interval) this.toggle();
    this.applyToGates();
  }

  update(): void {
    if (Input.getKeyDown("h")) this.toggle();
  }

  toggle(): void {
    this.open = !this.open;
    this.timer = 0;
    this.toggles++;
  }

  private applyToGates(): void {
    for (const gate of GameObject.findObjectsOfType(NavGate)) {
      if (gate.open !== this.open) gate.open = this.open;
      const barrier = gate.node.children.find((c) => c.name === "Barrier");
      const t = barrier?.transform;
      if (!t) continue;
      const y = this.open ? 0.5 + this.lift : 0.5;
      if (Math.abs(t.position.y - y) > 1e-3) t.position.y = y;
    }
  }
}
