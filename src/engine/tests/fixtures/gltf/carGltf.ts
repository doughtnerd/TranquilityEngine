// The ADR 0118 test model: a car with a pivoted wheel, lights, a camera, layered materials and variants.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
export const dataUrl = (bytes: Uint8Array, type = "application/octet-stream") => `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
const S = Math.SQRT1_2;

/**
 * A car: a Body (variants Red and Blue on its one slot; a layered Paint material) and a Wheel turned
 * 90° about Y, both under "Car", with a point light, a spot light and a perspective camera.
 */
export function carGltf(): Record<string, unknown> {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2, 0]);
  const bin = new Uint8Array(36 + 8);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(indices.buffer), 36);
  const tex = (index: number) => ({ index });
  return {
    asset: { version: "2.0" },
    extensionsUsed: ["KHR_lights_punctual", "KHR_materials_variants", "KHR_materials_clearcoat", "KHR_materials_sheen", "KHR_materials_anisotropy", "KHR_materials_iridescence", "KHR_materials_transmission", "KHR_materials_specular"],
    extensions: {
      KHR_lights_punctual: {
        lights: [
          { name: "Lamp", type: "point", color: [1, 0.5, 0], intensity: 20, range: 8 },
          { name: "Spot", type: "spot", intensity: 5, spot: { innerConeAngle: Math.PI / 8, outerConeAngle: Math.PI / 4 } },
        ],
      },
      KHR_materials_variants: { variants: [{ name: "Red" }, { name: "Blue" }] },
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "Car", children: [1, 2, 3, 4, 5] },
      { name: "Body", mesh: 0, translation: [0, 1, 0] },
      { name: "Wheel", mesh: 1, translation: [1, 0.5, 0], rotation: [0, S, 0, S] },
      { name: "Lamp", translation: [0, 3, 0], extensions: { KHR_lights_punctual: { light: 0 } } },
      { name: "Spot", translation: [2, 3, 0], extensions: { KHR_lights_punctual: { light: 1 } } },
      { name: "Cam", translation: [0, 2, 10], camera: 0 },
    ],
    cameras: [{ type: "perspective", perspective: { yfov: 0.8, znear: 0.05 } }],
    meshes: [
      {
        name: "BodyMesh",
        primitives: [
          {
            attributes: { POSITION: 0 },
            indices: 1,
            material: 0,
            extensions: { KHR_materials_variants: { mappings: [{ material: 1, variants: [0] }, { material: 2, variants: [1] }] } },
          },
        ],
      },
      { name: "WheelMesh", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 3 }] },
    ],
    materials: [
      {
        name: "Paint",
        extensions: {
          KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatTexture: tex(0), clearcoatRoughnessTexture: tex(0), clearcoatNormalTexture: { index: 0, scale: 0.5 } },
          KHR_materials_sheen: { sheenColorFactor: [1, 1, 1], sheenColorTexture: tex(0), sheenRoughnessTexture: tex(0) },
          KHR_materials_anisotropy: { anisotropyStrength: 0.6, anisotropyRotation: 0.5, anisotropyTexture: tex(0) },
          KHR_materials_iridescence: { iridescenceFactor: 1, iridescenceTexture: tex(0), iridescenceThicknessMinimum: 200, iridescenceThicknessMaximum: 800, iridescenceThicknessTexture: tex(0) },
          KHR_materials_transmission: { transmissionFactor: 0.5, transmissionTexture: tex(0) },
          KHR_materials_specular: { specularTexture: tex(0), specularColorTexture: tex(0) },
        },
      },
      { name: "Red", pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } },
      { name: "Blue", pbrMetallicRoughness: { baseColorFactor: [0, 0, 1, 1] } },
      { name: "Rubber", pbrMetallicRoughness: { baseColorFactor: [0.1, 0.1, 0.1, 1] } },
    ],
    textures: [{ source: 0 }],
    images: [{ uri: `data:image/png;base64,${PNG}` }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    buffers: [{ uri: dataUrl(bin), byteLength: bin.length }],
  };
}

