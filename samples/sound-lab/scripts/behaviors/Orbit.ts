import { GameBehavior, Time, behavior, field } from "myco";

/** Moves its node in a horizontal circle, so its AudioSource pans and fades as it goes. */
@behavior("lab.Orbit")
export class Orbit extends GameBehavior {
  /** Circle radius in metres. */
  @field(Number) radius = 6;
  /** Revolutions per second. */
  @field(Number) speed = 0.25;
  /** Where on the circle it starts, in turns (0..1). */
  @field(Number) phase = 0;
  /** The circle's centre on the ground plane (x, z), in metres: the origin, or the listener's spot to circle the head. */
  @field(Number) centerX = 0;
  @field(Number) centerZ = 0;

  update(): void {
    const a = (Time.time * this.speed + this.phase) * Math.PI * 2;
    const p = this.transform.position;
    p.x = this.centerX + Math.cos(a) * this.radius;
    p.z = this.centerZ - Math.sin(a) * this.radius;
  }
}
