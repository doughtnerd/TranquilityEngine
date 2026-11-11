// What only clients do (ADR 0017, 0033): read the helm from the mouse and keyboard, float and
// colour ships on the waves (ghostly while a ghost, hidden inside others' fog clouds, faded inside
// a cloud when this client can still see them), carry the flag above its holder, bob power-ups,
// thin out fading clouds, mark the arena's edge on the water, and play the effects the server
// reports.
import { Audio, Camera, Color, GameObject, Input, MeshRenderer, ParticleSystem, Plane, Quaternion, Replicated, Transform, Vector3, Water, defineSystem } from "myco";
import {
  BOLT_PREFAB,
  Battery,
  Cloud,
  FlagState,
  Fx,
  FxKind,
  HULL_HALF_LENGTH,
  HULL_HALF_WIDTH,
  Helm,
  Pickup,
  RESPAWN_DELAY,
  SPLASH_PREFAB,
  Ship,
  TEAM_COLORS,
  cloudSpots,
  game,
  inCloudAmong,
  myShip,
  type CloudView,
  type FlagView,
  type ShipView,
} from "./data";
import { Hud } from "./behaviors/Hud";
import { arenaRadius } from "./systems";
import { flash } from "./weather";

/** Each client World's chosen battery (A: port, D: starboard), kept between ticks. */
const chosenBattery = new WeakMap<object, number>();

const WATER_PLANE = Plane.fromNormalAndPoint(Vector3.up, Vector3.zero);

/** The helm a client sends: what it would be, held while the "Leave the match?" dialog is open. */
export type HelmInput = { x: number; z: number; steer: number; battery: number; fire: number; drop: number };

/**
 * The helm with the leave dialog open: the ship holds its course (no steering, so moving the mouse
 * to the dialog's buttons doesn't swing it round), and doesn't fire or drop a fog cloud. The
 * battery stays as it was.
 */
export function heldHelm(helm: HelmInput, dialogOpen: boolean): HelmInput {
  return dialogOpen ? { ...helm, steer: 0, fire: 0, drop: 0 } : helm;
}

/**
 * This tick's helm: the point on the water under the mouse, the battery (A or D picks one, and
 * it stays picked), Space to fire and F to drop a ghost ship's fog cloud; held while the HUD's
 * leave dialog is open (`heldHelm`). Only the World with local input sees the mouse and keys.
 */
defineSystem({
  name: "pirates.ReadHelm",
  phase: "fixedUpdate",
  worlds: ["client"],
  before: ["pirates.Sail"],
  run(_rows, ctx) {
    const leaving = GameObject.findObjectOfType(Hud)?.leaving ?? false;
    if (Input.getKey("a") || Input.getKey("arrowleft")) chosenBattery.set(ctx.world, Battery.port);
    if (Input.getKey("d") || Input.getKey("arrowright")) chosenBattery.set(ctx.world, Battery.starboard);
    const camera = Camera.main;
    let x = 0, z = 0, steer = 0;
    if (camera && !Input.pointerOverUI) {
      const ray = camera.screenPointToRay(Input.mousePosition);
      const t = WATER_PLANE.raycast(ray);
      if (t !== null) {
        const at = ray.at(t);
        x = at.x;
        z = at.z;
        steer = 1;
      }
    }
    const helm = { x, z, steer, battery: chosenBattery.get(ctx.world) ?? Battery.none, fire: Input.getKey("space") ? 1 : 0, drop: Input.getKey("f") ? 1 : 0 };
    Helm.write(heldHelm(helm, leaving));
  },
});

/** Colours already applied (per renderer), so each is set once. */
const tinted = new WeakMap<object, string>();
const GHOST_SAILS = "#c8ffe8";
/** A ship seen inside a fog cloud: a dark, see-through silhouette (it reads against the white fog) and faded sails. */
const FOG_HULL = new Color(0.16, 0.22, 0.3, 0.6);
const FOG_GHOST_HULL = new Color(0.2, 0.55, 0.45, 0.6);
const FOG_SAILS_ALPHA = 0.6;

/** Set a renderer's colour, only when it changes (`null`: back to its material's own). */
function tint(renderer: MeshRenderer | null | undefined, colour: Color | null): void {
  if (!renderer) return;
  const key = colour ? `${colour.toHex()}${colour.a.toFixed(2)}` : "";
  if (tinted.get(renderer) === key) return;
  if (colour) renderer.setMaterialProperty("color", colour);
  else renderer.clearMaterialProperty("color");
  tinted.set(renderer, key);
}

/** Show or hide a node, only when that changes. */
function show(node: GameObject | null | undefined, on: boolean): void {
  if (node && node.active !== on) node.setActive(on);
}

/**
 * Floats each ship's `Visual` child on the waves (height, pitch and roll from four samples around
 * the hull), sinks it while it's sunk, blinks it while it can't be hurt, swaps in the ghostly hull
 * while it's a ghost, and colours its sails by team. Inside a fog cloud, another team's ship is
 * hidden (unless the cloud is this client's own); this client's ship, or one it can still see
 * there, draws faded and see-through, so its captain can tell the fog hides it.
 */
