const mat4 = require('gl-matrix').mat4;
const quat = require('gl-matrix').quat;
const vec3 = require('gl-matrix').vec3;
const FastPriorityQueue = require('fastpriorityqueue');

class Renderer {

  static renderQueue = new FastPriorityQueue((a, b) => {
    return a.material.shader.renderPriority - b.material.shader.renderPriority
  });

  static screen = document.createElement('canvas');
  static glContext;

  static init({ resolution }) {
    Renderer.screen.setAttribute('id', 'glCanvas');
    Renderer.screen.setAttribute('width', resolution.width);
    Renderer.screen.setAttribute('height', resolution.height);

    const body = document.querySelector('body');
    body.appendChild(Renderer.screen);

    Renderer.glContext = Renderer.screen.getContext("webgl2", {
      premultipliedAlpha: false 
    });

    if (Renderer.glContext === null) {
      alert("Unable to initialize WebGL. Your browser or machine may not support it.");
      return;
    }

    Renderer.glContext.clearColor(0.0, 0.0, 0.0, 1.0);
    Renderer.glContext.clear(Renderer.glContext.COLOR_BUFFER_BIT);
  }

  static drawFrame(camera) {
    Renderer.glContext.viewport(0, 0, Renderer.screen.width, Renderer.screen.height)
    Renderer.glContext.clearColor(camera.clearColor.r, camera.clearColor.g, camera.clearColor.b, camera.clearColor.a);
    Renderer.glContext.clearDepth(1.0);                 // Clear everything
    Renderer.glContext.enable(Renderer.glContext.DEPTH_TEST);           // Enable depth testing
    Renderer.glContext.enable(Renderer.glContext.BLEND);
    Renderer.glContext.depthFunc(Renderer.glContext.LEQUAL);            // Near things obscure far things
    // Renderer.glContext.blendFunc(Renderer.glContext.ONE, Renderer.glContext.ONE_MINUS_SRC_ALPHA);
    Renderer.glContext.blendFunc(Renderer.glContext.SRC_ALPHA, Renderer.glContext.ONE_MINUS_SRC_ALPHA);
    // Renderer.glContext.blendFuncSeparate(Renderer.glContext.SRC_ALPHA, Renderer.glContext.ONE_MINUS_SRC_ALPHA, Renderer.glContext.ONE, Renderer.glContext.ZERO)
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
      // renderer.render(Renderer.glContext, viewMatrix, projectionMatrix);
      Renderer.render(Renderer.glContext, renderer, viewMatrix, projectionMatrix);
    }

    this.renderQueue.trim();
  }


  static render(renderTarget, renderData, viewMatrix, projectionMatrix) {
    const modelMatrix = renderData.gameObjectTransform.createModelMatrix();
    const modelViewMatrix = mat4.multiply(mat4.create(), viewMatrix, modelMatrix);
    const viewProjectionMatrix = mat4.multiply(mat4.create(), projectionMatrix, viewMatrix);
    const modelViewProjectionMatrix = mat4.multiply(mat4.create(), viewProjectionMatrix, modelMatrix);

    const shaderProgram = renderData.material.shader.shaderProgram

    renderTarget.useProgram(shaderProgram);

    renderData.material.attributes.forEach((attributeData, index) => {
      renderTarget.bindBuffer(
        renderTarget.ARRAY_BUFFER,
        attributeData.buffer
      );
      renderTarget.vertexAttribPointer(
        renderTarget.getAttribLocation(shaderProgram, attributeData.name),
        attributeData.numComponents,
        renderTarget[attributeData.componentType],
        attributeData.normalize,
        attributeData.stride,
        attributeData.offset);
      renderTarget.enableVertexAttribArray(
        renderTarget.getAttribLocation(shaderProgram, attributeData.name),
      );
    });

    {
      renderTarget.uniformMatrix4fv(
        renderTarget.getUniformLocation(shaderProgram, 'uModelMatrix'),
        false,
        modelMatrix
      );

      renderTarget.uniformMatrix4fv(
        renderTarget.getUniformLocation(shaderProgram, 'uModelViewMatrix'),
        false,
        modelViewMatrix
      );

      renderTarget.uniformMatrix4fv(
        renderTarget.getUniformLocation(shaderProgram, 'uViewProjectionMatrix'),
        false,
        viewProjectionMatrix
      );

      renderTarget.uniformMatrix4fv(
        renderTarget.getUniformLocation(shaderProgram, 'uModelViewProjectionMatrix'),
        false,
        modelViewProjectionMatrix
      );

      renderTarget.uniform2f(
        renderTarget.getUniformLocation(shaderProgram, 'uResolution'),
        renderTarget.canvas.width,
        renderTarget.canvas.height
      );

      renderTarget.uniformMatrix4fv(
        renderTarget.getUniformLocation(shaderProgram, 'uWorldMatrix'),
        false,
        mat4.create()
      );

      let index = 0;
      for (const key in renderData.material.textures) {
        renderTarget.activeTexture(renderTarget.TEXTURE0 + index);
        // TODO: Fix loaded texture thingy
        renderTarget.bindTexture(renderTarget.TEXTURE_2D, renderData.material.textures[key]);


        renderTarget.uniform1i(
          renderTarget.getUniformLocation(shaderProgram, key),
          index
        );

        index++;
      }

      index = 0;
      for (const key in renderData.material.colors) {
        renderTarget.uniform4fv(
          renderTarget.getUniformLocation(shaderProgram, key),
          renderData.material.colors[key]
        );
      }

      // const lightPosition = vec3.fromValues(0, 0, -1);
      // const modelWorldPosition = vec3.fromValues(this.gameObject.transform.position.x, this.gameObject.transform.position.y, this.gameObject.transform.position.z);
      // const lightDirection = vec3.subtract([0, 0, 0], modelWorldPosition, lightPosition);
      // vec3.normalize(lightDirection, lightDirection);

      const lightVector = [0, 1, 1];
      vec3.normalize(lightVector, lightVector);

      renderTarget.uniform3fv(
        renderTarget.getUniformLocation(shaderProgram, "uLightingDirection"),
        // vec3.normalize(lightDirection, lightDirection)
        lightVector
      );
    }

    //Draw
    {
      const offset = 0;
      const vertexCount = 4;
      renderTarget.drawArrays(renderTarget.TRIANGLE_STRIP, offset, vertexCount);
    }
  }

}

module.exports = Renderer;
