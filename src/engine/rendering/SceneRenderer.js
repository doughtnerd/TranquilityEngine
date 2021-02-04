const mat4 = require('gl-matrix').mat4;
const quat = require('gl-matrix').quat;
const vec3 = require('gl-matrix').vec3;
const FastPriorityQueue = require('fastpriorityqueue');

class SceneRenderer {

  static drawFrame(camera, renderQueue) {
    camera.targetDisplay.glContext.viewport(0, 0, camera.targetDisplay.screenElement.width, camera.targetDisplay.screenElement.height)
    camera.targetDisplay.glContext.clearColor(camera.clearColor.r, camera.clearColor.g, camera.clearColor.b, camera.clearColor.a);
    camera.targetDisplay.glContext.clearDepth(1.0);                 // Clear everything
    camera.targetDisplay.glContext.enable(camera.targetDisplay.glContext.DEPTH_TEST);           // Enable depth testing
    camera.targetDisplay.glContext.enable(camera.targetDisplay.glContext.BLEND);
    camera.targetDisplay.glContext.enable(camera.targetDisplay.glContext.CULL_FACE);
    camera.targetDisplay.glContext.depthFunc(camera.targetDisplay.glContext.LEQUAL);            // Near things obscure far things
    // camera.targetDisplay.glContext.blendFunc(camera.targetDisplay.ONE, camera.targetDisplay.ONE_MINUS_SRC_ALPHA);
    camera.targetDisplay.glContext.blendFunc(camera.targetDisplay.glContext.ONE, camera.targetDisplay.glContext.ONE_MINUS_SRC_ALPHA);
    // camera.targetDisplay.glContext.blendFuncSeparate(camera.targetDisplay.SRC_ALPHA, camera.targetDisplay.ONE_MINUS_SRC_ALPHA, camera.targetDisplay.ONE, camera.targetDisplay.ZERO)
    // camera.targetDisplay.enable(camera.targetDisplay.CULL_FACE); // Turn on culling. By default backfacing triangles will be culled.
    camera.targetDisplay.glContext.clear(camera.targetDisplay.glContext.COLOR_BUFFER_BIT | camera.targetDisplay.glContext.DEPTH_BUFFER_BIT); // Clear the canvas before we start drawing on it.

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
    const projectionMatrix = camera.calculateProjectionMatrix();

    // Matrix to transform from world space to screen space
    // const viewProjectionMatrix = mat4.multiply(mat4.create(), projectionMatrix, viewMatrix);

    while (!renderQueue.isEmpty()) {
      const objectToRender = renderQueue.poll();
      // renderer.render(camera.targetDisplay, viewMatrix, projectionMatrix);
      SceneRenderer.render(camera.targetDisplay.glContext, objectToRender, viewMatrix, projectionMatrix);
    }

    renderQueue.trim();
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
      const primitiveType = renderTarget.TRIANGLES;
      const offset = 0;
      const vertexCount = 6;
      renderTarget.drawArrays(primitiveType, offset, vertexCount);
    }
  }

}

module.exports = SceneRenderer;
