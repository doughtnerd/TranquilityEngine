#!/usr/bin/env node
// Generates the navigation sample (ADR 0065): a port of Foxfire Navigation's Streaming Demo
// (StreamingDemoGenerator.cs) onto Myco's built-in navigation. Plain Node, no dependencies.
//
//   node samples/navigation/tools/generate.mjs
//   npm run nav:bake -- samples/navigation
//
// It writes project.json (the navigation settings: the demo's five agent types and three areas,
// with fixed ids), sample.json, the materials, the south-west chunk's terrain model, the agent
// prefabs, the main scene and the nine chunk scenes. Running it again rewrites them all the same
// way (everything is seeded). Bake after changing the chunks' layout or the navigation settings
// (`npm run nav:bake`): each chunk's NavChunk already refers to its `<scene>.nav.bin`.
//
// Coordinates: the Unity generator's layout, with z flipped (Myco is right-handed: north is -z,
// so a camera looking north has east on its right, as in the Unity demo). `U(x, y, z)` converts.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------------------------- settings

/**
 * Agent counts. The Unity demo has 40 walkers, 20 flyers, 20 walk-and-fly agents, 3 walker groups of
 * 16, 2 flyer groups of 12, 2 walk-and-fly groups of 8 and 6 + 6 course agents (about 210). These are
 * scaled to about 140, which runs smoothly in a browser with the single-threaded WebAssembly runtime.
 */
const COUNTS = {
  walkers: 30,
  flyers: 16,
  walkFlyers: 16,
  /** Walker groups, one formation each in turn: box, the painted arrow (16 slots), wedge, line. */
  groups: 2,
  groupSize: 16,
  flyerGroups: 1,
  flyerGroupSize: 9,
  walkFlyGroups: 1,
  walkFlyGroupSize: 8,
  jumpers: 6,
  climbers: 6,
};

/** Seconds the goal stays at each waypoint of its tour. */
const TOUR_INTERVAL = 60;
/** Agents pick random goals within this radius of the tour's waypoint. */
const GOAL_SPREAD = 18;
/** Seconds between the gate opening and closing. */
const GATE_INTERVAL = 20;
/** Seconds between the course goals swapping ends. */
const COURSE_INTERVAL = 15;
/** The streamer: a chunk loads when an agent comes this close to its box, and unloads when every agent is past the second. */
const LOAD_DISTANCE = 24;
const UNLOAD_DISTANCE = 40;

// ---------------------------------------------------------------------------------------------- layout constants

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHUNK_SIZE = 128;
const CHUNK_HEIGHT = 48;
const HALF = CHUNK_SIZE / 2;
const CHUNK_NAMES = ["South-west", "South", "South-east", "West", "Centre", "East", "North-west", "North", "North-east"];
const chunkSlug = (i) => `chunk-${i + 1}-${CHUNK_NAMES[i].toLowerCase()}`;
const chunkScene = (i) => `scenes/${chunkSlug(i)}.scene.json`;
/** The Unity cell (x, y) of chunk i: 1 is south-west (-1, -1), 5 the centre, 9 north-east. */
const cellOf = (i) => ({ x: (i % 3) - 1, y: Math.floor(i / 3) - 1 });
const WEST = { x: -1, y: 0 };
const TERRAIN_CELL = { x: -1, y: -1 };
const COLLIDER_CELL = { x: 1, y: 0 };
const isCell = (c, d) => c.x === d.x && c.y === d.y;
const COURSE_X = -52;
const COURSE_HALF_WIDTH = 4;

/** Unity position → Myco position (z flipped). */
const U = (x, y, z) => [r(x), r(y), r(-z)];
/** Rounded for tidy JSON. */
const r = (v) => Math.round(v * 1000) / 1000 + 0;

// ---------------------------------------------------------------------------------------------- ids

/** Agent type ids (fixed: bakes and agents refer to them). */
const AGENT = {
  walker: "3f6c2a1e-8b4d-4c7a-9e21-5d0b7a4c1e01",
  flyer: "7a1d9e52-4c3b-4f8e-b210-9c6e3d5a2f02",
  walkFly: "b84e1c37-2d5a-4e9b-8c43-1f7a6e9d3b03",
  jumper: "d29f7b64-6e1c-4a3d-9f58-2b8c4d7e1a04",
  climber: "e5c3a816-9f2b-4d7e-a165-3c9d5b2f8e05",
};
/** Area ids (fixed). */
const AREA = { mud: "area-mud", lava: "area-lava", storm: "area-storm" };

// ---------------------------------------------------------------------------------------------- seeded random

/** mulberry32: the same numbers on every run and machine. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------- output

const written = [];
function write(path, content) {
  const full = join(ROOT, ...path.split("/"));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  written.push(path);
}

// ---------------------------------------------------------------------------------------------- navigation settings

const motion = (ease, easeInTime, easeOutTime) => ({ ease, easeInTime, easeOutTime });

/** The demo's walking settings (human-sized: 1 m radius, 3 m tall, no jumping). */
const walking = () => ({
  radius: 1,
  height: 3,
  pivotOffset: 1.5,
  stepHeight: 0.5,
  speed: 6,
  canJump: false,
  maxFallDistance: 2,
  waypointReachedDistance: 1,
  arrivalDistance: 2,
  maxSnapDistance: 4,
  offPathDistance: 8,
  // Sets off over 0.75 s and slows over the last second.
  motion: motion("inOutQuad", 0.75, 1),
});

