import { GameBehavior, Time, Vector3, behavior, field } from "myco";
import { myShip } from "../data";

/**
 * Follows this client's ship from above and behind, always facing north (-Z), so the mouse's
 * point on the water is a steady target. Before the ship exists it looks at the middle.
 */
@behavior("pirates.FollowCamera", { worlds: ["client"] })
export class FollowCamera extends GameBehavior {
  /** Offset from the ship. */
  @field(Vector3) offset = new Vector3(0, 20, 13);
  /** How quickly it catches up, per second. */
  @field(Number) follow = 4;

  private readonly at = new Vector3(0, 0, 0);

  update(): void {
    const ship = myShip();
    if (ship) {
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
}