defineSystem({
  name: "pirates.ShipVisuals",
  phase: "lateUpdate",
  worlds: ["client"],
  query: [Transform, Ship],
  run(rows, ctx) {
    const now = ctx.world.time.time;
    const me = myShip();
    const spots = cloudSpots();
    for (const row of rows) {
      const ship = row.ship as ShipView;
      const visual = row.node.find("Visual");
      if (!visual?.transform) continue;
      const mine = row.node.getBehavior(Replicated)?.isOwnedLocally ?? false;
      const p = row.transform.position;
      const hidden = !mine && inCloudAmong(spots, p.x, p.z, me?.data.team ?? -1);
      const fogged = !hidden && inCloudAmong(spots, p.x, p.z);
      const ghost = ship.ghost > 0;
      show(visual.find("Hull"), !ghost && !fogged);
      show(visual.find("GhostHull"), ghost || fogged);
      tint(visual.find("GhostHull")?.getBehavior(MeshRenderer), fogged ? (ghost ? FOG_GHOST_HULL : FOG_HULL) : null);
      const sails = Color.from(ghost ? GHOST_SAILS : TEAM_COLORS[ship.team]);
      if (fogged) sails.a = FOG_SAILS_ALPHA;
      tint(visual.find("Sails")?.getBehavior(MeshRenderer), sails);
      const at = (lx: number, lz: number) => {
        const w = row.transform.localToWorld.transformPoint({ x: lx, y: 0, z: lz });
        return Water.sample(w.x, w.z)?.height ?? 0;
      };
      const bow = at(0, HULL_HALF_LENGTH), stern = at(0, -HULL_HALF_LENGTH);
      const port = at(HULL_HALF_WIDTH, 0), star = at(-HULL_HALF_WIDTH, 0);
      let y = (bow + stern + port + star) / 4 - 0.1;
      let pitch = (Math.atan2(stern - bow, HULL_HALF_LENGTH * 2) * 180) / Math.PI;
      let roll = ((Math.atan2(port - star, HULL_HALF_WIDTH * 2) * 180) / Math.PI) * 0.6;
      if (ship.sunk > 0) {
        const t = RESPAWN_DELAY - ship.sunk;
        y -= t * t * 0.35;
        pitch -= Math.min(30, t * 12);
        roll += Math.min(20, t * 6);
      }
      visual.transform.position.set(0, y, 0);
      visual.transform.rotation = Quaternion.fromEuler(pitch, 0, roll);
      const blink = ship.invulnerable > 0 && Math.floor(now * 8) % 2 === 1;
      show(visual, !hidden && !blink);
      show(row.node.find("Visual/Flag"), ship.flag !== 0);
    }
  },
});

/** A fog cloud stops making new puffs when this many seconds are left, so it has thinned away by its end. */
const CLOUD_FADE = 4.5;

/**
 * The flag floats on the water where it was dropped, and is hidden while a ship carries it (the
 * holder shows its own pennant). Power-ups bob and turn; a fog cloud stops billowing near its end.
 */
defineSystem({
  name: "pirates.Props",
  phase: "lateUpdate",
  worlds: ["client"],
  run(_rows, ctx) {
    const now = ctx.world.time.time;
    for (const rep of GameObject.findObjectsOfType(Replicated)) {
      const node = rep.node;
      if (!node.isValid || !node.transform) continue;
      const row = { transform: node.transform };
      const flagState = node.getData(FlagState) as FlagView | null;
      if (flagState) {
        const p = row.transform.position;
        show(node.find("Visual"), flagState.carrier < 0);
        const visual = node.find("Visual")?.transform;
        if (visual) visual.position.set(0, (Water.sample(p.x, p.z)?.height ?? 0) + Math.sin(now * 2) * 0.1, 0);
        continue;
      }
      if (node.hasData(Pickup)) {
        const visual = node.find("Visual")?.transform;
        const p = row.transform.position;
        if (visual) {
          visual.position.set(0, (Water.sample(p.x, p.z)?.height ?? 0) + 0.5 + Math.sin(now * 3 + p.x) * 0.15, 0);
          visual.rotation = Quaternion.fromEuler(0, now * 60, 0);
        }
        continue;
      }
      const cloud = node.getData(Cloud) as CloudView | null;
      if (cloud && cloud.life < CLOUD_FADE) {
        const puffs = node.find("Visual")?.getBehavior(ParticleSystem);
        if (puffs?.isPlaying) puffs.stop();
      }
    }
  },
});

