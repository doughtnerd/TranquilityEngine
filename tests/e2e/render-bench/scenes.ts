// The render benchmark's scenes (ADR 0446 and 0447's targets): a forest and a city, generated at test time as project files
// for `openEditor(page, { files })`, never committed. Promoted from `spikes/render-bench/generate.mjs`: the same seeds, the
// same procedural meshes (`geom.ts`, `meshes.ts`), the same placement, so the numbers stay comparable with the spike's.
//
// Each tree, rock, building and prop is one OBJ model with a material slot per part, drawn by one `MeshRenderer`; one
// directional light with cascaded shadows and an ambient light; the camera stands at a fixed pose (no path: a repeatable view).
import type { ProjectFiles } from "../fixtures";
import { rng, toObj, type Part } from "./geom";
import { cityMeshes, forestMeshes, MATERIALS } from "./meshes";

/** How a material asset batches its instances: `auto` (an instanced mesh per renderer) or `thin` (one thin-instance buffer per batch). */
export type Instancing = "auto" | "thin";

/**
 * One benchmark variant of a scene.
 *
 * TODO(lod): a later task adds `lod: boolean` here: an `LODGroup` on each tree and rock (and building and prop), and model
 * sidecars (`models/<name>.obj.meta.json`) with `lod` levels, with the simplified OBJs (`<name>_lod1..3.obj`, ratios 0.5 / 0.25 / 0.1,
 * made by meshoptimizer as `spikes/render-bench/generate.mjs` does) written next to the full ones. The spike left them out.
 * TODO(occlusion): and `occlusion: boolean`: the occluder setup the occlusion task defines (buildings and the ground as occluders).
 */
export interface Variant {
  readonly instancing: Instancing;
}

export type SceneName = "forest" | "city";

/** One scene variant to measure: its name in the report, and the files that make it. */
export interface BenchScene {
  readonly id: string;
  readonly scene: SceneName;
  readonly variant: Variant;
  /** What the scene holds, for the report. */
  readonly objects: Readonly<Record<string, number>>;
  /** The project files, generated now (a few MB of text: call once per scene opened). */
  files(): ProjectFiles;
}

type Vec3 = [number, number, number];
interface Comp { type: string; data: Record<string, unknown> }
interface Node { id: string; name: string; components: Comp[] }

/** Round to a millimetre. */
const r3 = (v: number) => +v.toFixed(3);

/** A rotation about +y by `yaw`, pitched about x by `pitch` (qy * qx), as a quaternion. */
function quat(yaw: number, pitch = 0): number[] {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  return [cy * sp, sy * cp, -sy * sp, cy * cp].map((v) => +v.toFixed(6));
}

const transform = (pos: Vec3, yaw: number, scale: Vec3): Comp => ({ type: "engine.Transform", data: { position: pos.map(r3), rotation: quat(yaw), scale: scale.map(r3) } });

/**
 * The MeshRenderer of a model with a material per slot.
 * TODO(lod): an `engine.LODGroup` component goes beside it for the `lod` variants (see `Variant`).
 */
const renderer = (model: string, slots: readonly string[]): Comp => ({
  type: "engine.MeshRenderer",
  data: { mesh: `asset:models/${model}.obj`, materials: slots.map((s) => `asset:materials/${s}.material.json`) },
});

interface Pose { pos: Vec3; yaw: number; pitch: number }

/** Camera, sun, ambient light and the ground plane. */
function baseNodes(cam: Pose, groundScale: number, groundMaterial: string): Node[] {
  return [
    { id: "camera", name: "Camera", components: [
      { type: "engine.Transform", data: { position: cam.pos, rotation: quat(cam.yaw, cam.pitch) } },
      { type: "engine.Camera", data: { projection: "perspective", fieldOfView: 60 } },
    ] },
    { id: "sun", name: "Sun", components: [
      { type: "engine.Transform", data: { position: [0, 50, 0], rotation: [0.4403775, -0.2667293, -0.1388505, 0.8459573] } },
      { type: "engine.Light", data: { type: "directional", intensity: 1.6, castShadows: true } },
    ] },
    { id: "ambient", name: "Ambient Light", components: [
      { type: "engine.Transform", data: {} },
      { type: "engine.Light", data: { type: "ambient", intensity: 0.45 } },
    ] },
    { id: "ground", name: "Ground", components: [
      { type: "engine.Transform", data: { scale: [groundScale, 1, groundScale] } },
      { type: "engine.MeshRenderer", data: { mesh: "builtin:plane", material: `asset:materials/${groundMaterial}.material.json`, castShadows: false } },
    ] },
  ];
}

