import { Color, GameBehavior, Mathf, MeshRenderer, Quaternion, Time, Water, behavior, field } from "myco";
import { HULL_HALF_LENGTH, HULL_HALF_WIDTH, TEAM_COLORS } from "../data";

/**
 * The sea behind the menu: the camera drifts slowly round the bay and the ships (children named
 * `Ship…`, each with a `Visual` holding `Hull` and `Sails`) sail lazy circles, floating on the
 * waves with their team's sails.
 */
@behavior("pirates.MenuBackdrop")
export class MenuBackdrop extends GameBehavior {
  /** Degrees a second the camera drifts round. */
  @field(Number) drift = 2;
  /** The camera's distance from the middle and height. */
  @field(Number) distance = 44;
  @field(Number) height = 13;

  private readonly tinted = new Set<MeshRenderer>();

  update(): void {
    const t = Time.time;
    const camera = this.node.find("Camera")?.transform;
    if (camera) {
      const a = (t * this.drift + 200) * Mathf.Deg2Rad;
      camera.position.set(Math.sin(a) * this.distance, this.height, -Math.cos(a) * this.distance);
      // Look at a point beside the middle, so the menu's cards leave the ships in view.
      // (A camera looks along +Z at yaw 0, so from (sin a, -cos a) toward the middle is yaw -a.)
      const tilt = 12 * Mathf.Deg2Rad;
      camera.eulerAngles = [tilt, tilt - a, 0]; // 12 degrees down, whatever the yaw (ZXY, ADR 0163)
    }
    let i = 0;
    for (const ship of this.node.children) {
      if (!ship.name.startsWith("Ship")) continue;
      const team = i++;
      const radius = 14 + team * 7;
      const speed = (0.11 - team * 0.02) * (team % 2 ? -1 : 1);
      const a = t * speed + team * 2.1;
      const x = Math.sin(a) * radius, z = -Math.cos(a) * radius;
      // Along the circle: forward (sin yaw, cos yaw) is (cos a, sin a) times the direction of travel.
      const yaw = Math.PI / 2 - a + (speed > 0 ? 0 : Math.PI);
      ship.transform!.position.set(x, 0, z);
      ship.transform!.rotation = Quaternion.fromEuler(0, yaw, 0);
      const visual = ship.find("Visual")?.transform;
      if (!visual) continue;
      const at = (lx: number, lz: number) => {
        const w = ship.transform!.localToWorld.transformPoint({ x: lx, y: 0, z: lz });
        return Water.sample(w.x, w.z)?.height ?? 0;
      };
      const bow = at(0, HULL_HALF_LENGTH), stern = at(0, -HULL_HALF_LENGTH);
      const port = at(-HULL_HALF_WIDTH, 0), star = at(HULL_HALF_WIDTH, 0);
      visual.position.set(0, (bow + stern + port + star) / 4 - 0.1, 0);
      visual.rotation = Quaternion.fromEuler(Math.atan2(stern - bow, HULL_HALF_LENGTH * 2), 0, Math.atan2(star - port, HULL_HALF_WIDTH * 2) * 0.6);
      const sails = ship.find("Visual/Sails")?.getBehavior(MeshRenderer);
      if (sails && !this.tinted.has(sails)) {
        sails.setMaterialProperty("color", Color.from(TEAM_COLORS[(team * 3) % TEAM_COLORS.length]));
        this.tinted.add(sails);
      }
    }
  }
}