const SOUNDS: Record<number, { clip: string; volume: number; pitch?: [number, number]; flat?: boolean }> = {
  [FxKind.fire]: { clip: "audio/cannon_fire.wav", volume: 0.9, pitch: [0.9, 1.1] },
  [FxKind.splash]: { clip: "audio/cannonball_splash.wav", volume: 0.5, pitch: [0.85, 1.2] },
  [FxKind.hit]: { clip: "audio/wood_crunch.wav", volume: 0.8, pitch: [0.9, 1.15] },
  [FxKind.crunch]: { clip: "audio/wood_crunch.wav", volume: 1, pitch: [0.7, 0.85] },
  [FxKind.sink]: { clip: "audio/wood_crunch.wav", volume: 1, pitch: [0.5, 0.6] },
  [FxKind.lightning]: { clip: "audio/thunder.wav", volume: 1, flat: true },
  [FxKind.pickup]: { clip: "audio/powerup_pickup.wav", volume: 0.8 },
  [FxKind.flag]: { clip: "audio/flag_capture.wav", volume: 0.8, flat: true },
  [FxKind.cloud]: { clip: "audio/cannonball_splash.wav", volume: 0.6, pitch: [0.4, 0.5] },
};

/** Plays what the server reports: a sound where it happened, a splash on the water, a lightning bolt. */
defineSystem({
  name: "pirates.PlayFx",
  phase: "update",
  worlds: ["client"],
  run(_rows, ctx) {
    for (const fx of Fx.read()) {
      const sound = SOUNDS[fx.kind];
      if (sound) {
        const [lo, hi] = sound.pitch ?? [1, 1];
        const pitch = lo + Math.random() * (hi - lo);
        if (sound.flat) Audio.playOneShot(sound.clip, { volume: sound.volume, pitch });
        else Audio.playOneShot(sound.clip, { position: { x: fx.x, y: fx.y, z: fx.z }, volume: sound.volume, pitch, minDistance: 6, maxDistance: 120 });
      }
      if (fx.kind === FxKind.splash || fx.kind === FxKind.hit || fx.kind === FxKind.sink || fx.kind === FxKind.crunch || fx.kind === FxKind.cloud) {
        const size = fx.kind === FxKind.sink ? 3 : fx.kind === FxKind.cloud ? 6 : fx.kind === FxKind.splash ? 1 : 0.7;
        const node = GameObject.instantiate(SPLASH_PREFAB, { position: [fx.x, fx.y, fx.z] });
        node.transform!.scale.set(size, size, size);
      }
      if (fx.kind === FxKind.lightning) {
        GameObject.instantiate(BOLT_PREFAB, { position: [fx.x, 0, fx.z] });
        flash(ctx.world);
      }
    }
  },
});

/** The arena's edge on the water: a glowing line of floats, with a buoy every few, built per arena. */
const EDGE_MATERIAL = "asset:materials/edge.material.json";
const EDGE_SPACING = 2.5;
const BUOY_EVERY = 4;
interface Edge {
  radius: number;
  root: GameObject;
  floats: { transform: Transform; x: number; z: number; lift: number }[];
}
const edges = new WeakMap<object, Edge>();

function buildEdge(radius: number): Edge {
  const root = GameObject.create("Arena Edge");
  const floats: Edge["floats"] = [];
  const count = Math.max(24, Math.round((2 * Math.PI * radius) / EDGE_SPACING));
  const length = ((2 * Math.PI * radius) / count) * 0.8;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const x = Math.sin(a) * radius, z = Math.cos(a) * radius;
    const yaw = (a * 180) / Math.PI;
    const float = GameObject.create(`Float ${i + 1}`, { parent: root });
    float.transform!.position.set(x, 0, z);
    float.transform!.rotation = Quaternion.fromEuler(0, yaw, 0);
    float.transform!.scale.set(length, 0.12, 0.5);
    float.addComponent(MeshRenderer, { mesh: "builtin:cube", material: EDGE_MATERIAL, castShadows: false, receiveShadows: false });
    floats.push({ transform: float.transform!, x, z, lift: 0.12 });
    if (i % BUOY_EVERY !== 0) continue;
    const buoy = GameObject.create(`Buoy ${i / BUOY_EVERY + 1}`, { parent: root });
    buoy.transform!.position.set(x, 0, z);
    buoy.transform!.rotation = Quaternion.fromEuler(0, yaw, 0);
    buoy.addComponent(MeshRenderer, { mesh: "asset:models/flag.obj#Buoy", castShadows: false });
    floats.push({ transform: buoy.transform!, x, z, lift: -0.05 });
  }
  return { radius, root, floats };
}

/** Builds the arena's edge once its radius is known (again when the arena changes) and floats it on the waves. */
defineSystem({
  name: "pirates.ArenaEdge",
  phase: "lateUpdate",
  worlds: ["client"],
  run(_rows, ctx) {
    if (!game()) return;
    const radius = arenaRadius();
    let edge = edges.get(ctx.world);
    if (!edge || !edge.root.isValid || edge.radius !== radius) {
      if (edge?.root.isValid) GameObject.destroy(edge.root);
      edge = buildEdge(radius);
      edges.set(ctx.world, edge);
    }
    for (const f of edge.floats) f.transform.position.y = (Water.sample(f.x, f.z)?.height ?? 0) + f.lift;
  },
});
