import { GameBehavior, Time, behavior, field } from "myco";

/** Moves its node in a horizontal circle around the origin (the listener sits near it), so a spatial AudioSource pans, fades and moves its HRTF. */
@behavior("stress.Orbit")
export class Orbit extends GameBehavior {
  /** Circle radius in metres. */
  @field(Number) radius = 6;
  /** Turns per second; negative goes the other way. */
  @field(Number) speed = 0.25;
  /** Where on the circle it starts, in turns (0..1). */
  @field(Number) phase = 0;

  update(): void {
    const a = (Time.time * this.speed + this.phase) * Math.PI * 2;
    const p = this.transform.position;
    p.x = Math.cos(a) * this.radius;
    p.z = Math.sin(a) * this.radius;
  }
}
