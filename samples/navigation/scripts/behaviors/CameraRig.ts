import { DEG2RAD, GameBehavior, Input, Mathf, Quaternion, Time, Vector3, behavior, field } from "myco";
import { Tour } from "./Tour";

/**
 * An orbit camera over the world (Foxfire's fly camera, as an orbit): it circles `focus` at `distance`, looking
 * down by `pitch`. It follows the tour's goal until you move it, and doesn't affect streaming (the streamer
 * follows the agents).
 *
 * WASD or the arrows pan, Q/E orbit, R/F tilt, Z/X (or the mouse wheel) zoom, Shift is faster, right-drag orbits
 * and tilts, C follows the goal again.
 */
@behavior("navdemo.CameraRig")
export class CameraRig extends GameBehavior {
  @field(Vector3) focus = new Vector3(0, 0, 0);
  @field(Number) distance = 70;
  /** Degrees round the vertical; 0 looks north (-z). */
  @field(Number) yaw = 0;
  /** Degrees; negative looks down. */
  @field(Number) pitch = -40;
  @field(Number) panSpeed = 40;
  @field(Boolean) followGoal = true;

  lateUpdate(): void {
    const dt = Time.unscaledDeltaTime;
    const fast = Input.getKey("shift") ? 3 : 1;
    const key = (...names: string[]) => names.some((n) => Input.getKey(n));

    // Pan along the ground, relative to where the camera faces.
    const yaw = this.yaw * DEG2RAD;
    const forward = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    let px = 0, pz = 0;
    if (key("w", "arrowup")) pz += 1;
    if (key("s", "arrowdown")) pz -= 1;
    if (key("d", "arrowright")) px += 1;
    if (key("a", "arrowleft")) px -= 1;
    if (px !== 0 || pz !== 0) {
      this.followGoal = false;
      const step = this.panSpeed * fast * dt * Math.max(0.5, this.distance / 70);
      this.focus.x += (forward.x * pz + right.x * px) * step;
      this.focus.z += (forward.z * pz + right.z * px) * step;
    }
    if (Input.getKeyDown("c")) this.followGoal = true;
    if (this.followGoal) {
      const goal = Tour.find()?.target;
      if (goal) {
        const k = 1 - Math.exp(-2 * dt);
        this.focus.x += (goal.x - this.focus.x) * k;
        this.focus.y += (goal.y - this.focus.y) * k;
        this.focus.z += (goal.z - this.focus.z) * k;
      }
    }

    if (key("q")) this.yaw += 60 * fast * dt;
    if (key("e")) this.yaw -= 60 * fast * dt;
    if (key("r")) this.pitch += 40 * dt;
    if (key("f")) this.pitch -= 40 * dt;
    if (key("z")) this.distance *= Math.exp(-1.2 * fast * dt);
    if (key("x")) this.distance *= Math.exp(1.2 * fast * dt);
    if (Input.getMouseButton(2)) {
      const d = Input.mouseDelta;
      this.yaw -= d.x * 0.25;
      this.pitch -= d.y * 0.25;
    }
    const scroll = Input.mouseScrollDelta.y;
    if (scroll !== 0) this.distance *= Math.exp(scroll * 0.001);
    this.pitch = Mathf.clamp(this.pitch, -89, -5);
    this.distance = Mathf.clamp(this.distance, 10, 500);
    this.place();
  }

  start(): void {
    this.place();
  }

  /** Puts the camera `distance` back from the focus along its view direction. */
  private place(): void {
    const y = (this.yaw * DEG2RAD) / 2, p = (this.pitch * DEG2RAD) / 2;
    const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p);
    // yaw (round +Y) then pitch (round the camera's X): q = qYaw * qPitch.
    const q = new Quaternion(cy * sp, sy * cp, -sy * sp, cy * cp);
    const yaw = this.yaw * DEG2RAD, pitch = this.pitch * DEG2RAD;
    const look = new Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    this.transform.position.set(this.focus.x - look.x * this.distance, this.focus.y - look.y * this.distance, this.focus.z - look.z * this.distance);
    this.transform.rotation = q;
  }
}
