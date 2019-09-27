attribute vec4 aVertexPosition;
attribute vec2 aTextureCoord;

uniform mat4 uModelViewProjectionMatrix;

varying highp vec2 vTextureCoord;

void main() {
  vTextureCoord = aTextureCoord;
  gl_Position = uModelViewProjectionMatrix * aVertexPosition;
}