const flying = () => ({
  radius: 1.5,
  speed: 15,
  arrivalDistance: 4,
  waypointReachedDistance: 3,
  maxSnapDistance: 4,
  offPathDistance: 15,
  takeoffHeight: 6,
  takeoffSpeed: 6,
  separationStrength: 1, // flyers spread out instead of stacking at shared goals
  separationRadiusScale: 1.5,
  motion: motion("inOutSine", 1.5, 1.5),
});

const avoidance = () => ({ neighborDistance: 8 });

const navigation = {
  agentTypes: [
    { id: AGENT.walker, name: "Walker", canWalk: true, walk: walking(), canFly: false, avoidance: avoidance() },
    { id: AGENT.flyer, name: "Flyer", canWalk: false, canFly: true, flight: flying(), avoidance: null },
    {
      // Walks, and flies short hops (at most 40 m): over the chasm, but the long way round elsewhere. When the goal is
      // too far to fly to, it lands at the nearest spot and walks.
      id: AGENT.walkFly,
      name: "Walk and fly",
      canWalk: true,
      walk: walking(),
      canFly: true,
      flight: { ...flying(), speed: 12, maxFlightDistance: 40, landWhenOutOfReach: true, motion: motion("inOutCubic", 1, 1) },
      avoidance: avoidance(),
    },
    {
      // Jumps up 2.5 m, across 5 m and down 5 m (the jump course in the west chunk).
      id: AGENT.jumper,
      name: "Jumper",
      canWalk: true,
      walk: {
        ...walking(),
        radius: 0.75,
        height: 2,
        pivotOffset: 1,
        canJump: true,
        maxJumpUpHeight: 2.5,
        maxJumpDistance: 5,
        maxFallDistance: 5,
        jumpArcHeight: 1.5,
        jumpCost: 2,
        jumpApexSpeed: 3,
        jumpRiseGravity: 10,
        jumpFallGravity: 15,
        motion: motion("constant", 1, 1), // full speed off the start and into the goal, for contrast
      },
      canFly: false,
      avoidance: avoidance(),
    },
    {
      // Walks up walls and along ceilings (the climb course).
      id: AGENT.climber,
      name: "Climber",
      canWalk: true,
      walk: {
        ...walking(),
        radius: 0.75,
        height: 1.5,
        pivotOffset: 0.75,
        canClimbWalls: true,
        canWalkCeilings: true,
        maxFoldAngleDeg: 90,
        wallCostMultiplier: 1,
        ceilingCostMultiplier: 1,
        motion: motion("outQuart", 1, 1.5), // sets off at once, creeps up on its goal
      },
      canFly: false,
      avoidance: avoidance(),
    },
  ],
  areas: [
    { id: AREA.mud, name: "Mud", cost: 3, color: [0.45, 0.3, 0.15, 1] },
    { id: AREA.lava, name: "Lava", cost: 100, color: [1, 0.3, 0.05, 1] },
    { id: AREA.storm, name: "Storm", cost: 20, color: [0.4, 0.4, 0.5, 1] },
  ],
  // Coverage 45: with 0.5 m voxels and 0.5 m steps a voxel field holds slopes up to 45 degrees (the bake warns past it).
  orientation: { maxSurfaceDeg: 180, groundCaptureDeg: 45, ceilingCaptureDeg: 45, coverageDeg: 45, maxFoldDeg: 90 },
  chunkGrid: 4,
  // The Unity demo's agent types are all on Default and avoid Everything (Generated/Agents/*.asset), its only layer.
  avoidanceLayers: ["Default"],
};

// ---------------------------------------------------------------------------------------------- materials

const MATERIALS = {
  ground: "#8c998c",
  walls: "#736b66",
  walker: "#3380f2",
  flyer: "#f28c26",
  walkFly: "#994ce6",
  goal: "#ffd91a",
  jumper: "#f24d80",
  climber: "#33d999",
  swamp: "#4d401f",
  barrier: "#d9332b",
  lava: "#ff590d",
  storm: "#59597359",
  mud: "#664726",
  grass: "#668c4d",
};
const material = (name) => `asset:materials/${name}.material.json`;

/** Group colours: hues round the wheel by the golden ratio (the Unity generator's GroupColour). */
function groupColour(n) {
  const h = (0.45 + 0.618034 * n) % 1, s = 0.7, v = 0.9;
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [R, G, B] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  const hex = (c) => Math.round(c * 255).toString(16).padStart(2, "0");
  return `#${hex(R)}${hex(G)}${hex(B)}`;
}

function writeMaterials(groupCount) {
  for (const [name, color] of Object.entries(MATERIALS)) {
    write(`materials/${name}.material.json`, { format: "myco.material@1", color, roughness: name === "lava" ? 0.5 : 0.85, ...(name === "lava" ? { emission: "#802000" } : {}) });
  }
  for (let g = 0; g < groupCount; g++) write(`materials/group-${g + 1}.material.json`, { format: "myco.material@1", color: groupColour(g), roughness: 0.7 });
}

