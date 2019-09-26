attribute vec4 aVertexPosition;
attribute vec4 aVertexColor;
attribute vec2 aTextureCoord;
attribute vec3 aNormal;

uniform mat4 uWorldMatrix;
uniform mat4 uModelMatrix;
uniform mat4 uModelViewMatrix;
uniform mat4 uViewProjectionMatrix;
uniform mat4 uModelViewProjectionMatrix;
uniform vec2 uResolution;

varying highp vec4 vColor;
varying highp vec2 vTextureCoord;
varying highp vec3 vNormal;

void main() {
  // Transforms the vertex into view space;
  vec4 transformedVertexPosition = uModelViewProjectionMatrix * aVertexPosition;
  gl_Position = transformedVertexPosition;

  vColor = aVertexColor;
  vTextureCoord = aTextureCoord;

  //Transform normals from local to world space.
  vNormal = mat3(uModelViewMatrix) * aNormal;
}

