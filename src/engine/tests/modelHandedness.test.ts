// ADR 0164: right-handed model files (glTF, FBX, OBJ) enter the left-handed world mirrored once at
// import: x for `facing: "forward"` (the file's +Z faces forward), z for "back" (the old picture).
import { CreateBoxVertexData } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { describe, expect, it } from "vitest";
import { Assets } from "../index";
import { decodeBakedModel, encodeBakedModel } from "../scene/bakedModel";
import { formatImportSettings, parseImportSettings, type ModelFacing } from "../scene/importSettings";
import { clearModelCache, loadMeshes, loadModel, type ModelMesh } from "../scene/models";

type V3 = [number, number, number];
const S = Math.SQRT1_2;
const dataUrl = (bytes: Uint8Array) => `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;

/** `v` turned by the quaternion `q` ([x, y, z, w]). */
function rotate(q: readonly number[], v: V3): V3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const near = (a: readonly number[], b: readonly number[]) => a.forEach((n, i) => expect(n).toBeCloseTo(b[i], 5));
const mirror = (facing: ModelFacing, v: V3): V3 => (facing === "forward" ? [-v[0], v[1], v[2]] : [v[0], v[1], -v[2]]);

/** An arbitrary turn: 1 rad about (1, 2, 3). */
const TURN = (() => {
  const len = Math.hypot(1, 2, 3), s = Math.sin(0.5);
  return [s / len, (2 * s) / len, (3 * s) / len, Math.cos(0.5)];
})();

/**
 * A triangle whose nose points along +Z (front faces counter-clockwise, normal -Y, as glTF has it)
 * on four nodes, plus a spot light and a camera turned by `TURN`, and a light turned 90° about Y.
 */
function arrowGltf(): Record<string, unknown> {
  const positions = new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 0, 1]);
  const normals = new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0]);
  const indices = new Uint16Array([0, 1, 2, 0]);
  const bin = new Uint8Array(36 + 36 + 8);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(normals.buffer), 36);
  bin.set(new Uint8Array(indices.buffer), 72);
  return {
    asset: { version: "2.0" },
    extensionsUsed: ["KHR_lights_punctual"],
    extensions: { KHR_lights_punctual: { lights: [{ name: "Spot", type: "spot", spot: { outerConeAngle: 0.5 } }] } },
    scene: 0,
    scenes: [{ nodes: [0, 1, 2, 3, 4, 5] }],
    nodes: [
      { name: "Plain", mesh: 0 },
      { name: "Turned", mesh: 0, translation: [2, 0, 0], rotation: [0, S, 0, S] },
      { name: "Mirrored", mesh: 0, scale: [-1, 1, 1] },
      { name: "Lamp", translation: [1, 2, 3], rotation: TURN, extensions: { KHR_lights_punctual: { light: 0 } } },
      { name: "Cam", translation: [1, 2, 3], rotation: TURN, camera: 0 },
      { name: "Side", rotation: [0, S, 0, S], extensions: { KHR_lights_punctual: { light: 0 } } },
    ],
    cameras: [{ type: "perspective", perspective: { yfov: 0.8, znear: 0.1 } }],
    meshes: [{ name: "Arrow", primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-0.5, 0, 0], max: [0.5, 0, 1] },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 6 },
    ],
    buffers: [{ uri: dataUrl(bin), byteLength: bin.length }],
  };
}

function useArrow(sidecar: Record<string, unknown> = {}) {
  clearModelCache();
  Assets.clearSources();
  Assets.addSource(
    Assets.fromObject({
      "models/arrow.gltf": dataUrl(new TextEncoder().encode(JSON.stringify(arrowGltf()))),
      "models/arrow.gltf.meta.json": { format: "myco.import@1", ...sidecar },
    }),
  );
}

const vertex = (mesh: ModelMesh, i: number): V3 => [mesh.data.positions[i * 3], mesh.data.positions[i * 3 + 1], mesh.data.positions[i * 3 + 2]];
const normal = (mesh: ModelMesh, i: number): V3 => [mesh.data.normals![i * 3], mesh.data.normals![i * 3 + 1], mesh.data.normals![i * 3 + 2]];
/** The first triangle's right-hand-rule normal, from its index order. */
function windingNormal(mesh: ModelMesh): V3 {
  const [a, b, c] = mesh.data.indices;
  return cross(sub(vertex(mesh, b), vertex(mesh, a)), sub(vertex(mesh, c), vertex(mesh, a)));
}

describe("model import handedness (ADR 0164)", () => {
  it('faces a glTF model\'s +Z forward with facing "forward" (the default) and back with "back"', async () => {
    useArrow();
    const [plain] = await loadMeshes("asset:models/arrow.gltf#Plain");
    near(vertex(plain, 2), [0, 0, 1]);
    near(vertex(plain, 1), [-0.5, 0, 0]); // x mirrored
    useArrow({ facing: "back" });
    const [back] = await loadMeshes("asset:models/arrow.gltf#Plain");
    near(vertex(back, 2), [0, 0, -1]);
    near(vertex(back, 1), [0.5, 0, 0]);
  });

  for (const facing of ["forward", "back"] as const) {
    it(`mirrors node poses (${facing}): translations mirrored, rotations proper and consistent with the geometry`, async () => {
      useArrow({ facing });
      const data = await loadModel("models/arrow.gltf");
      const turned = data.meshes.find((m) => m.name === "Turned")!;
      near(turned.pose!.position, mirror(facing, [2, 0, 0]));
      near(turned.pose!.rotation, facing === "forward" ? [0, -S, 0, S] : [-0, -S, 0, S]);
      near(turned.pose!.scale, [1, 1, 1]);
      // The file puts the nose at (3, 0, 0); the pose carries the node-space nose there.
      near(vertex(turned, 2), mirror(facing, [3, 0, 0]));
      const [node] = await loadMeshes("asset:models/arrow.gltf#Turned");
      const nose = rotate(turned.pose!.rotation, vertex(node, 2)).map((n, i) => n + turned.pose!.position[i]);
      near(nose, vertex(turned, 2));
    });

    it(`points lights and cameras where the file points them (${facing})`, async () => {
      useArrow({ facing });
      const data = await loadModel("models/arrow.gltf");
      // glTF lights and cameras look along their node's -Z; the engine's along +Z.
      const fileForward = rotate(TURN, [0, 0, -1]);
      const fileUp = rotate(TURN, [0, 1, 0]);
      for (const name of ["Lamp", "Cam"]) {
        const pose = data.nodes!.find((n) => n.name === name)!.pose;
        near(pose.position, mirror(facing, [1, 2, 3]));
        near(rotate(pose.rotation, [0, 0, 1]), mirror(facing, fileForward));
        near(rotate(pose.rotation, [0, 1, 0]), mirror(facing, fileUp));
        near(pose.scale, [1, 1, 1]);
      }
      // A light turned 90° about Y points at the file's -X: +X forward (x mirrored), -X back.
      const side = data.nodes!.find((n) => n.name === "Side")!.pose;
      near(rotate(side.rotation, [0, 0, 1]), facing === "forward" ? [1, 0, 0] : [-1, 0, 0]);
    });
  }

  it("keeps index order through the mirror, so front faces wind as Babylon's own meshes do", async () => {
    // Babylon's left-handed default: a front face's right-hand-rule normal points inward.
    const box = CreateBoxVertexData({ size: 2 });
    const bp = (i: number): V3 => [box.positions![i * 3], box.positions![i * 3 + 1], box.positions![i * 3 + 2]];
    const [a, b, c] = box.indices!;
    expect(dot(cross(sub(bp(b), bp(a)), sub(bp(c), bp(a))), [box.normals![a * 3], box.normals![a * 3 + 1], box.normals![a * 3 + 2]])).toBeLessThan(0);

    for (const facing of ["forward", "back"] as const) {
      for (const normals of ["import", "calculate"] as const) {
        useArrow({ facing, normals });
        const [plain] = await loadMeshes("asset:models/arrow.gltf#Plain");
        expect(Array.from(plain.data.indices)).toEqual([0, 1, 2]);
        near(normal(plain, 0), [0, -1, 0]); // the file's normal, mirrored (unchanged by either mirror)
        expect(dot(windingNormal(plain), normal(plain, 0))).toBeLessThan(0);
        // A node mirrored in the file (scale -1) is rewound to wind the same way.
        const [mirrored] = await loadMeshes("asset:models/arrow.gltf#Mirrored#model");
        expect(Array.from(mirrored.data.indices)).toEqual([0, 2, 1]);
        expect(dot(windingNormal(mirrored), normal(mirrored, 0))).toBeLessThan(0);
      }
    }
  });

  it("keys baked copies by facing and reads only version 3", async () => {
    useArrow();
    const data = await loadModel("models/arrow.gltf");
    const forward = { scale: 1, upAxis: "y" as const, normals: "import" as const, facing: "forward" as const };
    const { bytes } = encodeBakedModel(data, forward);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    expect(new DataView(buffer).getUint32(8, true)).toBe(3);
    expect(decodeBakedModel(buffer, forward, (p) => p)).not.toBeNull();
    expect(decodeBakedModel(buffer, { ...forward, facing: "back" }, (p) => p)).toBeNull();
    const old = buffer.slice(0);
    new DataView(old).setUint32(8, 2, true);
    expect(() => decodeBakedModel(old, forward, (p) => p)).toThrow(/version 2/);
  });

  it("reads and writes the facing import setting", () => {
    expect(parseImportSettings({ format: "myco.import@1" }).settings.facing).toBe("forward");
    const back = parseImportSettings({ format: "myco.import@1", facing: "back" }).settings;
    expect(back.facing).toBe("back");
    expect(formatImportSettings(back)).toBe('{\n  "format": "myco.import@1",\n  "facing": "back"\n}\n');
    expect(parseImportSettings({ format: "myco.import@1", facing: "up" }, "a.glb.meta.json").problems).toEqual(['a.glb.meta.json: "facing" should be "forward" or "back"; using the default.']);
  });
});