// ---------------------------------------------------------------------------------------------- scene building

/** A scene being built: nodes with unique ids. */
class Scene {
  constructor() {
    this.nodes = [];
    this.ids = new Set();
  }

  id(base) {
    const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "node";
    let id = slug;
    for (let n = 2; this.ids.has(id); n++) id = `${slug}-${n}`;
    this.ids.add(id);
    return id;
  }

  /** A node; returns its id. */
  add(name, components, parent, transform) {
    const node = { id: this.id(name), name };
    if (parent) node.parent = parent;
    if (transform === false) node.transform = false;
    node.components = components;
    this.nodes.push(node);
    return node.id;
  }

  file(settings) {
    return { format: "myco.scene@2", ...(settings ? { settings } : {}), nodes: this.nodes };
  }
}

const transform = (position, rotation, scale) => ({
  type: "engine.Transform",
  data: { position, ...(rotation ? { rotation } : {}), ...(scale ? { scale } : {}) },
});
const renderer = (mesh, mat, extra = {}) => ({ type: "engine.MeshRenderer", data: { mesh, material: material(mat), ...extra } });
const cube = (mat, extra) => renderer("builtin:cube", mat, extra);

/** A box of navmesh geometry (Unity's Block with NavMeshAuthoring): walkable on top for every agent type, solid for all. */
function block(scene, parent, name, position, size, mat, rotZ = 0) {
  return scene.add(name, [transform(position, rotZ ? [0, 0, r(rotZ)] : undefined, size), cube(mat), { type: "engine.NavSurface", data: {} }], parent);
}

/** A box that blocks the navmesh and is walkable for no agent type (NavMeshObstacleAuthoring). */
function obstacleBlock(scene, parent, name, position, size, mat) {
  return scene.add(name, [transform(position, undefined, size), cube(mat), { type: "engine.NavObstacle", data: {} }], parent);
}

/** A box with a collider and no navigation component (the east chunk collects colliders). */
function colliderBlock(scene, parent, name, position, size, mat, rotZ = 0) {
  return scene.add(name, [transform(position, rotZ ? [0, 0, r(rotZ)] : undefined, size), cube(mat), { type: "engine.BoxCollider", data: {} }], parent);
}

/** A box that's only seen (swamp water, a storm cloud, a barrier): nothing collects it. */
function visual(scene, parent, name, position, size, mat, extra) {
  return scene.add(name, [transform(position, undefined, size), cube(mat, { castShadows: false, ...extra })], parent);
}

// ---------------------------------------------------------------------------------------------- chunks

/**
 * One chunk scene: a NavChunk (its bounds the chunk's 128 m square, 4 m below the ground to 44 m above) and the
 * chunk's geometry, as BuildChunk lays it out:
 * - North row: a chasm across all three chunks, bridged only in the north-east.
 * - South face of the middle row: a wall standing across the face (in the south chunks, reaching into the middle
 *   row: the overlays), a door only in the middle.
 * - East face of the centre: a raised platform across the face, a ramp up from each side.
 * - Pillars in every chunk; the south-west chunk is a terrain (hills, a pond, trees, a mud patch); the east chunk's
 *   pillars and ramp are plain colliders its NavChunk collects; the centre has a swamp, a storm and a gated fence;
 *   the west has the jump and climb courses.
 */
