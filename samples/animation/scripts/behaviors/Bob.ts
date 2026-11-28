import { GameBehavior, behavior, field, tween } from "myco";

/** Bobs its node up and down forever on one looping tween: `loops: -1` with `loopMode: "yoyo"`, started after `delay`. */
@behavior("demo.Bob")
export class Bob extends GameBehavior {
  /** How far up it goes, in units. */
  @field(Number) height = 0.5;
  /** Seconds for one trip up and back. */
  @field(Number) period = 1.6;
  /** Seconds before it starts. */
  @field(Number) delay = 0;

  start(): void {
    void tween(this.transform, "position", [0, this.height, 0], { duration: this.period / 2, relative: true, ease: "inOutSine", loops: -1, loopMode: "yoyo", delay: this.delay });
  }
}