interface Built {
  name: string;
  meshes: Record<string, Part[]>;
  nodes: Node[];
  camera: Pose;
  groundScale: number;
  groundMaterial: string;
}

const FOREST_OBJECTS = { trees: 4000, rocks: 6000 };
const CITY_OBJECTS = { buildings: 576, props: 5000 };

function forest(): Built {
  const meshes = forestMeshes();
  const r = rng(1234);
  const nodes: Node[] = [];
  /** `count` objects on a shuffled jittered grid over the 400 m x 400 m ground. */
  const place = (count: number, cell: number, kinds: string[], slots: string[], prefix: string, scaleRange: [number, number]) => {
    const per = Math.ceil(400 / cell);
    const cells: number[] = [];
    for (let i = 0; i < per * per; i++) cells.push(i);
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [cells[i], cells[j]] = [cells[j]!, cells[i]!];
    }
    for (let n = 0; n < count; n++) {
      const c = cells[n]!, gx = c % per, gz = Math.floor(c / per);
      const x = -200 + (gx + 0.15 + 0.7 * r()) * cell, z = -200 + (gz + 0.15 + 0.7 * r()) * cell;
      const s = scaleRange[0] + (scaleRange[1] - scaleRange[0]) * r();
      const kind = kinds[Math.floor(r() * kinds.length)]!;
      nodes.push({ id: `${prefix}${n}`, name: `${prefix}${n}`, components: [transform([x, 0, z], r() * Math.PI * 2, [s, s * (0.9 + 0.2 * r()), s]), renderer(kind, slots)] });
    }
  };
  place(FOREST_OBJECTS.trees, 400 / Math.sqrt(FOREST_OBJECTS.trees), ["tree0", "tree1", "tree2", "tree3"], ["trunk", "leaf"], "tree", [0.8, 1.3]);
  place(FOREST_OBJECTS.rocks, 400 / Math.sqrt(FOREST_OBJECTS.rocks), ["rock0", "rock1", "rock2"], ["rock"], "rock", [0.6, 1.6]);
  return { name: "Forest bench", meshes, nodes, camera: { pos: [0, 1.7, -195], yaw: 0, pitch: 0 }, groundScale: 40, groundMaterial: "ground" };
}