function buildChunk(i) {
  const cell = cellOf(i);
  const scene = new Scene();
  const cx = cell.x * CHUNK_SIZE, cz = cell.y * CHUNK_SIZE; // the chunk's centre (Unity)
  const isCollider = isCell(cell, COLLIDER_CELL);
  const isCentre = cell.x === 0 && cell.y === 0;
  const isWest = isCell(cell, WEST);

  scene.add("Navigation", [
    {
      type: "engine.NavChunk",
      data: {
        useChunkBounds: true,
        center: U(cx, CHUNK_HEIGHT / 2 - 4, cz),
        size: [CHUNK_SIZE, CHUNK_HEIGHT, CHUNK_SIZE],
        // Blocks are marked (NavSurface / NavObstacle); the east chunk also collects plain colliders.
        collect: isCollider ? "colliders" : "none",
        scope: "scene",
        skipAgents: isWest ? [] : [AGENT.jumper, AGENT.climber], // their courses are only in the west
        // Written by `npm run nav:bake` beside the scene (`<scene>.nav.bin`).
        bake: `asset:scenes/${chunkSlug(i)}.nav.bin`,
      },
    },
  ], undefined, false);
  const geometry = scene.add("Geometry", [transform([0, 0, 0])]);

  // Ground, with the chasm (local z -8 to 8) across the north row.
  if (cell.y === 1) {
    block(scene, geometry, "Ground south of the chasm", U(cx, -0.5, cz - 36), [CHUNK_SIZE, 1, 56], "ground");
    block(scene, geometry, "Ground north of the chasm", U(cx, -0.5, cz + 36), [CHUNK_SIZE, 1, 56], "ground");
    if (cell.x === 1) block(scene, geometry, "Bridge", U(cx + 40, -0.25, cz), [4, 0.5, 20], "walls");
  } else if (isCell(cell, TERRAIN_CELL)) {
    terrain(scene, geometry, cx, cz);
  } else {
    block(scene, geometry, "Ground", U(cx, -0.5, cz), [CHUNK_SIZE, 1, CHUNK_SIZE], "ground");
  }

  // The wall on the face between the south row and the middle row, a door in the middle.
  if (cell.y === -1) {
    const z = cz + HALF;
    if (cell.x === 0) {
      block(scene, geometry, "Wall west of the door", U(-34, 3, z), [60, 6, 1], "walls");
      block(scene, geometry, "Wall east of the door", U(34, 3, z), [60, 6, 1], "walls");
    } else {
      block(scene, geometry, "Wall", U(cx, 3, z), [CHUNK_SIZE, 6, 1], "walls");
    }
  }

  // The platform across the centre's east face (x = 64), a ramp up from each side.
  const rampAngle = (Math.atan2(2, 12) * 180) / Math.PI;
  if (isCentre) {
    block(scene, geometry, "Platform", U(64, 1, 0), [24, 2, 24], "walls");
    block(scene, geometry, "Ramp west", U(46, 0.75, 0), [12.3, 0.5, 12], "walls", rampAngle);
  }
  if (isCollider) colliderBlock(scene, geometry, "Ramp east (collider)", U(82, 0.75, 0), [12.3, 0.5, 12], "walls", -rampAngle);

  if (isCentre) centreFeatures(scene, geometry);
  if (isWest) {
    jumpCourse(scene, geometry, cx, cz);
    climbCourse(scene, geometry, cx, cz);
  }

  // Pillars, the same every time, kept off the features, the agents' start and the goal's.
  const rand = random(1000 + (cell.y + 1) * 3 + cell.x + 1);
  const pillars = isCell(cell, TERRAIN_CELL) ? 0 : 5; // the terrain has trees instead
  for (let placed = 0, tries = 0; placed < pillars && tries < 100; tries++) {
    const lx = rand() * 88 - 44, lz = rand() * 88 - 44;
    if (cell.y === 1 && Math.abs(lz) < 14) continue; // the chasm and bridge
    if (cell.y === -1 && lz > 36) continue; // the wall
    if (isCentre && (lz < 16 || lx > 30 || Math.hypot(lx, lz - 40) < 10)) continue;
    if (isCollider && lx < -20 && Math.abs(lz) < 20) continue; // the east ramp
    if (isWest && lx < -30) continue; // the courses
    if (isCentre && lz > 0 && lz < 20) continue; // the fence
    if (isCollider) colliderBlock(scene, geometry, `Pillar ${placed + 1} (collider)`, U(cx + lx, 3, cz + lz), [3, 6, 3], "walls");
    else block(scene, geometry, `Pillar ${placed + 1}`, U(cx + lx, 3, cz + lz), [3, 6, 3], "walls");
    placed++;
  }

  return scene.file();
}

/**
 * The centre chunk's swamp, storm and gate:
 * - Swamp: a ground modifier volume (Mud, three times the cost) north-west of the start; its slab is only paint.
 * - Storm: an air modifier volume (Storm, twenty times) on the flyers' way north-west.
 * - Fence and gate: a fence across the way north with an 8 m opening, a NavGate over it. The main scene's GateTimer
 *   opens and closes it (H, or every 20 s) and lifts the barrier when it's open.
 */
function centreFeatures(scene, geometry) {
  scene.add("Swamp (ground modifier volume, Mud)", [transform(U(-30, 0.5, 34)), { type: "engine.NavModifierVolume", data: { size: [30, 2, 22], area: AREA.mud, appliesTo: "ground" } }], geometry);
  visual(scene, geometry, "Swamp water", U(-30, 0.02, 34), [30, 0.04, 22], "swamp", { receiveShadows: true });

  scene.add("Storm (air modifier volume, Storm)", [transform(U(-40, 20, 30)), { type: "engine.NavModifierVolume", data: { size: [36, 16, 36], area: AREA.storm, appliesTo: "air" } }], geometry);
  visual(scene, geometry, "Storm cloud", U(-40, 20, 30), [36, 16, 36], "storm");

  // The fence along z = 10, an opening at x -4..4.
  block(scene, geometry, "Fence west", U(-24, 1.5, 10), [40, 3, 1], "walls");
  block(scene, geometry, "Fence east", U(24, 1.5, 10), [40, 3, 1], "walls");
  const gate = scene.add("Gate (NavGate)", [transform(U(0, 1, 10)), { type: "engine.NavGate", data: { gateId: "centre-gate", size: [8, 3, 3], open: true } }], geometry);
  // The barrier, under the gate (local): GateTimer lifts it 4 m while the gate is open.
  visual(scene, gate, "Barrier", [0, 0.5, 0], [8, 3, 0.6], "barrier");
}

