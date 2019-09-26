attribute vec4 aVertexPosition;
attribute vec4 aVertexColor;
attribute vec2 aTextureCoord;

uniform mat4 uModelMatrix;
uniform mat4 uModelViewMatrix;
uniform mat4 uViewProjectionMatrix;
uniform mat4 uModelViewProjectionMatrix;
uniform vec2 uResolution;

varying highp vec2 vTextureCoord;

void main() {
  gl_Position = uModelViewProjectionMatrix * aVertexPosition;
  vTextureCoord = aTextureCoord;
}

