import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRMaterialsEmissiveStrength, KHRMaterialsClearcoat, KHRTextureTransform, KHRMaterialsUnlit, KHRDracoMeshCompression, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { draco, meshopt, reorder, quantize } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import { MeshoptEncoder, MeshoptDecoder } from "meshoptimizer";
import { mkdirSync, writeFileSync } from "node:fs";

const out = process.argv[2];
mkdirSync(out, { recursive: true });
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.encoder": await draco3d.createEncoderModule(),
  "draco3d.decoder": await draco3d.createDecoderModule(),
  "meshopt.encoder": MeshoptEncoder,
  "meshopt.decoder": MeshoptDecoder,
});

// A box of 24 vertices (flat normals, UVs), centred, size sx,sy,sz around (cx,cy,cz).
function box(doc, buffer, sx, sy, sz, cx = 0, cy = 0, cz = 0) {
  const faces = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  const pos = [], nor = [], uv = [], idx = [];
  for (const [n, u, v] of faces) {
    const base = pos.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [0, 1, 2].map((k) => (n[k] + u[k] * a + v[k] * b) * 0.5);
      pos.push(cx + p[0] * sx, cy + p[1] * sy, cz + p[2] * sz);
      nor.push(...n);
      uv.push((a + 1) / 2, 1 - (b + 1) / 2);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return doc.createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(pos)).setBuffer(buffer))
    .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(new Float32Array(nor)).setBuffer(buffer))
    .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array(uv)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint16Array(idx)).setBuffer(buffer));
}

// 1. Sample: a street lamp (CC0, made here).
{
  const doc = new Document();
  doc.getRoot().getAsset().generator = "Myco Engine sample (CC0)";
  const buffer = doc.createBuffer();
  const metal = doc.createMaterial("Metal").setBaseColorFactor([0.18, 0.2, 0.22, 1]).setMetallicFactor(1).setRoughnessFactor(0.35);
  const stone = doc.createMaterial("Stone").setBaseColorFactor([0.55, 0.53, 0.5, 1]).setMetallicFactor(0).setRoughnessFactor(0.9);
  const glow = doc.createMaterial("Bulb").setBaseColorFactor([1, 0.9, 0.7, 1]).setEmissiveFactor([1, 0.8, 0.5]);
  glow.setExtension("KHR_materials_emissive_strength", doc.createExtension(KHRMaterialsEmissiveStrength).createEmissiveStrength().setEmissiveStrength(4));
  const glass = doc.createMaterial("Glass").setBaseColorFactor([0.9, 0.95, 1, 0.3]).setAlphaMode("BLEND").setRoughnessFactor(0.05);
  const base = doc.createMesh("Base").addPrimitive(box(doc, buffer, 0.6, 0.2, 0.6, 0, 0.1, 0).setMaterial(stone)).addPrimitive(box(doc, buffer, 0.3, 0.1, 0.3, 0, 0.25, 0).setMaterial(metal));
  const pole = doc.createMesh("Pole").addPrimitive(box(doc, buffer, 0.1, 2.6, 0.1).setMaterial(metal));
  const bulb = doc.createMesh("Bulb").addPrimitive(box(doc, buffer, 0.15, 0.2, 0.15).setMaterial(glow));
  const shade = doc.createMesh("Shade").addPrimitive(box(doc, buffer, 0.35, 0.3, 0.35).setMaterial(glass));
  const head = doc.createNode("Head").setTranslation([0, 1.45, 0])
    .addChild(doc.createNode("Bulb").setMesh(bulb))
    .addChild(doc.createNode("Shade").setMesh(shade));
  const lamp = doc.createNode("Lamp")
    .addChild(doc.createNode("Base").setMesh(base))
    .addChild(doc.createNode("Pole").setTranslation([0, 1.5, 0]).setMesh(pole).addChild(head));
  doc.createScene("Scene").addChild(lamp);
  writeFileSync(`${out}/lamp.glb`, await io.writeBinary(doc));
}

// 2. Test fixtures: a box compressed with Draco, and one with meshopt (quantized).
for (const kind of ["draco", "meshopt"]) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const mat = doc.createMaterial("Red").setBaseColorFactor([1, 0, 0, 1]);
  doc.createScene().addChild(doc.createNode("Box").setTranslation([0, 1, 0]).setMesh(doc.createMesh("Box").addPrimitive(box(doc, buffer, 1, 2, 1).setMaterial(mat))));
  if (kind === "draco") await doc.transform(draco({ method: "edgebreaker" }));
  else await doc.transform(reorder({ encoder: MeshoptEncoder }), quantize(), meshopt({ encoder: MeshoptEncoder, level: "medium" }));
  writeFileSync(`${out}/box-${kind}.glb`, await io.writeBinary(doc));
}
console.log("ok");
