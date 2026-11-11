import { GameBehavior, Input, Time, behavior, field } from "myco";

/**
 * Walks the listener (this node, usually the camera) along the spatial scene's corridor: W forward (+z, the way the camera looks), S back, at
 * `speed` metres per second, and the number keys jump to stations. The audio system reads the node's motion as the
 * listener's velocity, so walking past a moving source shifts its pitch like a real one.
 */
@behavior("lab.Walker")
export class Walker extends GameBehavior {
  @field(String) forwardKey = "w";
  @field(String) backKey = "s";
  /** Metres per second. */
  @field(Number) speed = 4;
  /** Walking stops at these z positions (the room's back wall and the cave's end). */
  @field(Number) minZ = -14;
  @field(Number) maxZ = 22;
  /** Station keys 1, 2 and 3 jump to these z positions: the room, the corridor and the cave. */
  @field(Number) room = -11;
  @field(Number) corridor = 0;
  @field(Number) cave = 16;

  update(): void {
    const p = this.transform.position;
    const go = (Input.getKey(this.forwardKey) ? 1 : 0) - (Input.getKey(this.backKey) ? 1 : 0);
    p.z = Math.min(this.maxZ, Math.max(this.minZ, p.z + go * this.speed * Time.deltaTime));
    const stations = [this.room, this.corridor, this.cave];
    for (let i = 0; i < stations.length; i++) if (Input.getKeyDown(String(i + 1))) p.z = stations[i];
  }
}