/** A course wall standing at foot (its bottom centre): walkable up to a metre from the top, then a cap no agent walks on. */
function courseWall(scene, parent, name, foot, size) {
  const cap = 1;
  block(scene, parent, name, [foot[0], r(foot[1] + (size[1] - cap) / 2), foot[2]], [size[0], size[1] - cap, size[2]], "walls");
  obstacleBlock(scene, parent, `${name} cap (obstacle)`, [foot[0], r(foot[1] + size[1] - cap / 2), foot[2]], [size[0], cap, size[2]], "walls");
}

/** A walled corridor along z from z0 to z1 (Unity local), COURSE_HALF_WIDTH either side of COURSE_X. */
function corridor(scene, parent, cx, cz, z0, z1, height) {
  const length = z1 - z0, mid = (z0 + z1) / 2;
  courseWall(scene, parent, "Side wall west", U(cx + COURSE_X - COURSE_HALF_WIDTH - 0.5, 0, cz + mid), [1, height, length + 2]);
  courseWall(scene, parent, "Side wall east", U(cx + COURSE_X + COURSE_HALF_WIDTH + 0.5, 0, cz + mid), [1, height, length + 2]);
  courseWall(scene, parent, "End wall", U(cx + COURSE_X, 0, cz + z0 - 0.5), [2 * COURSE_HALF_WIDTH, height, 1]);
  courseWall(scene, parent, "End wall", U(cx + COURSE_X, 0, cz + z1 + 0.5), [2 * COURSE_HALF_WIDTH, height, 1]);
}

/**
 * The jump course (local x -56..-48, z 8..52): up 2 m onto a block, down into a pit and up its far side, up 2 m
 * more across a 2 m gap, then down 4 m. The 4 m drop is one way, so a 2 m step beside the end is the way back up.
 */
function jumpCourse(scene, geometry, cx, cz) {
  const root = scene.add("Jump course", [transform([0, 0, 0])], geometry);
  corridor(scene, root, cx, cz, 8, 52, 6);
  const at = (z, top) => U(cx + COURSE_X, top / 2, cz + z);
  const size = (length, top) => [2 * COURSE_HALF_WIDTH, top, length];
  block(scene, root, "Block 1 (jump up 2 m)", at(21, 2), size(6, 2), "walls");
  block(scene, root, "Block 2 (across the pit)", at(30.5, 2), size(5, 2), "walls");
  block(scene, root, "Block 3 (jump up again, drop 4 m after)", at(37.5, 4), size(5, 4), "walls");
  block(scene, root, "Step (the way back up)", U(cx + COURSE_X + COURSE_HALF_WIDTH / 2, 1, cz + 44), [COURSE_HALF_WIDTH, 2, 4], "walls");
}

/**
 * The climb course (local x -56..-48, z -52..-8): a 5 m wall across it, which the Climber walks up and over, then a
 * stretch under a roof whose floor and lower walls are Lava (a ground modifier volume for the Climber only, 100 times
 * the cost): the cheap way past is along the walls and the roof's underside.
 */
function climbCourse(scene, geometry, cx, cz) {
  const root = scene.add("Climb course", [transform([0, 0, 0])], geometry);
  corridor(scene, root, cx, cz, -52, -8, 8);
  block(scene, root, "Wall to climb (5 m)", U(cx + COURSE_X, 2.5, cz - 36.5), [2 * COURSE_HALF_WIDTH, 5, 3], "walls");
  block(scene, root, "Roof (walk under it)", U(cx + COURSE_X, 6, cz - 24), [2 * COURSE_HALF_WIDTH, 4, 8], "walls");
  scene.add("Lava (ground modifier volume, Lava)", [
    transform(U(cx + COURSE_X, 1.5, cz - 24)),
    { type: "engine.NavModifierVolume", data: { center: [0, -0.75, 0], size: [2 * COURSE_HALF_WIDTH + 1, 1.5, 8], area: AREA.lava, appliesTo: "ground", agents: [AGENT.climber] } },
  ], root);
  visual(scene, root, "Lava glow", U(cx + COURSE_X, 0.02, cz - 24), [2 * COURSE_HALF_WIDTH, 0.04, 8], "lava");
}

// ---------------------------------------------------------------------------------------------- terrain

const TERRAIN_STEP = 2; // metres between heightmap samples (the Unity bake sampled every second texel)
const POND = { x: 88, z: 40, radius: 6 }; // Unity local to the terrain's corner
const MUD = { x: 44, z: 76, radius: 14 };

/** Gentle hills (up to 3.2 m) that flatten out within 24 m of the chunk's edges, so its seams meet the neighbours' flat ground. */
function terrainHeight(lx, lz) {
  const u = lx / CHUNK_SIZE, v = lz / CHUNK_SIZE;
  const edge = Math.min(Math.min(u, 1 - u), Math.min(v, 1 - v)) * CHUNK_SIZE;
  const t = Math.min(1, Math.max(0, (edge - 4) / 20));
  const falloff = t * t * (3 - 2 * t);
  const hills = 0.5 + 0.25 * Math.sin(u * 9) + 0.25 * Math.cos(v * 7 + 1);
  return falloff * hills * 0.4 * 8;
}

