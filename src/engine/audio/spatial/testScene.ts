/**
 * Spatial test scenes (ADR 0347): parse and write `*.audioscene.json` (`myco.audioscene@1`), and the one list of the
 * paths a scene names (its sounds and its base game scene) with the rewrite for moves.
 *
 * Lenient (ADR 0306): a bad value falls back to its default with one problem line, ids are made unique, a scene always has
 * at least one listener and a valid active listener, a route always has two points and a box always has some height.
 * Nothing throws. The limits are declared once, here (`AUDIO_SCENE_LIMITS`).
 *
 * Pure; no plugin, no DOM.
 */
import { IdScope, isRecord, LenientReader, type JsonRecord } from "../lenientRead";
import { occlusionCurvesToJson, parseOcclusionCurves } from "../occlusionCurves";
import {
  AUDIO_SCENE_FORMAT,
  type AudioTestScene,
  type AudioTestSceneParse,
  type MovingEmitter,
  type SceneBox,
  type SceneObjectBase,
  type StaticEmitter,
  type Test2dSound,
  type TestAudioZone,
  type TestEmitter,
  type TestListener,
  type TestObstacle,
  type TestReverbZone,
  type Vec3,
} from "./testSceneTypes";

/** Every limit of the format, declared once. */
export const AUDIO_SCENE_LIMITS = {
  /** Objects per list (listeners, emitters, obstacles, …). */
  objects: 256,
  /** Waypoints per route. */
  routePoints: 64,
  /** |coordinate| in metres. */
  coordinate: 100000,
  /** Box width and depth, m. */
  size: [0.1, 100000] as [number, number],
  /** The least height a box keeps between bottom and top, m (a box with less is repaired). */
  minHeight: 0.5,
  /** Volume, dB. */
  volume: [-60, 12] as [number, number],
  /** Reverb zone wet, dB. */
  wet: [-60, 12] as [number, number],
  /** Reverb zone priority. */
  priority: [0, 100] as [number, number],
  /** Audio zone feather, m. */
  feather: [0, 100] as [number, number],
  /** Moving emitter speed, m/s. */
  speed: [0, 1000] as [number, number],
  /** Moving emitter path height, m. */
  height: [-1000, 1000] as [number, number],
} as const;

const DEFAULT_LISTENER_HEIGHT = 1.7;
const DEFAULT_EMITTER_HEIGHT = 1.5;
const DEFAULT_BOX: SceneBox = { center: { x: 0, y: 0, z: 0 }, width: 10, depth: 10, yaw: 0, bottom: 0, top: 10 };

/** An empty scene: one listener ("Player 1") at the origin, nothing else. */
export function emptyAudioTestScene(): AudioTestScene {
  return {
    format: AUDIO_SCENE_FORMAT,
    folder: "",
    listeners: [{ id: "listener1", name: "Player 1", hidden: false, locked: false, position: { x: 0, y: DEFAULT_LISTENER_HEIGHT, z: 0 }, yaw: 0 }],
    activeListener: "listener1",
    emitters: [],
    obstacles: [],
    reverbZones: [],
    audioZones: [],
    sounds2d: [],
    base: null,
    replace: {},
  };
}

