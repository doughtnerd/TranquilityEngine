import FastPriorityQueue from "fastpriorityqueue";
import GameBehavior from "../GameBehavior";
import SceneManager from "../SceneManager";
import Screen from "./Screen";
import SceneRenderer from "./SceneRenderer";
import Renderer from "./Renderer";

import { mat4 } from "gl-matrix";

export default class Camera extends GameBehavior {
  static ProjectionType = {
    Perspective: "perspective",
    Orthographic: "orthographic",
  };

  renderQueue = new FastPriorityQueue((a, b) => {
    return a.rendererPriority < b.rendererPriority;
  });

  static main;
  static allCameras;
  static allCamerasCount;
  static current;
  static onPreCull;
  static onPreRender;
  static onPostRender;

  depth = 0;
  clearFlags = 1;
  background;
  cullingMask;
  clearColor = {
    r: 0.5,
    g: 0.5,
    b: 1,
    a: 1,
  };
  targetDisplay = null;
  targetDisplayIndex = 0;
  projection = Camera.ProjectionType.Perspective;
  fieldOfView = 80;
  clippingPlanes = {
    near: 0.1,
    far: 100,
  };
  viewPortRect = {
    x: 0,
    y: 0,
    w: 1,
    h: 1,
  };
  orthogonalBounds = {
    l: -10,
    r: 10,
    b: -10,
    t: 10,
  };
  depth = -1;

  awake() {
    this.targetDisplay = Screen.getScreen(this.targetDisplayIndex);
    const cameras = SceneManager.activeScene.findObjectsOfType(Camera);
    if (cameras.length >= 1) {
      Camera.main = cameras[0];
    }
    Camera.allCamerasCount = cameras.length;
    Camera.allCameras = cameras;
  }

  onEnable() {}

  update() {}

  render() {
    SceneManager.activeScene.findObjectsOfType(Renderer).forEach((renderer) => {
      renderer.material.load(this.targetDisplay.glContext);

      this.renderQueue.add({
        rendererPriority: renderer.rendererPriority,
        gameObjectTransform: renderer.gameObject.transform,
        material: renderer.material,
      });
    });

    // console.debug(this.renderQueue);

    SceneRenderer.drawFrame(this, this.renderQueue);
  }

  calculateProjectionMatrix() {
    const fieldOfView = (this.fieldOfView * Math.PI) / 180; // in radians
    const aspect = this.targetDisplay.screen.canvasElement.clientWidth / this.targetDisplay.screen.screenElement.clientHeight;
    const zNear = this.clippingPlanes.near;
    const zFar = this.clippingPlanes.far;
    const projectionMatrix = mat4.create();

    switch (this.projection) {
      case Camera.ProjectionType.Perspective:
        mat4.perspective(projectionMatrix, fieldOfView, aspect, zNear, zFar);
        break;
      case Camera.ProjectionType.Orthographic:
        const halfHeight = this.targetDisplay.screen.canvasElement.clientHeight / 2;
        const halfWidth = this.targetDisplay.screen.canvasElement.clientWidth / 2;
        mat4.ortho(
          projectionMatrix,
          this.orthogonalBounds.l * aspect,
          this.orthogonalBounds.r * aspect,
          this.orthogonalBounds.b,
          this.orthogonalBounds.t,
          this.clippingPlanes.near,
          this.clippingPlanes.far
        );
        break;
    }

    return projectionMatrix;
  }
}
