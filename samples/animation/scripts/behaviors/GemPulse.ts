import { GameBehavior, GameObject, behavior, field, sequence, tween, type AnimationEvent, type Tween } from "myco";

/**
 * Beside the Lantern's Animator, which plays clips/lantern.anim.json (the gem's bob and turn, the glow's colour): the
 * clip's `chime` notify, at the top of each bob, makes the gem swell and spring back. The clip keys the gem's position
 * and rotation, so its scale is free for this tween.
 */
@behavior("demo.GemPulse")
export class GemPulse extends GameBehavior {
  @field(GameObject) gem: GameObject | null = null;
  /** The gem's size between chimes. */
  @field(Number) size = 0.55;

  /** Chimes heard. */
  chimes = 0;
  private pulse: Tween | null = null;

  /** The lantern clip's `chime` notify (an `event` track key at 1.5 s, with the argument "top"). */
  chime(_e: AnimationEvent): void {
    this.chimes++;
    const gem = this.gem?.transform;
    if (!gem) return;
    this.pulse?.stop();
    const s = this.size;
    this.pulse = sequence(
      tween(gem, "scale", [s * 1.45, s * 1.45, s * 1.45], { duration: 0.12, ease: "outQuad" }),
      tween(gem, "scale", [s, s, s], { duration: 0.7, ease: "outElastic" }),
    );
  }
}
