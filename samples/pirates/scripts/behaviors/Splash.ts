import { GameBehavior, GameObject, MeshRenderer, Time, behavior, field } from "myco";

/** A client-side splash: a white blob that grows, flattens and fades, then removes itself. */
@behavior("pirates.Splash", { worlds: ["client"] })
export class Splash extends GameBehavior {
  /** Seconds it lasts. */
  @field(Number) life = 0.7;
  private age = 0;
  private size = 1;

  start(): void {
    this.size = this.node.transform!.scale.x;
  }

  update(): void {
    this.age += Time.deltaTime;
    const t = Math.min(1, this.age / this.life);
    const s = this.size * (0.4 + t * 1.4);
    this.node.transform!.scale.set(s, this.size * (1.6 - t * 1.5), s);
    this.node.getBehavior(MeshRenderer)?.setMaterialProperty("color", [1, 1, 1, 1 - t]);
    if (t >= 1) GameObject.destroy(this.node);
  }
}
