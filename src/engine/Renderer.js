const mat4 = require('gl-matrix').mat4;
const FastPriorityQueue = require('fastpriorityqueue');
const Camera = require('./Camera');

class Renderer {

  static renderQueue = new FastPriorityQueue((a, b) => {
    return a.shaderSettings.renderPriority - b.shaderSettings.renderPriority
  });

  static glContext;

  static init({ resolution }) {
    const body = document.querySelector('body');

    const canvas = document.createElement('canvas');
    canvas.setAttribute('id', 'glCanvas');
    canvas.setAttribute('width', resolution.width);
    canvas.setAttribute('height', resolution.height);

    body.appendChild(canvas);

    Renderer.glContext = canvas.getContext("webgl");
    if (Renderer.glContext === null) {
      alert("Unable to initialize WebGL. Your browser or machine may not support it.");
      return;
    }

    Renderer.glContext.clearColor(0.0, 0.0, 0.0, 1.0);
    Renderer.glContext.clear(Renderer.glContext.COLOR_BUFFER_BIT);
  }

  static drawFrame() {
    while (!this.renderQueue.isEmpty()) {
      const mat = this.renderQueue.poll();

      Renderer.drawScene(
        Renderer.glContext,
        mat.programInfo,
        mat.shaderSettings.loadGeometry(Renderer.glContext),
        mat.shaderSettings.transform,
        Camera.main
      );
    }
    this.renderQueue.trim();
  }

  static drawScene(gl, programInfo, buffers, transform, camera) {
    gl.clearColor(0.0, 0.0, 0.0, 1.0);  // Clear to black, fully opaque
    gl.clearDepth(1.0);                 // Clear everything
    gl.enable(gl.DEPTH_TEST);           // Enable depth testing
    gl.depthFunc(gl.LEQUAL);            // Near things obscure far things
    // gl.enable(gl.CULL_FACE); // Turn on culling. By default backfacing triangles will be culled.
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); // Clear the canvas before we start drawing on it.

    const fieldOfView = camera.fieldOfView * Math.PI / 180;   // in radians
    const aspect = gl.canvas.clientWidth / gl.canvas.clientHeight;
    const zNear = camera.clippingPlanes.near;
    const zFar = camera.clippingPlanes.far;
    const projectionMatrix = mat4.create();

    if (camera.projection === 'perspective') {
      mat4.perspective(
        projectionMatrix,
        fieldOfView,
        aspect,
        zNear,
        zFar
      );
    } else {
      mat4.ortho(
        projectionMatrix,
        fieldOfView,
        aspect,
        zNear,
        zFar
      );
    }


    // Set the drawing position to the "identity" point, which is
    // the center of the scene.
    const modelViewMatrix = mat4.create();

    // Now move the drawing position a bit to where we want to
    // start drawing the square.
    // console.log(position)
    mat4.translate(
      modelViewMatrix,     // destination matrix
      modelViewMatrix,     // matrix to translate
      [transform.position.x, transform.position.y, transform.position.z]);  // amount to translate
    mat4.rotate(
      modelViewMatrix,  // destination matrix
      modelViewMatrix,  // matrix to rotate
      transform.rotation.x,     // amount to rotate in radians
      [1, 0, 0]);
    mat4.rotate(
      modelViewMatrix,  // destination matrix
      modelViewMatrix,  // matrix to rotate
      transform.rotation.y,     // amount to rotate in radians
      [0, 1, 0]);
    mat4.rotate(
      modelViewMatrix,  // destination matrix
      modelViewMatrix,  // matrix to rotate
      transform.rotation.z,     // amount to rotate in radians
      [0, 0, 1]);

    // Tell WebGL how to pull out the positions from the position
    // buffer into the vertexPosition attribute.
    {
      const numComponents = 3;  // pull out 2 values per iteration
      const type = gl.FLOAT;    // the data in the buffer is 32bit floats
      const normalize = false;  // don't normalize
      const stride = 0;         // how many bytes to get from one set of values to the next
      // 0 = use type and numComponents above
      const offset = 0;         // how many bytes inside the buffer to start from
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position);
      gl.vertexAttribPointer(
        programInfo.attributeLocations.vertexPosition,
        numComponents,
        type,
        normalize,
        stride,
        offset);
      gl.enableVertexAttribArray(
        programInfo.attributeLocations.vertexPosition);
    }

    // Tell WebGL to use our program when drawing
    gl.useProgram(programInfo.program);

    // Set the shader uniforms
    gl.uniformMatrix4fv(
      programInfo.uniformLocations.projectionMatrix,
      false,
      projectionMatrix);
    gl.uniformMatrix4fv(
      programInfo.uniformLocations.modelViewMatrix,
      false,
      modelViewMatrix);

    {
      const offset = 0;
      const vertexCount = 4;
      gl.drawArrays(gl.TRIANGLE_STRIP, offset, vertexCount);
    }
  }

}

module.exports = Renderer;
