// The benchmark meshes: tree variants, rocks, city buildings and props. Triangle budgets follow the brief
// (trees 6-10k, rocks 3-5k, buildings 2-5k, props 1-4k). Each mesh is a list of parts, one material per part.
import { cylinder, gridBox, merge, noise3, normals, orientOutward, rng, sphereForTris, triCount, weld, xform } from "./geom.mjs";

const outward = (g) => {
  // centroid of the vertices
  let x = 0, y = 0, z = 0;
  const n = g.positions.length / 3;
  for (let i = 0; i < g.positions.length; i += 3) { x += g.positions[i]; y += g.positions[i + 1]; z += g.positions[i + 2]; }
  return orientOutward(g, x / n, y / n, z / n);
};

/** Tree: trunk (material "trunk") + canopy of displaced lumps (material "leaf"). */
function tree(seed, height, canopyR, lumps, targetTris) {
  const r = rng(seed);
  const trunkRings = 8, trunkSides = 12;
  const trunk = outward(cylinder(trunkSides, trunkRings, 0.32 * (height / 8), 0.12 * (height / 8), 0, height * 0.75, 0, 0, (a, t) => 0.9 + 0.2 * noise3(Math.cos(a) * 2, t * 4, Math.sin(a) * 2, seed)));
  const leafTris = targetTris - triCount([trunk]);
  const per = leafTris / lumps;
  const lumpGeoms = [];
  for (let i = 0; i < lumps; i++) {
    const t = i / (lumps - 1 || 1);
    const rr = canopyR * (1 - 0.45 * t) * (0.8 + 0.3 * r());
    const cy = height * (0.5 + 0.45 * t);
    const ox = (r() - 0.5) * canopyR * 0.5, oz = (r() - 0.5) * canopyR * 0.5;
    const disp = (x, y, z) => 0.8 + 0.4 * noise3(x * 2.2 + i * 7, y * 2.2, z * 2.2, seed + i);
    lumpGeoms.push(outward(sphereForTris(per, rr, rr * 0.8, rr, ox, cy, oz, disp)));
  }
  return [{ ...trunk, material: "trunk" }, { ...merge(lumpGeoms), material: "leaf" }];
}

/** Rock: one displaced sphere (material "rock"), about 1 m across. */
function rock(seed, tris) {
  const disp = (x, y, z) => 0.7 + 0.6 * noise3(x * 1.7 + 3, y * 1.7, z * 1.7, seed) + 0.1 * noise3(x * 6, y * 6, z * 6, seed + 1);
  const g = outward(sphereForTris(tris, 0.6, 0.45, 0.55, 0, 0.3, 0, disp));
  return [{ ...g, material: "rock" }];
}

