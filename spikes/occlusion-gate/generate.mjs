// Generates the gate's projects into ./generated/<scene>-auto-lod/ (deterministic; no network): the render-bench spike's
// forest and city (same seeds, meshes, placement, camera poses), `auto` instancing, with the ENGINE's LOD (ADR 0446):
// every model has a sidecar `models/<name>.obj.meta.json` with `lod` (the import panel's defaults, `permissive` for
// buildings: as tests/e2e/render-bench/scenes.ts) and every tree, rock, building and prop an automatic `engine.LODGroup`
// beside its MeshRenderer. No simplified OBJs are written: the levels are generated when the models load (bench.ts).
//   node generate.mjs            -> forest-auto-lod, city-auto-lod
// Also bench.json (camera poses for the harness) and files.json (a file list for the page).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rng, toObj, triCount } from "./gen/geom.mjs";
import { cityMeshes, forestMeshes, MATERIALS } from "./gen/meshes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "generated");
const LOD_DEFAULTS = {
  levels: [{ ratio: 0.5, error: 0.01 }, { ratio: 0.25, error: 0.02 }, { ratio: 0.125, error: 0.04 }],
  attributes: true,
  permissive: false,
  lockBorders: false,
  pixelError: 1,
};
const q = (yaw, pitch = 0) => {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  // qy * qx
  return [cy * sp, sy * cp, -sy * sp, cy * cp].map((v) => +v.toFixed(6));
};
const r3 = (v) => +v.toFixed(3);

function writeProject(dir, name, meshes, objects, scene, instancing, bench, stats) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "models"), { recursive: true });
  mkdirSync(join(dir, "materials"), { recursive: true });
  mkdirSync(join(dir, "scenes"), { recursive: true });
  const files = [];
  const put = (path, text) => { writeFileSync(join(dir, path), text); files.push(path); };
  put("project.json", JSON.stringify({ name, display: { width: 1280, height: 720, backgroundColor: "#9ec5e8" }, time: { fixedDeltaTime: 1 / 60 }, render: { sortingLayers: ["Default"], pixelsPerUnit: 100 }, autoload: [] }, null, 2));
  for (const [mname, spec] of Object.entries(MATERIALS)) {
    const m = { format: "myco.material@1", ...spec };
    if (instancing === "unlit") m.shader = "unlit"; // validation flavour: flat colours, no lights or shadows (see validate.mjs)
    else if (instancing !== "auto" && mname !== "ground" && mname !== "asphalt") m.instancing = instancing;
    put(`materials/${mname}.material.json`, JSON.stringify(m, null, 2));
  }
  for (const [mname, parts] of Object.entries(meshes)) {
    {
      const file = mname;
      const mats = [...new Set(parts.map((p) => p.material))];
      put(`models/${file}.mtl`, mats.map((m) => `newmtl ${m}\nKd ${(MATERIALS[m].color.match(/\w\w/g) ?? []).slice(0, 3).map((h) => (parseInt(h, 16) / 255).toFixed(3)).join(" ")}\n`).join("\n"));
      put(`models/${file}.obj`, toObj(file, parts, `${file}.mtl`));
      put(`models/${file}.obj.meta.json`, JSON.stringify({ format: "myco.import@1", lod: { ...LOD_DEFAULTS, permissive: file.startsWith("bld") } }));
      stats.meshes[file] = { tris: triCount(parts), parts: parts.map((p) => ({ material: p.material, tris: p.indices.length / 3 })) };
    }
  }
  put("scenes/main.scene.json", JSON.stringify(scene));
  put("bench.json", JSON.stringify(bench));
  writeFileSync(join(dir, "files.json"), JSON.stringify([...files, "files.json"].filter((f) => f !== "bench.json" && f !== "files.json")));
}

