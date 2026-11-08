import { viewport } from "../engine/editor";
import { Camera, DEG2RAD, GameBehavior, GameObject, Input, Mathf, Vector3, behavior, field, type Vec3Input } from "../engine";

export type ViewMode = "3d" | "2d";

/**
 * Scene view camera (ADR 0022). Lives on the rig's root node, which sits at the focus point and
 * yaws; its "Arm" child pitches; the "Camera" child sits `distance` metres back along the arm,
 * looking at the focus point.
 *
 * 3D view: right-drag or Alt + left-drag orbits, middle-drag or Shift + right-drag pans, the
 * wheel zooms, F focuses (the selection, when the editor sets `focusTarget`). 2D view: an orthographic camera looking down -Z at the XY plane;
 * right-, middle- or Alt + left-drag pans, the wheel zooms.
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
  /** Zoom factor per pixel of wheel scroll. */
  @field(Number) zoomSpeed = 0.0015;
  @field(Number) minPitch = -89;
  @field(Number) maxPitch = 89;
  @field(Number) minDistance = 0.5;
  @field(Number) maxDistance = 500;
  @field(Number) fieldOfView = 50;

  private arm: GameObject | null = null;
  private eye: GameObject | null = null;
  private camera: Camera | null = null;
  private _mode: ViewMode = "3d";
  private saved3D = { yaw: 35, pitch: -24 };
  private lastGesture: "orbit" | "pan" | null = null;

  /** Where `focus()` and the F key go when no point is given (the editor points it at the selection). Null or unset: the origin. */
  focusTarget: (() => Vec3Input | null) | null = null;

  /** Build the Arm/Camera children under `root` and add the controller. */
  static create(root: GameObject): OrbitCamera {
    const arm = GameObject.create("Arm", { parent: root });
    const eye = GameObject.create("Camera", { parent: arm });
    eye.addBehavior(Camera, { projection: "perspective" });
    return root.addBehavior(OrbitCamera);
  }

  get mode(): ViewMode {
    return this._mode;
  }

  /** Switch between the 3D orbit view and the flat 2D view, keeping the focus point. */
  set mode(mode: ViewMode) {
    if (mode === this._mode) return;
    if (mode === "2d") {
      this.saved3D = { yaw: this.yaw, pitch: this.pitch };
      this.yaw = 0;
      this.pitch = 0;
    } else {
      ({ yaw: this.yaw, pitch: this.pitch } = this.saved3D);
    }
    this._mode = mode;
    viewport(this.world).setGrid({ plane: mode === "2d" ? "xy" : "xz" });
    this.apply();
  }

  /** The point the camera orbits and looks at. */
  get focusPoint(): Vector3 {
    return this.transform!.position.clone();
  }

  /** Move the focus point (default: `focusTarget`, else the origin), optionally the distance, keeping the view angle. */
  focus(point?: Vec3Input, distance?: number): void {
    this.transform!.position = point ?? this.focusTarget?.() ?? [0, 0, 0];
    if (distance !== undefined) this.distance = Mathf.clamp(distance, this.minDistance, this.maxDistance);
    this.apply();
  }

  awake(): void {
    this.arm = this.gameObject.find("Arm");
    this.eye = this.gameObject.find("Arm/Camera");
    this.camera = this.eye?.getBehavior(Camera) ?? null;
    this.apply();
  }

  update(): void {
    const delta = Input.mouseDelta;
    // A gesture's first frame ignores the delta: it's travel from before the button went down.
    const current = this.gesture();
    const gesture = current === this.lastGesture ? current : null;
    this.lastGesture = current;
    if (gesture === "orbit") {
      this.yaw -= delta.x * this.sensitivity;
      this.pitch = Mathf.clamp(this.pitch - delta.y * this.sensitivity, this.minPitch, this.maxPitch);
    } else if (gesture === "pan") {
      this.pan(delta.x, delta.y);
    }

    const scroll = Input.mouseScrollDelta.y;
    if (scroll !== 0) this.distance = Mathf.clamp(this.distance * Math.exp(scroll * this.zoomSpeed), this.minDistance, this.maxDistance);

    if (Input.getKeyDown("f") && !typingInField()) this.focus();
    this.apply();
  }

  private gesture(): "orbit" | "pan" | null {
    const left = Input.getMouseButton(0), middle = Input.getMouseButton(1), right = Input.getMouseButton(2);
    const alt = Input.getKey("alt"), shift = Input.getKey("shift");
    if (this._mode === "2d") return right || middle || (alt && left) ? "pan" : null;
    if (middle || (shift && right)) return "pan";
    if (right || (alt && left)) return "orbit";
    return null;
  }

  /** World-space height visible at the focus point, in metres. */
  private get viewHeight(): number {
    return 2 * this.distance * Math.tan((this.fieldOfView * DEG2RAD) / 2);
  }

  /** Drag the scene with the pointer: move the focus point against the drag, in the view plane. */
  private pan(dx: number, dy: number): void {
    const pixels = this.world.render?.canvas.clientHeight || 720;
    const perPixel = this.viewHeight / pixels;
    const yaw = this.yaw * DEG2RAD, pitch = this.pitch * DEG2RAD;
    const right = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const up = new Vector3(Math.sin(pitch) * Math.sin(yaw), Math.cos(pitch), Math.sin(pitch) * Math.cos(yaw));
    const p = this.transform!.position;
    this.transform!.position = [
      p.x - (right.x * dx - up.x * dy) * perPixel,
      p.y - (right.y * dx - up.y * dy) * perPixel,
      p.z - (right.z * dx - up.z * dy) * perPixel,
    ];
  }

  private apply(): void {
    this.yaw = ((this.yaw % 360) + 360) % 360;
    this.transform!.eulerAngles = [0, this.yaw, 0];
    if (this.arm) this.arm.transform!.eulerAngles = [this.pitch, 0, 0];
    if (this.eye) this.eye.transform!.position = [0, 0, this.distance];
    if (this.camera) {
      this.camera.projection = this._mode === "2d" ? "orthographic" : "perspective";
      this.camera.fieldOfView = this.fieldOfView;
      this.camera.orthographicSize = this.viewHeight / 2;
    }
  }
}

/** True while a text field has focus: the F key is being typed, not pressed as a shortcut. */
function typingInField(): boolean {
  const el = typeof document === "undefined" ? null : (document.activeElement as (HTMLElement & { editContext?: unknown }) | null);
  if (!el) return false;
  // The Code panel's editor types through the EditContext API on a plain element.
  if (el.isContentEditable || el.editContext || el.closest(".monaco-editor")) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) && (el as HTMLInputElement).type !== "checkbox";
}
