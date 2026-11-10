import { GameBehavior, Time, behavior, field } from "myco";

/** Moves its node round the listener in a horizontal circle, so its AudioSource pans and fades as it goes. */
@behavior("lab.Orbit")
export class Orbit extends GameBehavior {
  /** Circle radius in metres. */
  @field(Number) radius = 6;
  /** Revolutions per second. */
  @field(Number) speed = 0.25;

  update(): void {
    const a = Time.time * this.speed * Math.PI * 2;
    const p = this.transform.position;
    p.x = Math.cos(a) * this.radius;
    p.z = Math.sin(a) * this.radius;
  }
}