const transform = (pos, yaw, scale) => ({ type: "engine.Transform", data: { position: pos.map(r3), rotation: q(yaw), scale: [r3(scale[0]), r3(scale[1]), r3(scale[2])] } });
const renderer = (mesh, slots) => [
  { type: "engine.MeshRenderer", data: { mesh: `asset:models/${mesh}.obj`, materials: slots.map((s) => `asset:materials/${s}.material.json`) } },
  { type: "engine.LODGroup", data: {} },
];

function baseNodes(camPose, groundScale, groundMat) {
  return [
    { id: "camera", name: "Camera", components: [
      { type: "engine.Transform", data: { position: camPose.pos, rotation: q(camPose.yaw, camPose.pitch) } },
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
      { type: "engine.MeshRenderer", data: { mesh: "builtin:plane", material: `asset:materials/${groundMat}.material.json`, castShadows: false } },
    ] },
  ];
}

/** Camera path keyframes -> [{pos, yaw, pitch}] */
const lerpPath = (keys, n) => {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const u = (i / n) * (keys.length - 1), k = Math.min(keys.length - 2, Math.floor(u)), t = u - k;
    const a = keys[k], b = keys[k + 1];
    out.push({ pos: a.pos.map((v, j) => r3(v + (b.pos[j] - v) * t)), yaw: +(a.yaw + (b.yaw - a.yaw) * t).toFixed(5), pitch: +(a.pitch + (b.pitch - a.pitch) * t).toFixed(5) });
  }
  return out;
};

function forest(instancing) {
  const meshes = forestMeshes();
  const r = rng(1234);
  const nodes = [];
  const place = (count, cell, kinds, slots, prefix, scaleRange) => {
    const per = Math.ceil(400 / cell);
    const cells = [];
    for (let i = 0; i < per * per; i++) cells.push(i);
    for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
    for (let n = 0; n < count; n++) {
      const c = cells[n], gx = c % per, gz = Math.floor(c / per);
      const x = -200 + (gx + 0.15 + 0.7 * r()) * cell, z = -200 + (gz + 0.15 + 0.7 * r()) * cell;
      const s = scaleRange[0] + (scaleRange[1] - scaleRange[0]) * r();
      const kind = kinds[Math.floor(r() * kinds.length)];
      nodes.push({ id: `${prefix}${n}`, name: `${prefix}${n}`, components: [transform([x, 0, z], r() * Math.PI * 2, [s, s * (0.9 + 0.2 * r()), s]), ...renderer(kind, slots[kind])] });
    }
  };
  place(4000, 400 / Math.sqrt(4000), ["tree0", "tree1", "tree2", "tree3"], Object.fromEntries(["tree0", "tree1", "tree2", "tree3"].map((k) => [k, ["trunk", "leaf"]])), "tree", [0.8, 1.3]);
  place(6000, 400 / Math.sqrt(6000), ["rock0", "rock1", "rock2"], Object.fromEntries(["rock0", "rock1", "rock2"].map((k) => [k, ["rock"]])), "rock", [0.6, 1.6]);
  const stat = { pos: [0, 1.7, -195], yaw: 0, pitch: 0 };
  const keys = [
    { pos: [-120, 1.7, -195], yaw: 0.35, pitch: 0 },
    { pos: [-40, 1.7, -150], yaw: 0.1, pitch: 0.02 },
    { pos: [20, 1.7, -90], yaw: -0.2, pitch: 0 },
    { pos: [60, 1.7, -30], yaw: -0.5, pitch: 0.03 },
    { pos: [20, 1.7, 40], yaw: 0.2, pitch: 0 },
    { pos: [-40, 1.7, 100], yaw: 0.6, pitch: 0.02 },
  ];
  const scene = { format: "myco.scene@5", nodes: [...baseNodes(stat, 40, "ground"), ...nodes] };
  const bench = { scene: "forest", staticPose: stat, flyPath: lerpPath(keys, 100), objects: { trees: 4000, rocks: 6000 } };
  return { name: `Forest bench (${instancing})`, meshes, scene, bench };
}

