
class MeshLoader {

  meshes = {
    'default-mesh': {
      vertexBuffer: [],
      vertexNormalsBuffer: [],
      textureCoordinantBuffer: [],
    }
  };

  load(glContext, meshData) {
  }

  createBuffer(renderingContext, data) {
    const buffer = renderingContext.createBuffer();
    renderingContext.bindBuffer(renderingContext.ARRAY_BUFFER, buffer);
    renderingContext.bufferData(renderingContext.ARRAY_BUFFER, new Float32Array(data), renderingContext.STATIC_DRAW);

    return buffer;
  }
}
