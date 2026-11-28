import { GameBehavior, Quaternion, behavior, field, parallel, sequence, tween, type TweenEase } from "myco";

/**
 * Tweens from script on this node's children, one easing per cube (named after its easing: "Cube outBounce"…). Each
 * round, all rise together (`parallel`), turn a quarter in turn (`sequence`), and fall together; the next round starts
 * when the last one's promise resolves. The loop ends when a tween stops for any reason other than finishing (the node
 * was destroyed, or play stopped).
 */
@behavior("demo.TweenShowcase")
export class TweenShowcase extends GameBehavior {
  /** How high the cubes rise, in metres. */
  @field(Number) height = 2.2;
  /** Seconds to rise and to fall. */
  @field(Number) duration = 1.2;

  /** Rounds finished. */
  rounds = 0;

  async start(): Promise<void> {
    const nodes = this.node.children.filter((c) => c.name.startsWith("Cube ") && c.transform);
    const eases = nodes.map((c) => c.name.slice("Cube ".length) as TweenEase);
    const cubes = nodes.map((c) => c.transform!);
    const ground = cubes.map((t) => t.position.y);
    let turn = 0;
    for (;;) {
      const rise = parallel(...cubes.map((t, i) => tween(t, "position", [t.position.x, ground[i]! + this.height, 0], { duration: this.duration, ease: eases[i] })));
      if ((await rise).reason !== "finished") return;
      turn++;
      const spin = sequence(...cubes.map((t) => tween(t, "rotation", Quaternion.rotateY((turn * Math.PI) / 2), { duration: 0.25, ease: "outBack" })));
      if ((await spin).reason !== "finished") return;
      const fall = parallel(...cubes.map((t, i) => tween(t, "position", [t.position.x, ground[i]!, 0], { duration: this.duration, ease: eases[i] })));
      if ((await fall).reason !== "finished") return;
      this.rounds++;
    }
  }
}