function city(instancing) {
  const meshes = cityMeshes();
  const r = rng(4321);
  const nodes = [];
  const bnames = ["bld0", "bld1", "bld2", "bld3", "bld4", "bld5"];
  const P = 80;
  let nb = 0;
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) {
    const cx = (i - 5.5) * P, cz = (j - 5.5) * P;
    for (const [ox, oz] of [[-15, -15], [15, -15], [-15, 15], [15, 15]]) {
      const kind = bnames[Math.floor(r() * bnames.length)];
      const sy = 0.8 + 0.7 * r();
      nodes.push({ id: `bld${nb}`, name: `Building${nb}`, components: [transform([cx + ox, 0, cz + oz], Math.floor(r() * 4) * (Math.PI / 2), [1, sy, 1]), ...renderer(kind, ["wall", "window"])] });
      nb++;
    }
  }
  const propKinds = [["car0", 0.15], ["car1", 0.15], ["bench0", 0.2], ["lamp0", 0.3], ["bin0", 0.2]];
  const slotsOf = { car0: ["body", "dark"], car1: ["body", "dark"], bench0: ["wood", "dark"], lamp0: ["dark", "glow"], bin0: ["dark", "body"] };
  for (let n = 0; n < 5000; n++) {
    let u = r(), kind = propKinds[0][0];
    for (const [k, w] of propKinds) { if (u < w) { kind = k; break; } u -= w; }
    const street = (Math.floor(r() * 13) - 6) * P, along = (r() - 0.5) * 960, onX = r() < 0.5;
    const isCar = kind.startsWith("car");
    const lat = isCar ? (r() < 0.5 ? -1 : 1) * (2.5 + 3 * r()) : (r() < 0.5 ? -1 : 1) * 8.8;
    const x = onX ? along : street + lat, z = onX ? street + lat : along;
    const yaw = (onX ? 0 : Math.PI / 2) + (lat > 0 ? 0 : Math.PI) + (isCar ? 0 : r() * 0.2);
    const s = 0.9 + 0.2 * r();
    nodes.push({ id: `prop${n}`, name: `Prop${n}`, components: [transform([x, 0, z], yaw, [s, s, s]), ...renderer(kind, slotsOf[kind])] });
  }
  const stat = { pos: [0, 1.7, -470], yaw: 0, pitch: 0 };
  const keys = [
    { pos: [0, 1.7, -470], yaw: 0, pitch: 0 },
    { pos: [3, 1.7, -380], yaw: 0.12, pitch: 0.02 },
    { pos: [-3, 1.7, -290], yaw: -0.15, pitch: 0 },
    { pos: [2, 1.7, -200], yaw: 0.1, pitch: 0.03 },
    { pos: [0, 1.7, -130], yaw: 0.7, pitch: 0 },
    { pos: [20, 1.7, -80], yaw: 1.2, pitch: 0 },
    { pos: [75, 1.7, -80], yaw: 1.4, pitch: 0.02 },
  ];
  const scene = { format: "myco.scene@5", nodes: [...baseNodes(stat, 100, "asphalt"), ...nodes] };
  const bench = { scene: "city", staticPose: stat, flyPath: lerpPath(keys, 100), objects: { buildings: nb, props: 5000 } };
  return { name: `City bench (${instancing})`, meshes, scene, bench };
}

mkdirSync(OUT, { recursive: true });
const summary = {};
for (const [sceneName, make] of [["forest", forest], ["city", city]]) {
  for (const instancing of ["auto"]) {
    const { name, meshes, scene, bench } = make(instancing);
    const stats = { meshes: {} };
    writeProject(join(OUT, `${sceneName}-${instancing}-lod`), name, meshes, null, scene, instancing, bench, stats);
    if (instancing === "auto") summary[sceneName] = stats.meshes;
    console.log(`${sceneName}-${instancing}-lod: ${scene.nodes.length} nodes`);
  }
}
writeFileSync(join(OUT, "mesh-stats.json"), JSON.stringify(summary, null, 1));
