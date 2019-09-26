const GameBehavior = require('./GameBehavior');
const Material = require('./Material');
const Renderer = require('./Renderer');
const Texture = require('./Texture');
const mat4 = require('gl-matrix').mat4;
const quat = require('gl-matrix').quat;
const vec3 = require('gl-matrix').vec3;
const Shader = require('./Shader');
const SpriteDefault = require('./shaders/sprite/default/SpriteDefaultShader');
const TextureLoader = require('./TextureLoader');

class SpriteRenderer extends GameBehavior {

  sprite = require('../assets/images/moderncraft.png');
  color = [1, 1, 1, 1];
  material = {
    shader: new Shader(
      require('./shaders/sprite/default/sprite-default.vert'),
      require('./shaders/sprite/default/sprite-default.frag'),
      [
        {
          name: 'aVertexPosition',
          type: 'geometry',
          componentType: Shader.AttributeType.Float,
          numComponents: 3,
          normalize: false,
          stride: 0,
          offset: 0,
          buffer: this.createGeometryBuffer
        },
        {
          name: 'aTextureCoord',
          type: 'texture',
          componentType: Shader.AttributeType.Float,
          numComponents: 2,
          normalize: false,
          stride: 0,
          offset: 0,
          buffer: this.createTextureCoordinateBuffer
        },
      ]
    )
  }

  loadedTexture;

  awake() {
    this.loadedTexture = TextureLoader.load(this.sprite, Renderer.glContext);
  }

  createGeometryBuffer(gl) {
    const positions = [
      -0.5, 0.5, 0,
      0.5, 0.5, 0,
      -0.5, -0.5, 0,
      0.5, -0.5, 0,
    ];

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

    return positionBuffer;
  }

  createNormalBuffer(gl) {
    const normals = [
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
    ];

    const normalBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);

    return normalBuffer;
  }

  createColorBuffer(gl) {
    const colors = [
      1.0, 1.0, 1.0, 1.0,    // white
      1.0, 1.0, 1.0, 1.0,    // white
      1.0, 1.0, 1.0, 1.0,    // white
      1.0, 1.0, 1.0, 1.0,    // white
    ];

    const colorBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.STATIC_DRAW);

    return colorBuffer;
  }

  createTextureCoordinateBuffer(gl) {
    const textureCoordinates = [
      1.0, 0.0,
      0.0, 0.0,
      1.0, 1.0,
      0.0, 1.0,
    ];

    const textureCoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, textureCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(textureCoordinates), gl.STATIC_DRAW);

    return textureCoordBuffer;
  }

  createModelMatrix(modelTransform) {
    let quaternion = quat.fromEuler(
      quat.create(),
      -modelTransform.rotation.x,
      -modelTransform.rotation.y,
      modelTransform.rotation.z,
    );

    const modelViewMatrix = mat4.fromRotationTranslationScale(
      mat4.create(),
      quaternion,
      [modelTransform.position.x, modelTransform.position.y, -modelTransform.position.z],
      [modelTransform.scale.x, modelTransform.scale.y, modelTransform.scale.z]
    )

    return modelViewMatrix;
  }

  render(renderTarget, viewMatrix, projectionMatrix) {
    // Calculate rendering matrices
    const modelMatrix = this.createModelMatrix(this.gameObject.transform);
    const modelViewMatrix = mat4.multiply(mat4.create(), viewMatrix, modelMatrix);
    const viewProjectionMatrix = mat4.multiply(mat4.create(), projectionMatrix, viewMatrix);
    const modelViewProjectionMatrix = mat4.multiply(mat4.create(), viewProjectionMatrix, modelMatrix);

    const shaderProgram = this.material.shader.loadShaderProgram(renderTarget);

    renderTarget.useProgram(shaderProgram);

    this.material.shader.attributes.forEach((attributeData, index) => {
      renderTarget.bindBuffer(
        renderTarget.ARRAY_BUFFER,
        attributeData.buffer(renderTarget)
      );
      renderTarget.vertexAttribPointer(
        // attributeData.boundLocation,
        renderTarget.getAttribLocation(shaderProgram, attributeData.name),
        attributeData.numComponents,
        renderTarget[attributeData.componentType],
        attributeData.normalize,
        attributeData.stride,
        attributeData.offset);
      renderTarget.enableVertexAttribArray(
        // attributeData.boundLocation
        renderTarget.getAttribLocation(shaderProgram, attributeData.name),
      );
      if (attributeData.type === 'texture') {
        renderTarget.activeTexture(renderTarget.TEXTURE0);
        renderTarget.bindTexture(renderTarget.TEXTURE_2D, this.loadedTexture);
      }
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

      renderTarget.uniform1i(
        renderTarget.getUniformLocation(shaderProgram, 'uSampler'),
        0
      );

      renderTarget.uniformMatrix4fv(
        renderTarget.getUniformLocation(shaderProgram, 'uWorldMatrix'),
        false,
        mat4.create()
      );

      renderTarget.uniform4fv(
        renderTarget.getUniformLocation(shaderProgram, "uColor"),
        this.color
      );


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

module.exports = SpriteRenderer;