/** `*.audioscene.json`, leniently. */
export function parseAudioTestScene(raw: unknown, path = "audioscene"): AudioTestSceneParse {
  const problems: string[] = [];
  const r = new LenientReader(problems);
  const scene = emptyAudioTestScene();
  scene.listeners = [];
  if (!isRecord(raw)) {
    r.problem(path, "must be an object; using an empty scene.");
    return { scene: emptyAudioTestScene(), problems };
  }
  if (raw.format !== AUDIO_SCENE_FORMAT) {
    r.problem(`${path}.format`, `expected "${AUDIO_SCENE_FORMAT}"${raw.format === undefined ? "" : `, found ${JSON.stringify(raw.format)}`}; reading it anyway.`);
  }
  scene.folder = r.str(raw.folder, `${path}.folder`, "");
  const ids = new IdScope(r); // one id space across every list, so an id names one object
  const list = <T>(key: string, prefix: string, read: (o: JsonRecord, base: SceneObjectBase, where: string) => T | null): T[] => {
    const items = r.list(raw[key], `${path}.${key}`);
    if (items.length > AUDIO_SCENE_LIMITS.objects) r.problem(`${path}.${key}`, `at most ${AUDIO_SCENE_LIMITS.objects}; the rest are dropped.`);
    const out: T[] = [];
    items.slice(0, AUDIO_SCENE_LIMITS.objects).forEach((item, i) => {
      const where = `${path}.${key}[${i}]`;
      if (!isRecord(item)) { r.problem(where, "must be an object; dropped."); return; }
      const id = ids.take(item.id, where, prefix);
      const base: SceneObjectBase = {
        id,
        name: r.str(item.name, `${where}.name`, id),
        hidden: r.bool(item.hidden, `${where}.hidden`, false),
        locked: r.bool(item.locked, `${where}.locked`, false),
      };
      const value = read(item, base, where);
      if (value !== null) out.push(value);
    });
    return out;
  };

  scene.listeners = list<TestListener>("listeners", "listener", (o, base, where) => ({
    ...base,
    position: vec(r, o.position, `${where}.position`, { x: 0, y: DEFAULT_LISTENER_HEIGHT, z: 0 }),
    yaw: yawOf(r, o.yaw, `${where}.yaw`),
  }));
  if (scene.listeners.length === 0) {
    if (raw.listeners !== undefined) r.problem(`${path}.listeners`, "a scene needs a listener; added \"Player 1\".");
    const id = ids.has("listener1") ? ids.fresh("listener") : ids.take("listener1", path, "listener");
    scene.listeners.push({ id, name: "Player 1", hidden: false, locked: false, position: { x: 0, y: DEFAULT_LISTENER_HEIGHT, z: 0 }, yaw: 0 });
  }
  const active = r.str(raw.activeListener, `${path}.activeListener`, scene.listeners[0]!.id);
  if (scene.listeners.some((l) => l.id === active)) scene.activeListener = active;
  else {
    scene.activeListener = scene.listeners[0]!.id;
    if (raw.activeListener !== undefined) r.problem(`${path}.activeListener`, `no listener "${active}"; using "${scene.activeListener}".`);
  }

  scene.emitters = list<TestEmitter>("emitters", "emitter", (o, base, where) => {
    const kind = r.pick(o.kind, `${where}.kind`, ["static", "moving"] as const, Array.isArray(o.route) ? "moving" : "static");
    const sound = r.str(o.sound, `${where}.sound`, "");
    const volume = r.num(o.volume, `${where}.volume`, 0, ...AUDIO_SCENE_LIMITS.volume);
    // The mixer bus it plays on; absent or "" plays on its sound's own (a playlist's output, else Master).
    const output = r.str(o.output, `${where}.output`, "");
    if (kind === "static") {
      const e: StaticEmitter = { ...base, kind, position: vec(r, o.position, `${where}.position`, { x: 0, y: DEFAULT_EMITTER_HEIGHT, z: 0 }), sound, volume, ...(output ? { output } : {}) };
      return e;
    }
    const e: MovingEmitter = {
      ...base,
      kind,
      route: route(r, o.route, `${where}.route`),
      height: r.num(o.height, `${where}.height`, DEFAULT_EMITTER_HEIGHT, ...AUDIO_SCENE_LIMITS.height),
      speed: r.num(o.speed, `${where}.speed`, 10, ...AUDIO_SCENE_LIMITS.speed),
      start: r.num(o.start, `${where}.start`, 0, 0, 1),
      loop: r.bool(o.loop, `${where}.loop`, true),
      sound,
      volume,
      ...(output ? { output } : {}),
    };
    return e;
  });

  scene.obstacles = list<TestObstacle>("obstacles", "obstacle", (o, base, where) => ({
    ...base,
    box: box(r, o.box, `${where}.box`),
    material: r.str(o.material, `${where}.material`, ""),
  }));

  scene.reverbZones = list<TestReverbZone>("reverbZones", "reverb", (o, base, where) => ({
    ...base,
    box: box(r, o.box, `${where}.box`),
    preset: nonEmpty(r, o.preset, `${where}.preset`, "hall"),
    wet: r.num(o.wet, `${where}.wet`, -6, ...AUDIO_SCENE_LIMITS.wet),
    priority: r.int(o.priority, `${where}.priority`, 0, ...AUDIO_SCENE_LIMITS.priority),
    levelDefault: r.bool(o.levelDefault, `${where}.levelDefault`, false),
  }));

  scene.audioZones = list<TestAudioZone>("audioZones", "zone", (o, base, where) => ({
    ...base,
    box: box(r, o.box, `${where}.box`),
    sound: r.str(o.sound, `${where}.sound`, ""),
    heard: r.pick(o.heard, `${where}.heard`, ["edge", "inside"] as const, "edge"),
    feather: r.num(o.feather, `${where}.feather`, 5, ...AUDIO_SCENE_LIMITS.feather),
    volume: r.num(o.volume, `${where}.volume`, 0, ...AUDIO_SCENE_LIMITS.volume),
  }));

  scene.sounds2d = list<Test2dSound>("sounds2d", "sound", (o, base, where) => ({
    ...base,
    sound: r.str(o.sound, `${where}.sound`, ""),
    volume: r.num(o.volume, `${where}.volume`, -6, ...AUDIO_SCENE_LIMITS.volume),
    output: r.str(o.output, `${where}.output`, ""),
  }));

  const base = r.strOrNull(raw.base, `${path}.base`, null);
  scene.base = base === "" ? null : base;
  const replace = r.record(raw.replace, `${path}.replace`);
  if (replace) {
    for (const [k, v] of Object.entries(replace)) {
      if (typeof v === "string" && v !== "") scene.replace[k] = v;
      else r.problem(`${path}.replace.${k}`, "must be a playlist or sample path; dropped.");
    }
  }
  if (scene.base === null && Object.keys(scene.replace).length > 0) r.problem(`${path}.replace`, "only applies with a base scene; kept for when one is set.");
  // ADR 0362 item 6: the scene's own occlusion curves (absent: the project's).
  const settings = r.record(raw.settings, `${path}.settings`);
  const occ = settings ? r.record(settings.occlusion, `${path}.settings.occlusion`) : undefined;
  const curves = occ ? parseOcclusionCurves(occ.curves, `${path}.settings.occlusion.curves`, problems) : undefined;
  if (curves) scene.settings = { occlusion: { curves } };
  return { scene, problems };
}