/**
 * The south-west chunk's terrain (Myco has no terrain component yet, ADR 0065): the heightmap as an OBJ model with
 * two meshes, Grass and Mud (the mud patch, a NavSurface with the Mud area: walkers avoid it), the pond left out (a
 * hole: no navmesh), and a dozen trees (NavObstacle cylinders).
 */
function terrain(scene, geometry, cx, cz) {
  const n = CHUNK_SIZE / TERRAIN_STEP + 1;
  const lines = ["# The navigation sample's south-west terrain (written by tools/generate.mjs)"];
  const verts = [];
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const lx = x * TERRAIN_STEP, lz = z * TERRAIN_STEP;
      verts.push([lx, terrainHeight(lx, lz), lz]);
    }
  }
  // Normals from the heights' slopes (Unity local; z flipped on output).
  const normal = (lx, lz) => {
    const e = 0.5;
    const dx = (terrainHeight(lx + e, lz) - terrainHeight(lx - e, lz)) / (2 * e);
    const dz = (terrainHeight(lx, lz + e) - terrainHeight(lx, lz - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz);
    return [-dx / l, 1 / l, dz / l];
  };
  for (const [lx, h, lz] of verts) lines.push(`v ${r(lx)} ${r(h)} ${r(-lz)}`);
  for (const [lx, , lz] of verts) lines.push(`vn ${normal(lx, lz).map((c) => r(c)).join(" ")}`);
  const grass = [], mud = [];
  for (let z = 0; z < n - 1; z++) {
    for (let x = 0; x < n - 1; x++) {
      const mx = (x + 0.5) * TERRAIN_STEP, mz = (z + 0.5) * TERRAIN_STEP;
      if (Math.hypot(mx - POND.x, mz - POND.z) < POND.radius) continue; // the pond
      const a = z * n + x + 1, b = a + 1, c = a + n, d = c + 1; // OBJ indices are 1-based
      // With z flipped, (a, b, d) and (a, d, c) run counter-clockwise seen from above (normals up).
      const faces = [`f ${a}//${a} ${b}//${b} ${d}//${d}`, `f ${a}//${a} ${d}//${d} ${c}//${c}`];
      (Math.hypot(mx - MUD.x, mz - MUD.z) < MUD.radius ? mud : grass).push(...faces);
    }
  }
  lines.push("o Grass", ...grass, "o Mud", ...mud, "");
  write("models/terrain.obj", lines.join("\n"));

  const corner = U(cx - HALF, 0, cz - HALF);
  const root = scene.add("Terrain", [transform(corner)], geometry);
  scene.add("Grass", [transform([0, 0, 0]), renderer("asset:models/terrain.obj#Grass", "grass"), { type: "engine.NavSurface", data: {} }], root);
  scene.add("Mud (Mud area)", [transform([0, 0, 0]), renderer("asset:models/terrain.obj#Mud", "mud"), { type: "engine.NavSurface", data: { area: AREA.mud } }], root);
  scene.add("Pond", [transform([POND.x, r(terrainHeight(POND.x, POND.z) - 0.4), -POND.z], undefined, [POND.radius * 2, 0.2, POND.radius * 2]), renderer("builtin:cylinder", "swamp", { castShadows: false })], root);

  const rand = random(77);
  const trees = scene.add("Trees", [transform([0, 0, 0])], root);
  for (let placed = 0; placed < 12; ) {
    const lx = (0.12 + rand() * 0.76) * CHUNK_SIZE;
    const lz = (0.12 + rand() * 0.6) * CHUNK_SIZE; // off the wall along the north face
    if (Math.hypot(lx - POND.x, lz - POND.z) < 12 || Math.hypot(lx - MUD.x, lz - MUD.z) < 18) continue;
    placed++;
    // A 1.5 m wide, 6 m tall trunk, sunk a little into the slope; an obstacle (never walkable).
    scene.add(`Tree ${placed}`, [
      transform([r(lx), r(terrainHeight(lx, lz) + 2.5), r(-lz)], [0, r(rand() * 360), 0], [1.5, 3, 1.5]),
      renderer("builtin:cylinder", "walls"),
      { type: "engine.NavObstacle", data: {} },
    ], trees);
  }
}

// ---------------------------------------------------------------------------------------------- prefabs

/** An agent prefab: a NavAgent on a capsule (or sphere) sized like the agent. */
function agentPrefab(id, name, agentType, mesh, scale, mat) {
  return {
    format: "myco.scene@2",
    nodes: [{ id, name, components: [transform([0, 0, 0], undefined, scale), renderer(mesh, mat), { type: "engine.NavAgent", data: { agentType } }] }],
  };
}

const PREFABS = {
  walker: "prefabs/walker.prefab.json",
  flyer: "prefabs/flyer.prefab.json",
  walkFly: "prefabs/walk-and-fly.prefab.json",
  jumper: "prefabs/jumper.prefab.json",
  climber: "prefabs/climber.prefab.json",
};

