import GameObject from "./GameObject";
import Camera from "./rendering/Camera";

export default class CameraObject extends GameObject {
  constructor(name = "Camera") {
    super(name);
    this.addBehavior(Camera);
  }
}