function vec(r: LenientReader, raw: unknown, where: string, fallback: Vec3): Vec3 {
  if (raw === undefined) return { ...fallback };
  if (!isRecord(raw)) {
    r.problem(where, "must be {x, y, z}; using the default.");
    return { ...fallback };
  }
  const L = AUDIO_SCENE_LIMITS.coordinate;
  return { x: r.num(raw.x, `${where}.x`, fallback.x, -L, L), y: r.num(raw.y, `${where}.y`, fallback.y, -L, L), z: r.num(raw.z, `${where}.z`, fallback.z, -L, L) };
}

/** Degrees, wrapped into -180..180. */
function yawOf(r: LenientReader, raw: unknown, where: string): number {
  const y = r.num(raw, where, 0);
  const w = ((((y + 180) % 360) + 360) % 360) - 180;
  return w === -180 && y > 0 ? 180 : w + 0;
}

function nonEmpty(r: LenientReader, raw: unknown, where: string, fallback: string): string {
  const s = r.str(raw, where, fallback);
  if (s !== "") return s;
  r.problem(where, `must not be empty; using "${fallback}".`);
  return fallback;
}

function route(r: LenientReader, raw: unknown, where: string): Vec3[] {
  const items = r.list(raw, where);
  if (items.length > AUDIO_SCENE_LIMITS.routePoints) r.problem(where, `at most ${AUDIO_SCENE_LIMITS.routePoints} points; the rest are dropped.`);
  const pts: Vec3[] = [];
  items.slice(0, AUDIO_SCENE_LIMITS.routePoints).forEach((p, i) => {
    if (!isRecord(p)) { r.problem(`${where}[${i}]`, "must be {x, z}; dropped."); return; }
    const v = vec(r, p, `${where}[${i}]`, { x: 0, y: 0, z: 0 });
    pts.push({ x: v.x, y: 0, z: v.z });
  });
  if (pts.length >= 2) return pts;
  r.problem(where, "a route needs at least 2 points; completed with a 10 m segment.");
  const a = pts[0] ?? { x: 0, y: 0, z: 0 };
  return [a, { x: a.x + 10, y: 0, z: a.z }];
}