function writePrefabs() {
  // Capsules are 2 m tall and 1 m wide at scale 1: scaled to the agent type's radius and height (pivot at the middle).
  write(PREFABS.walker, agentPrefab("walker", "Walker", AGENT.walker, "builtin:capsule", [2, 1.5, 2], "walker"));
  write(PREFABS.flyer, agentPrefab("flyer", "Flyer", AGENT.flyer, "builtin:sphere", [3, 3, 3], "flyer"));
  write(PREFABS.walkFly, agentPrefab("walk-and-fly", "Walk and fly", AGENT.walkFly, "builtin:capsule", [2, 1.5, 2], "walkFly"));
  write(PREFABS.jumper, agentPrefab("jumper", "Jumper", AGENT.jumper, "builtin:capsule", [1.5, 1, 1.5], "jumper"));
  write(PREFABS.climber, agentPrefab("climber", "Climber", AGENT.climber, "builtin:capsule", [1.5, 0.75, 1.5], "climber"));
}

// ---------------------------------------------------------------------------------------------- main scene

/** The goal's tour of the features (Unity coordinates), starting through the door so the crowds cross a seam at once. */
const TOUR = [
  ["South-east, through the door", 128, 0, -128],
  ["On the platform", 64, 2, 0],
  ["North-west, over the chasm", -128, 0, 168],
  ["West", -128, 0, 0],
  ["Centre", 0, 0, 40],
];

/** The arrow formation (16 cells, front up): Arrow() in the Unity generator. */
const ARROW = ["...#...", "..###..", ".#####.", "..###..", "..###..", "...#..."];

function buildMain() {
  const scene = new Scene();
  scene.add("Camera", [
    transform(U(0, 40, -50), [-35, 0, 0]),
    { type: "engine.Camera", data: { projection: "perspective", fieldOfView: 55, near: 0.5, far: 2000 } },
    { type: "navdemo.CameraRig", data: { focus: U(0, 0, -10), distance: 70, yaw: 0, pitch: -40 } },
  ]);
  scene.add("Sun", [transform([0, 50, 0], [-50, -30, 0]), { type: "engine.Light", data: { type: "directional", intensity: 1.5, castShadows: true, shadowArea: 120 } }]);
  scene.add("Ambient Light", [transform([0, 0, 0]), { type: "engine.Light", data: { type: "ambient", intensity: 0.5 } }]);

  // Chunks: the streamer loads them (additively) around the agents.
  scene.add("Streamer", [{
    type: "navdemo.Streamer",
    data: {
      chunks: CHUNK_NAMES.map((_, i) => chunkScene(i)),
      names: CHUNK_NAMES,
      chunkSize: CHUNK_SIZE,
      chunkHeight: CHUNK_HEIGHT,
      loadDistance: LOAD_DISTANCE,
      unloadDistance: UNLOAD_DISTANCE,
    },
  }], undefined, false);
  scene.add("Gate Timer", [{ type: "navdemo.GateTimer", data: { interval: GATE_INTERVAL, lift: 4 } }], undefined, false);

  // The goal: the tour's marker; crowds and groups head for random spots round it.
  scene.add("Goal", [
    transform(U(...TOUR[0].slice(1)), undefined, [2, 2, 2]),
    renderer("builtin:sphere", "goal", { castShadows: false }),
    { type: "navdemo.Tour", data: { waypoints: TOUR.map((w) => U(w[1], w[2], w[3])), names: TOUR.map((w) => w[0]), interval: TOUR_INTERVAL } },
  ]);

  // Crowds, spaced as a real crowd stands (2.5 radii apart): walkers west of the centre line, walk-and-fly agents east.
  const groundSpacing = 2.5, airSpacing = 4;
  const half = (count) => 0.5 * Math.ceil(Math.sqrt(count)) * groundSpacing;
  const crowd = (name, kind, prefab, count, centre, spacing, height, seed) => {
    if (count === 0) return;
    scene.add(name, [transform([0, 0, 0]), { type: "navdemo.Crowd", data: { kind, prefab, count, center: centre, spacing, spread: GOAL_SPREAD, height, seed } }]);
  };
  crowd("Walkers", "walker", PREFABS.walker, COUNTS.walkers, U(-half(COUNTS.walkers) - 4, 1.5, -24), groundSpacing, 0, 11);
  crowd("Walk-and-fly agents", "walkFly", PREFABS.walkFly, COUNTS.walkFlyers, U(half(COUNTS.walkFlyers) + 4, 1.5, -24), groundSpacing, 0, 22);
  crowd("Flyers", "flyer", PREFABS.flyer, COUNTS.flyers, U(0, 12, -24), airSpacing, 10, 33);

  // Groups: one formation each; members start in a square round the group and take their slots on the way.
  let groupCount = 0;
  const group = (name, kind, prefab, agentType, count, position, settings, extra) => {
    groupCount++;
    scene.add(name, [
      transform(position),
      // merge off: groups heading for the same waypoint would otherwise merge into one, and each formation should show.
      { type: "engine.NavGroup", data: { agentType, merge: false, ...settings } },
      { type: "navdemo.GroupLeader", data: { kind, prefab, count, spacing: groundSpacing, material: material(`group-${groupCount}`), ...extra } },
    ]);
  };
  const formations = [["Box", "box"], ["Arrow", "mask"], ["Wedge", "wedge"], ["Line", "line"]];
  const columns = (n) => Math.ceil(Math.sqrt(n));
  if (COUNTS.groupSize > 0) {
    const gap = columns(COUNTS.groupSize) * groundSpacing + 8;
    for (let g = 0; g < COUNTS.groups; g++) {
      const [label, formation] = formations[g % formations.length];
      group(`${label} group ${g + 1}`, "walkerGroup", PREFABS.walker, AGENT.walker, formation === "mask" ? 16 : COUNTS.groupSize, U((g - (COUNTS.groups - 1) / 2) * gap, 1.5, -50), { formation }, {
        ...(formation === "mask" ? { mask: ARROW } : {}),
        height: 0,
      });
    }
  }
  if (COUNTS.flyerGroupSize > 0) {
    const gap = columns(COUNTS.flyerGroupSize) * 5 + 12;
    const flyerFormations = [["Box", "box"], ["Circle", "circle"]];
    for (let g = 0; g < COUNTS.flyerGroups; g++) {
      const [label, formation] = flyerFormations[g % flyerFormations.length];
      group(`Flyer ${label.toLowerCase()} group ${g + 1}`, "flyerGroup", PREFABS.flyer, AGENT.flyer, COUNTS.flyerGroupSize, U((g - (COUNTS.flyerGroups - 1) / 2) * gap, 12, -50), { formation, spacing: 5 }, { spacing: 5, height: 12 });
    }
  }
  if (COUNTS.walkFlyGroupSize > 0) {
    const gap = columns(COUNTS.walkFlyGroupSize) * 5 + 12;
    const wfFormations = [["Box", "box"], ["Wedge", "wedge"]];
    for (let g = 0; g < COUNTS.walkFlyGroups; g++) {
      const [label, formation] = wfFormations[g % wfFormations.length];
      group(`Walk-and-fly ${label.toLowerCase()} group ${g + 1}`, "walkFlyGroup", PREFABS.walkFly, AGENT.walkFly, COUNTS.walkFlyGroupSize, U(54 + (g - (COUNTS.walkFlyGroups - 1) / 2) * gap, 1.5, -50), { formation, spacing: 5 }, { spacing: 5, height: 0 });
    }
  }

  // The jump and climb courses' agents, in the west chunk, shuttling between the ends every 15 s.
  const course = (name, kind, prefab, count, startZ, endZ, pivot) => {
    if (count === 0) return;
    const wx = WEST.x * CHUNK_SIZE, wz = WEST.y * CHUNK_SIZE;
    const goal = scene.add(`${name} goal`, [transform(U(wx + COURSE_X, 0.5, wz + endZ)), renderer("builtin:sphere", "goal", { castShadows: false })]);
    scene.add(name, [
      transform([0, 0, 0]),
      { type: "navdemo.Course", data: { kind, prefab, count, from: U(wx + COURSE_X, pivot, wz + startZ), to: U(wx + COURSE_X, pivot, wz + endZ), interval: COURSE_INTERVAL, goal: { $node: goal } } },
    ]);
  };
  course("Jump course", "jumper", PREFABS.jumper, COUNTS.jumpers, 12, 48, 1);
  course("Climb course", "climber", PREFABS.climber, COUNTS.climbers, -12, -48, 0.75);

  scene.add("HUD", [{ type: "engine.Text", data: { text: "", fontSize: 18, anchor: "top-left", align: "left", offset: [16, 16], outlineColor: "#000000", outlineWidth: 3 } }, { type: "navdemo.Hud" }], undefined, false);
  return { file: scene.file(), groupCount };
}

