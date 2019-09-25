const GameBehavior = require('./GameBehavior');
const Material = require('./Material');
const Renderer = require('./Renderer');
const Texture = require('./Texture');
const mat4 = require('gl-matrix').mat4;
const quat = require('gl-matrix').quat;

class SpriteRenderer extends GameBehavior {

  sprite = new Texture(require('../assets/images/flower.jpg'));
  color;
  material = new Material(
    require('./shaders/sprite-default/sprite-default.vert'),
    require('./shaders/sprite-default/sprite-default.frag'),
    {
      renderPriority: 0
    }
  );

  createGeometryBuffer(gl) {
    const positions = [
      -1.0, 1.0, 0.0,
      1.0, 1.0, 0.0,
      -1.0, -1.0, 0.0,
      1.0, -1.0, 0.0
    ];

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

    return positionBuffer;
  }

  createColorBuffer(gl) {
    const colors = [
      1.0, 1.0, 1.0, 1.0,    // white
      1.0, 0.0, 0.0, 1.0,    // red
      0.0, 1.0, 0.0, 1.0,    // green
      0.0, 0.0, 1.0, 1.0,    // blue
    ];

    const colorBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.STATIC_DRAW);

    return colorBuffer;
  }

  createTextureBuffer(gl) {
    const textureCoordinates = [
      0.0, 0.0,
      1.0, 0.0,
      1.0, 1.0,
      0.0, 1.0,
    ];

    const textureCoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, textureCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(textureCoordinates), gl.STATIC_DRAW);

    return textureCoordBuffer;
  }

  createModelViewMatrix(transform) {
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

    return modelViewMatrix;
  }

  render(renderTarget, viewProjectionMatrix) {
    const modelViewMatrix = this.createModelViewMatrix(this.gameObject.transform);

    //Tell WebGL to use the material's shader
    renderTarget.useProgram(this.material.programInfo.program);

    //Tell WebGL how to extract vertex positions from buffer and give it to the shader program
    {
      const numComponents = 3;  // pull out 3 values per iteration
      const type = renderTarget.FLOAT;    // the data in the buffer is 32bit floats
      const normalize = false;  // don't normalize
      const stride = 0;         // how many bytes to get from one set of values to the next
      const offset = 0;         // how many bytes inside the buffer to start from

      renderTarget.bindBuffer(
        renderTarget.ARRAY_BUFFER,
        this.createGeometryBuffer(renderTarget)
      );
      renderTarget.vertexAttribPointer(
        this.material.programInfo.attributeLocations.vertexPosition,
        numComponents,
        type,
        normalize,
        stride,
        offset);
      renderTarget.enableVertexAttribArray(
        this.material.programInfo.attributeLocations.vertexPosition
      );
    }

    // Tell WebGL how to extract colors from buffer and give it to the shader program
    {
      const numComponents = 4;
      const type = renderTarget.FLOAT;
      const normalize = false;
      const stride = 0;
      const offset = 0;
      renderTarget.bindBuffer(renderTarget.ARRAY_BUFFER, this.createColorBuffer(renderTarget));
      renderTarget.vertexAttribPointer(
        this.material.programInfo.attributeLocations.vertexColor,
        numComponents,
        type,
        normalize,
        stride,
        offset);
      renderTarget.enableVertexAttribArray(
        this.material.programInfo.attributeLocations.vertexColor);
    }

    // Tell WebGl how to pull out the texture coordinates from buffer and give it to the shader program
    {
      const numComponents = 2; // every coordinate composed of 2 values
      const type = renderTarget.FLOAT; // the data in the buffer is 32 bit float
      const normalize = false; // don't normalize
      const stride = 0; // how many bytes to get from one set to the next
      const offset = 0; // how many bytes inside the buffer to start from
      renderTarget.bindBuffer(renderTarget.ARRAY_BUFFER, this.createTextureBuffer(renderTarget));
      renderTarget.vertexAttribPointer(this.material.programInfo.attributeLocations.textureCoord, numComponents, type, normalize, stride, offset);
      renderTarget.enableVertexAttribArray(this.material.programInfo.attributeLocations.textureCoord);

      // Tell WebGL we want to affect texture unit 0
      renderTarget.activeTexture(renderTarget.TEXTURE0);

      // Bind the texture to texture unit 0
      //TODO: Texture never loads because the texture is being loaded once per frame - need to load textures/etc outside of render loop.
      renderTarget.bindTexture(renderTarget.TEXTURE_2D, this.sprite.loadTexture(renderTarget));
    }

    // Set uniforms for the shader.
    {
      renderTarget.uniformMatrix4fv(
        this.material.programInfo.uniformLocations.modelViewMatrix,
        false,
        modelViewMatrix
      );

      renderTarget.uniformMatrix4fv(
        this.material.programInfo.uniformLocations.projectionMatrix,
        false,
        viewProjectionMatrix
      );

      renderTarget.uniform2f(
        this.material.programInfo.uniformLocations.resolution,
        renderTarget.canvas.width,
        renderTarget.canvas.height
      );

      renderTarget.uniform1i(
        this.material.programInfo.uniformLocations.uSampler,
        0
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

module.exports = SpriteRenderer;
