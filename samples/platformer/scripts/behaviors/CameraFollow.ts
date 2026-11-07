import { GameBehavior, GameObject, Mathf, Time, behavior, field } from "myco";

/** Keeps the camera on its target, easing towards it and never below the level's floor. */
@behavior("game.CameraFollow")
export class CameraFollow extends GameBehavior {
  @field(GameObject) target: GameObject | null = null;
  @field(Number) smoothing = 6;
  @field(Number) minY = 5;

  lateUpdate(): void {
    const t = this.target?.transform;
    if (!t) return;
    const p = this.transform.position;
    const k = Math.min(1, Time.deltaTime * this.smoothing);
    p.x = Mathf.lerp(p.x, t.position.x, k);
    p.y = Mathf.lerp(p.y, Math.max(this.minY, t.position.y + 1), k);
  }
}