function box(r: LenientReader, raw: unknown, where: string): SceneBox {
  if (raw === undefined) return structuredClone(DEFAULT_BOX);
  if (!isRecord(raw)) {
    r.problem(where, "must be a box; using a 10 m box.");
    return structuredClone(DEFAULT_BOX);
  }
  const L = AUDIO_SCENE_LIMITS;
  const b: SceneBox = {
    center: vec(r, raw.center, `${where}.center`, { x: 0, y: 0, z: 0 }),
    width: r.num(raw.width, `${where}.width`, DEFAULT_BOX.width, ...L.size),
    depth: r.num(raw.depth, `${where}.depth`, DEFAULT_BOX.depth, ...L.size),
    yaw: yawOf(r, raw.yaw, `${where}.yaw`),
    bottom: r.num(raw.bottom, `${where}.bottom`, DEFAULT_BOX.bottom, -L.coordinate, L.coordinate),
    top: r.num(raw.top, `${where}.top`, DEFAULT_BOX.top, -L.coordinate, L.coordinate),
  };
  if (b.bottom >= b.top - L.minHeight) {
    const top = b.bottom + L.minHeight;
    r.problem(where, `bottom (${b.bottom}) must be at least ${L.minHeight} m below top (${b.top}); using top ${top}.`);
    b.top = top;
  }
  return b;
}

// --- routes ---------------------------------------------------------------------------------------------------------

/** A route's length on the ground plane, metres (the sum of its segments in x/z). */
export function routeLength(route: readonly Vec3[]): number {
  let n = 0;
  for (let i = 1; i < route.length; i++) n += Math.hypot(route[i]!.x - route[i - 1]!.x, route[i]!.z - route[i - 1]!.z);
  return n;
}

/**
 * Where a moving emitter is at arc-length fraction `u` (0..1, wrapped when `loop`, else clamped) of its route, `height`
 * above the ground plane, and the unit direction it travels (its velocity is that times its speed). A route of one
 * point, or of zero length, stays at its first point facing +z.
 */
export function routePose(route: readonly Vec3[], height: number, u: number, loop: boolean, out: { position: Vec3; direction: Vec3 }): void {
  const total = routeLength(route);
  const first = route[0] ?? { x: 0, y: 0, z: 0 };
  out.direction.x = 0; out.direction.y = 0; out.direction.z = 1;
  out.position.x = first.x; out.position.y = height; out.position.z = first.z;
  if (!(total > 0)) return;
  const f = loop ? ((u % 1) + 1) % 1 : Math.min(1, Math.max(0, u));
  let left = f * total;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!, b = route[i]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len <= 0) continue;
    if (left <= len || i === route.length - 1) {
      const t = Math.min(1, left / len);
      out.position.x = a.x + (b.x - a.x) * t;
      out.position.z = a.z + (b.z - a.z) * t;
      out.direction.x = (b.x - a.x) / len;
      out.direction.z = (b.z - a.z) / len;
      return;
    }
    left -= len;
  }
}

// --- writing --------------------------------------------------------------------------------------------------------

const baseJson = (o: SceneObjectBase): JsonRecord => ({ id: o.id, name: o.name, ...(o.hidden ? { hidden: true } : {}), ...(o.locked ? { locked: true } : {}) });
const vecJson = (v: Vec3): JsonRecord => ({ x: v.x, y: v.y, z: v.z });
const boxJson = (b: SceneBox): JsonRecord => ({ center: vecJson(b.center), width: b.width, depth: b.depth, yaw: b.yaw, bottom: b.bottom, top: b.top });

