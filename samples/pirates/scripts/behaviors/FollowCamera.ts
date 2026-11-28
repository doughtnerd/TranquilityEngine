import { CameraShake, GameBehavior, Time, Vector3, behavior, field } from "myco";
import { SHIP_HP, myShip } from "../data";

/**
 * Follows this client's ship from above and behind, always facing north (-Z), so the mouse's
 * point on the water is a steady target. Before the ship exists it looks at the middle. When the ship takes a hit,
 * its `CameraShake` (ADR 0436) gives the view a jolt that grows with the damage: a bump for a cannonball or a ram, an
 * explosion for a lightning strike. Only the drawn view shakes; the follow position and the aim ray stay steady.
 */
@behavior("pirates.FollowCamera", { worlds: ["client"] })
export class FollowCamera extends GameBehavior {
  /** Offset from the ship. */
  @field(Vector3) offset = new Vector3(0, 20, 13);
  /** How quickly it catches up, per second. */
  @field(Number) follow = 4;

  /** Hull lost in one frame that shakes the view (smaller losses, like the arena's edge, don't). */
  @field(Number) minShakeDamage = 2;

  private readonly at = new Vector3(0, 0, 0);
  /** This ship's hull last frame. */
  private lastHp = SHIP_HP;

  update(): void {
    const ship = myShip();
    if (ship) {
      this.feelHits(ship.data.hp, ship.data.sunk > 0);
      const p = ship.node.transform!.position;
      const k = 1 - Math.exp(-this.follow * Time.deltaTime);
      this.at.set(this.at.x + (p.x - this.at.x) * k, 0, this.at.z + (p.z - this.at.z) * k);
    }
    const t = this.node.transform!;
    t.position.set(this.at.x + this.offset.x, this.offset.y, this.at.z + this.offset.z);
    const pitch = Math.atan2(this.offset.y, Math.hypot(this.offset.x, this.offset.z));
    // Turned half round to face -Z, then tilted down: Euler angles (radians) apply roll, pitch, then
    // yaw (ZXY, ADR 0163), so the pitch is about the camera's own X axis and a positive one looks down.
    t.eulerAngles = [pitch, Math.PI, 0];
  }

  /** Shakes the view when the hull dropped since last frame (and the ship isn't sinking). */
  private feelHits(hp: number, sunk: boolean): void {
    const lost = this.lastHp - hp;
    this.lastHp = hp;
    if (sunk || lost < this.minShakeDamage) return;
    const shake = this.node.getBehavior(CameraShake);
    if (!shake) return;
    const strength = 0.6 + 1.4 * Math.min(1, lost / 20);
    shake.shake(lost >= 15 ? "explosion" : "bump", strength);
  }
}
