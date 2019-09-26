const mat4 = require('gl-matrix').mat4;
const quat = require('gl-matrix').quat;
const FastPriorityQueue = require('fastpriorityqueue');

class Renderer {

  static renderQueue = new FastPriorityQueue((a, b) => {
    return a.material.shader.renderPriority - b.material.shader.renderPriority
  });

  static canvas = document.createElement('canvas');
  static glContext;

  static init({ resolution }) {
    Renderer.canvas.setAttribute('id', 'glCanvas');
    Renderer.canvas.setAttribute('width', resolution.width);
    Renderer.canvas.setAttribute('height', resolution.height);

    const body = document.querySelector('body');
    body.appendChild(Renderer.canvas);

    Renderer.glContext = Renderer.canvas.getContext("webgl2");
    if (Renderer.glContext === null) {
      alert("Unable to initialize WebGL. Your browser or machine may not support it.");
      return;
    }

    Renderer.glContext.clearColor(0.0, 0.0, 0.0, 1.0);
    Renderer.glContext.clear(Renderer.glContext.COLOR_BUFFER_BIT);
  }

  static drawFrame(camera) {
    Renderer.glContext.viewport(0, 0, Renderer.canvas.width, Renderer.canvas.height)
    Renderer.glContext.clearColor(0.5, .5, 1.0, 1.0);  // Clear to black, fully opaque
    Renderer.glContext.clearDepth(1.0);                 // Clear everything
    Renderer.glContext.enable(Renderer.glContext.DEPTH_TEST);           // Enable depth testing
    Renderer.glContext.depthFunc(Renderer.glContext.LEQUAL);            // Near things obscure far things
    // Renderer.glContext.enable(Renderer.glContext.CULL_FACE); // Turn on culling. By default backfacing triangles will be culled.
    Renderer.glContext.clear(Renderer.glContext.COLOR_BUFFER_BIT | Renderer.glContext.DEPTH_BUFFER_BIT); // Clear the canvas before we start drawing on it.

    // Matrix representing camera transformation to correct position and orientation.
    const quaternion = quat.fromEuler(
      quat.create(),
      -camera.gameObject.transform.rotation.x,
      -camera.gameObject.transform.rotation.y,
      camera.gameObject.transform.rotation.z,
    );
    const cameraTransformationMatrix = mat4.fromRotationTranslation(
      mat4.create(),
      quaternion,
      [
        camera.gameObject.transform.position.x,
        camera.gameObject.transform.position.y,
        -camera.gameObject.transform.position.z
      ]
    );

    // Matrix to transform models vertices from world space to view space (as seen by camera). Always inverse of camera transformation matrix.
    const viewMatrix = mat4.invert(mat4.create(), cameraTransformationMatrix);

    // Matrix representing the camera frustrum, transforms the camera to screen
    const projectionMatrix = camera.calculateProjectionMatrix(Renderer.glContext);

    // Matrix to transform from world space to screen space
    // const viewProjectionMatrix = mat4.multiply(mat4.create(), projectionMatrix, viewMatrix);

    while (!this.renderQueue.isEmpty()) {
      const renderer = this.renderQueue.poll();
      renderer.render(Renderer.glContext, viewMatrix, projectionMatrix);
    }

    this.renderQueue.trim();
  }

}

module.exports = Renderer;