/** Building: a box with protruding window boxes on all four sides (material "wall" and "window"). */
function building(w, d, h, floors, cols) {
  const wall = gridBox(w, h, d, 1, 0, h / 2, 0);
  const wins = [];
  const ww = (w * 0.7) / cols, wh = 1.7, dep = 0.25;
  for (let f = 0; f < floors; f++) {
    const y = 2.5 + ((h - 5) / floors) * (f + 0.5);
    for (let c = 0; c < cols; c++) {
      const u = (c + 0.5) / cols - 0.5;
      for (const [nx, nz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const span = nx ? d : w;
        const px = nx * (w / 2 + dep / 2 - 0.02) + (nx ? 0 : u * span * 0.8);
        const pz = nz * (d / 2 + dep / 2 - 0.02) + (nx ? u * span * 0.8 : 0);
        const g = nx ? gridBox(dep, wh, ww * 0.8, 1, px, y, pz) : gridBox(ww * 0.8, wh, dep, 1, px, y, pz);
        wins.push(g);
      }
    }
  }
  return [{ ...wall, material: "wall" }, { ...merge(wins), material: "window" }];
}

const swapYZ = (g) => {
  const positions = g.positions.slice();
  for (let i = 0; i < positions.length; i += 3) { const y = positions[i + 1]; positions[i + 1] = positions[i + 2]; positions[i + 2] = -y; }
  return { positions, indices: g.indices.slice() };
};

function car(n1, n2) {
  const body = gridBox(4.2, 0.8, 1.8, n1, 0, 0.75, 0);
  const cabin = gridBox(2.3, 0.7, 1.6, n2, -0.2, 1.5, 0);
  const wheels = [];
  for (const x of [-1.4, 1.4]) for (const z of [-0.95, 0.95]) {
    const c = swapYZ(outward(cylinder(16, 2, 0.38, 0.38, -0.12, 0.12, 0, 0)));
    wheels.push(xform(c, 1, 1, 1, x, 0.38, z));
  }
  return [{ ...merge([body, cabin]), material: "body" }, { ...merge(wheels), material: "dark" }];
}

function bench(slatN) {
  const slats = [];
  for (let i = 0; i < 5; i++) slats.push(gridBox(1.8, 0.05, 0.12, slatN, 0, 0.45, -0.3 + i * 0.15));
  for (let i = 0; i < 4; i++) slats.push(gridBox(1.8, 0.12, 0.05, slatN, 0, 0.7 + i * 0.13, -0.33));
  const legs = [gridBox(0.06, 0.45, 0.6, 6, -0.8, 0.225, 0), gridBox(0.06, 0.45, 0.6, 6, 0.8, 0.225, 0)];
  return [{ ...merge(slats), material: "wood" }, { ...merge(legs), material: "dark" }];
}

function lamp(sides, rings) {
  const pole = outward(cylinder(sides, rings, 0.12, 0.07, 0, 6, 0, 0));
  const head = outward(sphereForTris(500, 0.35, 0.25, 0.35, 0, 6.2, 0));
  return [{ ...pole, material: "dark" }, { ...head, material: "glow" }];
}

function bin(sides, rings) {
  const body = outward(cylinder(sides, rings, 0.35, 0.3, 0, 0.9, 0, 0));
  const lid = outward(sphereForTris(300, 0.38, 0.12, 0.38, 0, 0.95, 0));
  return [{ ...body, material: "dark" }, { ...lid, material: "body" }];
}

export function forestMeshes() {
  return {
    tree0: tree(11, 7.0, 2.4, 4, 6400),
    tree1: tree(12, 8.5, 2.8, 5, 7900),
    tree2: tree(13, 9.5, 3.1, 5, 9500),
    tree3: tree(14, 10.5, 3.4, 6, 10500),
    rock0: rock(21, 3200),
    rock1: rock(22, 4200),
    rock2: rock(23, 5200),
  };
}

export function cityMeshes() {
  return {
    bld0: building(24, 24, 30, 9, 5),
    bld1: building(26, 24, 40, 10, 6),
    bld2: building(24, 26, 50, 12, 6),
    bld3: building(28, 26, 55, 14, 7),
    bld4: building(26, 28, 45, 9, 8),
    bld5: building(24, 24, 38, 11, 5),
    car0: car(12, 8),
    car1: car(14, 9),
    bench0: bench(4),
    lamp0: lamp(20, 30),
    bin0: bin(24, 20),
  };
}

export const MATERIALS = {
  trunk: { color: "#6b4a2b", roughness: 0.95 },
  leaf: { color: "#3f7d34", roughness: 0.85 },
  rock: { color: "#8a8a86", roughness: 0.9 },
  ground: { color: "#5b7a3c", roughness: 1 },
  wall: { color: "#a9a49c", roughness: 0.9 },
  window: { color: "#5f86a6", roughness: 0.2, metalness: 0.3 },
  asphalt: { color: "#3a3a3d", roughness: 1 },
  body: { color: "#b8322a", roughness: 0.4, metalness: 0.4 },
  dark: { color: "#2a2a2e", roughness: 0.7 },
  wood: { color: "#8b6b42", roughness: 0.8 },
  glow: { color: "#ffe9a6", roughness: 0.5 },
};