/** `*.audioscene.json` content (`format` first); `parseAudioTestScene` reads it back unchanged. */
export function audioTestSceneToJson(scene: AudioTestScene): JsonRecord {
  return {
    format: AUDIO_SCENE_FORMAT,
    folder: scene.folder,
    listeners: scene.listeners.map((l) => ({ ...baseJson(l), position: vecJson(l.position), yaw: l.yaw })),
    activeListener: scene.activeListener,
    emitters: scene.emitters.map((e) => e.kind === "static"
      ? { ...baseJson(e), kind: e.kind, position: vecJson(e.position), sound: e.sound, volume: e.volume, ...(e.output ? { output: e.output } : {}) }
      : { ...baseJson(e), kind: e.kind, route: e.route.map((p) => ({ x: p.x, z: p.z })), height: e.height, speed: e.speed, start: e.start, loop: e.loop, sound: e.sound, volume: e.volume, ...(e.output ? { output: e.output } : {}) }),
    obstacles: scene.obstacles.map((o) => ({ ...baseJson(o), box: boxJson(o.box), material: o.material })),
    reverbZones: scene.reverbZones.map((z) => ({ ...baseJson(z), box: boxJson(z.box), preset: z.preset, wet: z.wet, priority: z.priority, ...(z.levelDefault ? { levelDefault: true } : {}) })),
    audioZones: scene.audioZones.map((z) => ({ ...baseJson(z), box: boxJson(z.box), sound: z.sound, heard: z.heard, feather: z.feather, volume: z.volume })),
    sounds2d: scene.sounds2d.map((s) => ({ ...baseJson(s), sound: s.sound, volume: s.volume, output: s.output })),
    base: scene.base,
    replace: { ...scene.replace },
    ...(scene.settings?.occlusion?.curves ? { settings: { occlusion: { curves: occlusionCurvesToJson(scene.settings.occlusion.curves) } } } : {}),
  };
}

// --- references -----------------------------------------------------------------------------------------------------

export type TestSceneReferenceKind = "sound" | "scene";

/** One place a test scene names an asset: a sound (playlist or sample) or its base game scene. */
export interface TestSceneReference {
  readonly kind: TestSceneReferenceKind;
  readonly path: string;
  /** Where: `emitters[i].sound`, `audioZones[i].sound`, `sounds2d[i].sound`, `replace.<key>`, or `base`. */
  readonly where: string;
}

/** Every path `scene` names, in file order (emitters, audio zones, 2D sounds, base, replacements). Empty paths are skipped. */
export function testSceneReferences(scene: AudioTestScene): TestSceneReference[] {
  const out: TestSceneReference[] = [];
  const add = (kind: TestSceneReferenceKind, path: string | null, where: string) => { if (path) out.push({ kind, path, where }); };
  scene.emitters.forEach((e, i) => add("sound", e.sound, `emitters[${i}].sound`));
  scene.audioZones.forEach((z, i) => add("sound", z.sound, `audioZones[${i}].sound`));
  scene.sounds2d.forEach((s, i) => add("sound", s.sound, `sounds2d[${i}].sound`));
  add("scene", scene.base, "base");
  for (const [k, v] of Object.entries(scene.replace)) add("sound", v, `replace.${k}`);
  return out;
}

/** Where paths go after a move: a function of the old path, or a map from old to new paths (unlisted paths stay). */
export type TestSceneMoves = ((path: string) => string) | ReadonlyMap<string, string> | Readonly<Record<string, string>>;

const mover = (moves: TestSceneMoves): ((path: string) => string) => {
  if (typeof moves === "function") return moves;
  if (moves instanceof Map) return (p) => moves.get(p) ?? p;
  const record = moves as Readonly<Record<string, string>>;
  return (p) => (Object.prototype.hasOwnProperty.call(record, p) ? record[p]! : p);
};

/**
 * `scene` with every sound and base path moved by `moves`. Returns `scene` itself when nothing changes; otherwise a copy
 * sharing the untouched lists. A `replace` key names a component path in the base scene, not an asset, and stays.
 */
export function rewriteTestSceneReferences(scene: AudioTestScene, moves: TestSceneMoves): AudioTestScene {
  const to = mover(moves);
  const move = (p: string): string => { if (p === "") return p; const n = to(p); return n === "" ? p : n; };
  let changed = false;
  const mapList = <T extends { sound: string }>(items: T[]): T[] => {
    let any = false;
    const next = items.map((it) => { const s = move(it.sound); if (s === it.sound) return it; any = true; return { ...it, sound: s }; });
    if (!any) return items;
    changed = true;
    return next;
  };
  const emitters = mapList(scene.emitters);
  const audioZones = mapList(scene.audioZones);
  const sounds2d = mapList(scene.sounds2d);
  const base = scene.base === null ? null : move(scene.base);
  if (base !== scene.base) changed = true;
  let replace = scene.replace;
  for (const [k, v] of Object.entries(scene.replace)) {
    const n = move(v);
    if (n === v) continue;
    if (replace === scene.replace) replace = { ...scene.replace };
    replace[k] = n;
    changed = true;
  }
  return changed ? { ...scene, emitters, audioZones, sounds2d, base, replace } : scene;
}
