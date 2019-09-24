const mat4 = require('gl-matrix').mat4;
const quat = require('gl-matrix').quat;
const FastPriorityQueue = require('fastpriorityqueue');

class Renderer {

  static renderQueue = new FastPriorityQueue((a, b) => {
    return a.material.shaderSettings.renderPriority - b.material.shaderSettings.renderPriority
  });

  static canvas = document.createElement('canvas');
  static glContext;

  static init({ resolution }) {
    Renderer.canvas.setAttribute('id', 'glCanvas');
    Renderer.canvas.setAttribute('width', resolution.width);
    Renderer.canvas.setAttribute('height', resolution.height);

    const body = document.querySelector('body');
    body.appendChild(Renderer.canvas);

    Renderer.glContext = Renderer.canvas.getContext("webgl");
    if (Renderer.glContext === null) {
      alert("Unable to initialize WebGL. Your browser or machine may not support it.");
      return;
    }

    Renderer.glContext.clearColor(0.0, 0.0, 0.0, 1.0);
    Renderer.glContext.clear(Renderer.glContext.COLOR_BUFFER_BIT);
  }

  static drawFrame(camera) {
    Renderer.glContext.clearColor(0.0, 0.0, 0.0, 1.0);  // Clear to black, fully opaque
    Renderer.glContext.clearDepth(1.0);                 // Clear everything
    Renderer.glContext.enable(Renderer.glContext.DEPTH_TEST);           // Enable depth testing
    Renderer.glContext.depthFunc(Renderer.glContext.LEQUAL);            // Near things obscure far things
    // Renderer.glContext.enable(Renderer.glContext.CULL_FACE); // Turn on culling. By default backfacing triangles will be culled.
    Renderer.glContext.clear(Renderer.glContext.COLOR_BUFFER_BIT | Renderer.glContext.DEPTH_BUFFER_BIT); // Clear the canvas before we start drawing on it.

    const projectionMatrix = camera.calculateProjectionMatrix(Renderer.glContext);

    const quaternion = quat.fromEuler(
      quat.create(),
      -camera.gameObject.transform.rotation.x,
      -camera.gameObject.transform.rotation.y,
      camera.gameObject.transform.rotation.z,
    );
    const cameraPositionMatrix = mat4.fromRotationTranslation(
      mat4.create(),
      quaternion,
      [
        camera.gameObject.transform.position.x,
        camera.gameObject.transform.position.y,
        -camera.gameObject.transform.position.z
      ]
    );

    const worldPositionMatrix = mat4.invert(mat4.create(), cameraPositionMatrix);
    const viewProjectionMatrix = mat4.multiply(mat4.create(), projectionMatrix, worldPositionMatrix);

    while (!this.renderQueue.isEmpty()) {
      // const mat = this.renderQueue.poll();

      // Renderer.drawObject(
      //   Renderer.glContext,
      //   mat.programInfo,
      //   mat.shaderSettings.loadGeometry(Renderer.glContext),
      //   mat.shaderSettings.loadTexture(Renderer.glContext),
      //   mat.shaderSettings.transform,
      //   viewProjectionMatrix
      // );

      const renderer = this.renderQueue.poll();
      renderer.render(Renderer.glContext, viewProjectionMatrix);

    }
    this.renderQueue.trim();
  }

  static drawObject(gl, programInfo, buffers, texture, transform, viewProjectionMatrix) {

    let quaternion = quat.fromEuler(
      quat.create(),
      -transform.rotation.x,
      -transform.rotation.y,
      transform.rotation.z,
    );
    const modelViewMatrix = mat4.fromRotationTranslationScale(
      mat4.create(),
      quaternion,
      [transform.position.x, transform.position.y, -transform.position.z],
      [transform.scale.x, transform.scale.y, transform.scale.z]
    )

    // Tell WebGL how to pull out the positions from the position
    // buffer into the vertexPosition attribute.
    {
      const numComponents = 3;  // pull out 3 values per iteration
      const type = gl.FLOAT;    // the data in the buffer is 32bit floats
      const normalize = false;  // don't normalize
      const stride = 0;         // how many bytes to get from one set of values to the next
      const offset = 0;         // how many bytes inside the buffer to start from

      gl.bindBuffer(
        gl.ARRAY_BUFFER,
        buffers.position
      );
      gl.vertexAttribPointer(
        programInfo.attributeLocations.vertexPosition,
        numComponents,
        type,
        normalize,
        stride,
        offset);
      gl.enableVertexAttribArray(
        programInfo.attributeLocations.vertexPosition
      );
    }

    // How to extract color data from color buffer.
    {
      const numComponents = 4;
      const type = gl.FLOAT;
      const normalize = false;
      const stride = 0;
      const offset = 0;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.color);
      gl.vertexAttribPointer(
        programInfo.attributeLocations.vertexColor,
        numComponents,
        type,
        normalize,
        stride,
        offset);
      gl.enableVertexAttribArray(
        programInfo.attributeLocations.vertexColor);
    }

    // tell webgl how to pull out the texture coordinates from buffer
    {
      const num = 2; // every coordinate composed of 2 values
      const type = gl.FLOAT; // the data in the buffer is 32 bit float
      const normalize = false; // don't normalize
      const stride = 0; // how many bytes to get from one set to the next
      const offset = 0; // how many bytes inside the buffer to start from
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.textureCoord);
      gl.vertexAttribPointer(programInfo.attributeLocations.textureCoord, num, type, normalize, stride, offset);
      gl.enableVertexAttribArray(programInfo.attributeLocations.textureCoord);
    }

    gl.useProgram(programInfo.program);

    gl.uniformMatrix4fv(
      programInfo.uniformLocations.projectionMatrix,
      false,
      viewProjectionMatrix);
    gl.uniformMatrix4fv(
      programInfo.uniformLocations.modelViewMatrix,
      false,
      modelViewMatrix);
    gl.uniform2f(
      programInfo.uniformLocations.resolution,
      gl.canvas.width,
      gl.canvas.height
    );

    {
      // Tell WebGL we want to affect texture unit 0
      gl.activeTexture(gl.TEXTURE0);

      // Bind the texture to texture unit 0
      gl.bindTexture(gl.TEXTURE_2D, texture);

      // Tell the shader we bound the texture to texture unit 0
      gl.uniform1i(programInfo.uniformLocations.uSampler, 0);
    }

    {
      const offset = 0;
      const vertexCount = 4;
      gl.drawArrays(gl.TRIANGLE_STRIP, offset, vertexCount);
    }
  }

}

module.exports = Renderer;
