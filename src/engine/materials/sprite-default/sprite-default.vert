attribute vec4 aVertexPosition;
attribute vec2 aTextureCoord;

uniform mat4 uModelViewProjectionMatrix;

varying highp vec2 vTextureCoord;

void main() {
  vTextureCoord = aTextureCoord;
  // aVertexPosition.z += 1.0;
  gl_Position = uModelViewProjectionMatrix * aVertexPosition;
  // gl_Position.x += 4.0;
}