function city(): Built {
  const meshes = cityMeshes();
  const r = rng(4321);
  const nodes: Node[] = [];
  const buildings = ["bld0", "bld1", "bld2", "bld3", "bld4", "bld5"];
  const P = 80;
  let nb = 0;
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) {
    const cx = (i - 5.5) * P, cz = (j - 5.5) * P;
    for (const [ox, oz] of [[-15, -15], [15, -15], [-15, 15], [15, 15]] as const) {
      const kind = buildings[Math.floor(r() * buildings.length)]!;
      const sy = 0.8 + 0.7 * r();
      nodes.push({ id: `bld${nb}`, name: `Building${nb}`, components: [transform([cx + ox, 0, cz + oz], Math.floor(r() * 4) * (Math.PI / 2), [1, sy, 1]), renderer(kind, ["wall", "window"])] });
      nb++;
    }
  }
  const propKinds: [string, number][] = [["car0", 0.15], ["car1", 0.15], ["bench0", 0.2], ["lamp0", 0.3], ["bin0", 0.2]];
  const slotsOf: Record<string, string[]> = { car0: ["body", "dark"], car1: ["body", "dark"], bench0: ["wood", "dark"], lamp0: ["dark", "glow"], bin0: ["dark", "body"] };
  for (let n = 0; n < CITY_OBJECTS.props; n++) {
    let u = r(), kind = propKinds[0]![0];
    for (const [k, w] of propKinds) {
      if (u < w) { kind = k; break; }
      u -= w;
    }
    const street = (Math.floor(r() * 13) - 6) * P, along = (r() - 0.5) * 960, onX = r() < 0.5;
    const isCar = kind.startsWith("car");
    const lat = isCar ? (r() < 0.5 ? -1 : 1) * (2.5 + 3 * r()) : (r() < 0.5 ? -1 : 1) * 8.8;
    const x = onX ? along : street + lat, z = onX ? street + lat : along;
    const yaw = (onX ? 0 : Math.PI / 2) + (lat > 0 ? 0 : Math.PI) + (isCar ? 0 : r() * 0.2);
    const s = 0.9 + 0.2 * r();
    nodes.push({ id: `prop${n}`, name: `Prop${n}`, components: [transform([x, 0, z], yaw, [s, s, s]), renderer(kind, slotsOf[kind]!)] });
  }
  return { name: "City bench", meshes, nodes, camera: { pos: [0, 1.7, -470], yaw: 0, pitch: 0 }, groundScale: 100, groundMaterial: "asphalt" };
}

/** The Kd of a material's colour (`#rrggbb`) as an MTL line's numbers. */
const kd = (color: string) => (color.match(/\w\w/g) ?? []).slice(0, 3).map((h) => (parseInt(h, 16) / 255).toFixed(3)).join(" ");

/** The project's files for one built scene: project.json, the materials, a model (OBJ + MTL) per mesh, and the scene. */
function projectFiles(b: Built, variant: Variant): ProjectFiles {
  const files: ProjectFiles = {};
  files["project.json"] = JSON.stringify({
    name: b.name,
    display: { width: 1280, height: 720, backgroundColor: "#9ec5e8" },
    time: { fixedDeltaTime: 1 / 60 },
    render: { sortingLayers: ["Default"], pixelsPerUnit: 100 },
    autoload: [],
  });
  for (const [name, spec] of Object.entries(MATERIALS)) {
    const m: Record<string, unknown> = { format: "myco.material@1", ...spec };
    if (variant.instancing !== "auto" && name !== "ground" && name !== "asphalt") m.instancing = variant.instancing;
    files[`materials/${name}.material.json`] = JSON.stringify(m);
  }
  for (const [name, parts] of Object.entries(b.meshes)) {
    const materials = [...new Set(parts.map((p) => p.material))];
    files[`models/${name}.mtl`] = materials.map((m) => `newmtl ${m}\nKd ${kd(MATERIALS[m]!.color)}\n`).join("\n");
    files[`models/${name}.obj`] = toObj(name, parts, `${name}.mtl`);
    // TODO(lod): `models/${name}.obj.meta.json` sidecar with `lod` levels, and the `${name}_lod1..3.obj` files, for the lod variants.
  }
  files["scenes/main.scene.json"] = JSON.stringify({ format: "myco.scene@5", nodes: [...baseNodes(b.camera, b.groundScale, b.groundMaterial), ...b.nodes] });
  return files;
}

const SCENES: Record<SceneName, { build: () => Built; objects: Record<string, number> }> = {
  forest: { build: forest, objects: FOREST_OBJECTS },
  city: { build: city, objects: CITY_OBJECTS },
};

/** The scene variants the benchmark measures, in report order. */
export const BENCH_SCENES: readonly BenchScene[] = (["forest", "city"] as const).flatMap((scene) =>
  // TODO(lod, occlusion): add the `lod` and `occlusion` variants here when their tasks land.
  (["auto", "thin"] as const).map((instancing): BenchScene => {
    const variant: Variant = { instancing };
    const { build, objects } = SCENES[scene];
    return { id: `${scene}-${instancing}`, scene, variant, objects, files: () => projectFiles(build(), variant) };
  }),
);
