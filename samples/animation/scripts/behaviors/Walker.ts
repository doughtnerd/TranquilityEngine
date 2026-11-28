import { GameBehavior, SpriteRenderer, behavior, field, tween } from "myco";

/**
 * The critter on the sprites page. Its Animator plays the sheet's `walk` flipbook (images/critter.png's sidecar) on
 * start; this walks it between `from` and `to` on linear tweens and turns it round at each end with `flipX`.
 */
@behavior("demo.Walker")
export class Walker extends GameBehavior {
  @field(Number) from = -4;
  @field(Number) to = 4;
  /** Walking speed, units per second. */
  @field(Number) speed = 2;

  /** Ends reached. */
  turns = 0;

  async start(): Promise<void> {
    const sprite = this.node.getBehavior(SpriteRenderer);
    for (;;) {
      for (const x of [this.to, this.from]) {
        if (sprite) sprite.flipX = x < this.transform.position.x;
        const p = this.transform.position;
        const walk = tween(this.transform, "position", [x, p.y, p.z], { duration: Math.abs(x - p.x) / this.speed, ease: "linear" });
        if ((await walk).reason !== "finished") return;
        this.turns++;
      }
    }
  }
}
