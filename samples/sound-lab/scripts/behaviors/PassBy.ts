import { GameBehavior, Time, behavior, field } from "myco";

/**
 * A pass-by for the Doppler effect: moves its node along the z axis from `from` to `to` at a steady speed and back
 * again, forever, so a listener near the line hears the source come, pass and go (pitch up while it approaches, down as
 * it leaves). Position comes from the clock, so the speed the audio system estimates from the motion is smooth. Pair it
 * with an AudioSource whose `dopplerLevel` is 1 (the default).
 */
@behavior("lab.PassBy")
export class PassBy extends GameBehavior {
  /** Start of the run, z in metres. */
  @field(Number) from = -40;
  /** End of the run, z in metres. */
  @field(Number) to = 40;
  /** Metres per second. The speed of sound is 343, so 30 shifts the pitch by about 9% each way. */
  @field(Number) speed = 30;

  update(): void {
    const length = Math.abs(this.to - this.from);
    if (length === 0 || this.speed <= 0) return;
    const along = (Time.time * this.speed) % (2 * length);
    const d = along < length ? along : 2 * length - along;
    this.transform.position.z = this.from + ((this.to - this.from) * d) / length;
  }
}
