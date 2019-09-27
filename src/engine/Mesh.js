
class Mesh {

  name = 'default-mesh';

  vertices = {
    dataType: 'vec3',
    data: [
      -0.5, 0.5, 0,
      0.5, 0.5, 0,
      -0.5, -0.5, 0,
      0.5, -0.5, 0,
    ],
  };

  vertexNormals = {
    dataType: 'vec3',
    data: [
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
    ]
  };

  textureCoordinates = {
    dataType: 'vec2',
    data: [
      1.0, 0.0,
      0.0, 0.0,
      1.0, 1.0,
      0.0, 1.0,
    ]
  };

  constructor() {

  }

}

module.exports = Mesh;
