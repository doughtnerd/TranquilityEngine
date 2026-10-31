import { Camera, GameBehavior, GameObject, Input, Mathf, behavior, field } from "../engine";

/**
 * Scene view camera that orbits a focus point (ADR 0022). Lives on the rig's root node, which
 * sits at the focus point and yaws; its "Arm" child pitches; the "Camera" child sits `distance`
 * metres back along the arm and looks at the focus point.
 *
 * Controls: drag with the right or middle mouse button, or Alt + left button, to rotate.
 */
@behavior("editor.OrbitCamera")
export class OrbitCamera extends GameBehavior {
  /** Degrees around the vertical axis. */
  @field(Number) yaw = 35;
  /** Degrees above (negative) or below (positive) the horizon. */
  @field(Number) pitch = -24;
  @field(Number) distance = 11;
  /** Degrees of rotation per pixel dragged. */
  @field(Number) sensitivity = 0.3;
  @field(Number) minPitch = -89;
  @field(Number) maxPitch = 89;

  private arm: GameObject | null = null;
  private eye: GameObject | null = null;

  /** Build the Arm/Camera children under `root` and add the controller. */
  static create(root: GameObject): OrbitCamera {
    const arm = GameObject.create("Arm", { parent: root });
    const eye = GameObject.create("Camera", { parent: arm });
    eye.addBehavior(Camera, { projection: "perspective", fieldOfView: 50 });
    return root.addBehavior(OrbitCamera);
  }

  awake(): void {
    this.arm = this.gameObject.find("Arm");
    this.eye = this.gameObject.find("Arm/Camera");
    this.apply();
  }

  update(): void {
    if (OrbitCamera.dragging()) {
      const delta = Input.mouseDelta;
      this.yaw -= delta.x * this.sensitivity;
      this.pitch = Mathf.clamp(this.pitch - delta.y * this.sensitivity, this.minPitch, this.maxPitch);
    }
    this.apply();
  }

  private static dragging(): boolean {
    const alt = Input.getKey("alt");
    return Input.getMouseButton(2) || Input.getMouseButton(1) || (alt && Input.getMouseButton(0));
  }

  private apply(): void {
    this.yaw = ((this.yaw % 360) + 360) % 360;
    this.transform!.eulerAngles = [0, this.yaw, 0];
    if (this.arm) this.arm.transform!.eulerAngles = [this.pitch, 0, 0];
    if (this.eye) this.eye.transform!.position = [0, 0, this.distance];
  }
}
