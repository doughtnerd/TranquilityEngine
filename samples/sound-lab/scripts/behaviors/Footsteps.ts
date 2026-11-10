import { Audio, GameBehavior, Input, Text, Time, behavior, field } from "myco";

/** The labels of the project's global "Surface" parameter (`audio.parameters`), in the order of keys 1 to 4. */
const SURFACES = ["Grass", "Gravel", "Wood", "Metal"];

/**
 * Footsteps by surface (ADR 0158). Keys 1-4 pick the surface (the global labelled parameter "Surface") and take one
 * step; hold W to walk and Shift with it to run. One event, `footstep.audioevent.json`, holds a switch on Surface, each
 * surface a random container of three clips (no immediate repeat, a little random pitch and volume), so the script
 * only says which surface and when.
 */
@behavior("lab.Footsteps")
export class Footsteps extends GameBehavior {
  @field(String) event = "audio/events/footstep.audioevent.json";
  @field(String) walkKey = "w";
  @field(String) runKey = "shift";
  /** Seconds between steps. */
  @field(Number) walkInterval = 0.5;
  @field(Number) runInterval = 0.3;
  private surface = 0;
  private foot = 0;
  private next = 0;
  private steps = 0;

  start(): void {
    Audio.setParameter("Surface", SURFACES[this.surface]);
    this.show();
  }

  update(): void {
    for (let i = 0; i < SURFACES.length; i++) {
      if (!Input.getKeyDown(String(i + 1))) continue;
      this.surface = i;
      Audio.setParameter("Surface", SURFACES[i]);
      this.step(false);
    }
    if (Input.getKey(this.walkKey)) {
      const run = Input.getKey(this.runKey);
      if (Time.time >= this.next) {
        this.step(run);
        this.next = Time.time + (run ? this.runInterval : this.walkInterval);
      }
    } else this.next = 0;
  }

  private step(run: boolean): void {
    this.foot ^= 1;
    // The left and right foot differ a little in pitch; a run lands harder and a touch higher.
    Audio.play(this.event, { pitch: (this.foot ? 1.03 : 0.97) * (run ? 1.05 : 1), volume: run ? 1 : 0.8 });
    this.steps++;
    this.show();
  }

  private show(): void {
    const label = this.node.getBehavior(Text);
    if (label) label.text = `Footsteps: ${SURFACES.map((s, i) => (i === this.surface ? `[${i + 1} ${s}]` : `${i + 1} ${s}`)).join("  ")}\nW walk, Shift+W run  (steps: ${this.steps})`;
  }
}