// ---------------------------------------------------------------------------------------------- write it all

write("project.json", {
  name: "Navigation",
  display: { width: 1280, height: 720, backgroundColor: "#9ec5e8" },
  time: { fixedDeltaTime: 1 / 60 },
  physics: { gravity: [0, -9.81], layers: ["Default"] },
  render: { sortingLayers: ["Default"], pixelsPerUnit: 100 },
  autoload: [],
  navigation,
});
write("sample.json", {
  name: "Navigation",
  description:
    "Foxfire's Streaming Demo on the built-in navigation: a 3×3 world of chunk scenes streamed around about 140 walkers, flyers, walk-and-fly agents, groups in formation, jumpers and climbers, with a chasm, a gated fence, mud, lava and a storm. Press Play.",
});

const main = buildMain();
writeMaterials(main.groupCount);
writePrefabs();
write("scenes/main.scene.json", main.file);
for (let i = 0; i < 9; i++) write(chunkScene(i), buildChunk(i));

const total = COUNTS.walkers + COUNTS.flyers + COUNTS.walkFlyers + COUNTS.groups * COUNTS.groupSize + COUNTS.flyerGroups * COUNTS.flyerGroupSize + COUNTS.walkFlyGroups * COUNTS.walkFlyGroupSize + COUNTS.jumpers + COUNTS.climbers;
console.log(`Wrote ${written.length} files in ${ROOT} (${total} agents). Bake the chunks next: npm run nav:bake -- samples/navigation`);
