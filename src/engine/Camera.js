const GameBehavior = require('./GameBehavior');
const mat4 = require('gl-matrix').mat4;

class Camera extends GameBehavior {

  static main;

  clearFlags = 1;
  background;
  cullingMask;
  clearColor = {
    r: .5,
    g: .5,
    b: 1,
    a: 1
  };
  projection = Camera.ProjectionType.Perspective;
  fieldOfView = 80;
  clippingPlanes = {
    near: 0.1,
    far: 100
  };
  viewPortRect = {
    x: 0,
    y: 0,
    w: 1,
    h: 1
  };
  orthogonalBounds = {
    l: -10,
    r: 10,
    b: -10,
    t: 10,
  };
  depth = -1;

  calculateProjectionMatrix(targetDisplay) {
    const fieldOfView = this.fieldOfView * Math.PI / 180;   // in radians
    const aspect = targetDisplay.canvas.clientWidth / targetDisplay.canvas.clientHeight;
    const zNear = this.clippingPlanes.near;
    const zFar = this.clippingPlanes.far;
    const projectionMatrix = mat4.create();

    switch (this.projection) {
      case Camera.ProjectionType.Perspective:
        mat4.perspective(
          projectionMatrix,
          fieldOfView,
          aspect,
          zNear,
          zFar
        );
        break;
      case Camera.ProjectionType.Orthographic:
        const halfHeight = targetDisplay.canvas.clientHeight / 2;
        const halfWidth = targetDisplay.canvas.clientWidth / 2;
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

  static ProjectionType = {
    Perspective: 'perspective',
    Orthographic: 'orthographic'
  };

}

module.exports = Camera;
