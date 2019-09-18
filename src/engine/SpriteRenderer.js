const GameBehavior = require('./GameBehavior');
const Material = require('./Material');
const Renderer = require('./Renderer');

class SpriteRenderer extends GameBehavior {

  sprite;
  color;
  material = new Material(
    require('./shaders/sprite-default/sprite-default.vert'),
    require('./shaders/sprite-default/sprite-default.frag'),
    {
      renderPriority: 0,
      transform: this.gameObject.transform,
      loadGeometry: this.loadGeometry
    }
  );

  loadGeometry(gl) {
    // Create a buffer for the square's positions.
    const positionBuffer = gl.createBuffer();

    // Select the positionBuffer as the one to apply buffer
    // operations to from here out.
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);

    // Now create an array of positions for the square.
    const positions = [
      -1.0, 1.0, 0.0,
      1.0, 1.0, 0.0,
      -1.0, -1.0, 0.0,
      1.0, -1.0, 0.0
    ];

    // Now pass the list of positions into WebGL to build the
    // shape. We do this by creating a Float32Array from the
    // JavaScript array, then use it to fill the current buffer.
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array(positions),
      gl.STATIC_DRAW
    );

    return {
      position: positionBuffer,
    };
  }
}

module.exports = SpriteRenderer;
