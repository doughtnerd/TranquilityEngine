// What only clients do (ADR 0017, 0033): read the helm from the mouse and keyboard, float and
// colour ships on the waves, and play the effects the server reports.
import { Audio, Camera, Color, GameObject, Input, MeshRenderer, Plane, Quaternion, Transform, Vector3, Water, defineSystem, isResimulating } from "myco";
import { Battery, Fx, FxKind, HULL_HALF_LENGTH, HULL_HALF_WIDTH, Helm, RESPAWN_DELAY, SPLASH_PREFAB, Ship, TEAM_COLORS, type ShipView } from "./data";

/** Each client World's chosen battery (A: port, D: starboard), kept between ticks. */
const chosenBattery = new WeakMap<object, number>();

const WATER_PLANE = Plane.fromNormalAndPoint(Vector3.up, Vector3.zero);

/**
 * This tick's helm: the point on the water under the mouse, the battery (A or D picks one, and
 * it stays picked), and Space to fire. Only the World with local input sees the mouse and keys.
 */
defineSystem({
  name: "pirates.ReadHelm",
  phase: "fixedUpdate",
  worlds: ["client"],
  before: ["pirates.Sail"],
  run(_rows, ctx) {
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
    Helm.write({ x, z, steer, battery: chosenBattery.get(ctx.world) ?? Battery.none, fire: Input.getKey("space") ? 1 : 0 });
  },
});

/** Sail colours already applied, so the texture is set once per ship. */
const tinted = new WeakMap<object, number>();

/**
 * Floats each ship's `Visual` child on the waves (height, pitch and roll from four samples around
 * the hull), sinks it while it's sunk, blinks it while it can't be hurt, and gives its sails the
 * team's colour.
 */
defineSystem({
  name: "pirates.ShipVisuals",
  phase: "lateUpdate",
  worlds: ["client"],
  query: [Transform, Ship],
  run(rows, ctx) {
    const now = ctx.world.time.time;
    for (const row of rows) {
      const ship = row.ship as ShipView;
      const visual = row.node.find("Visual");
      if (!visual?.transform) continue;
      const sails = visual.find("Sails")?.getBehavior(MeshRenderer);
      if (sails && tinted.get(sails) !== ship.team) {
        sails.setMaterialProperty("color", Color.from(TEAM_COLORS[ship.team]));
        tinted.set(sails, ship.team);
      }
      const at = (lx: number, lz: number) => {
        const w = row.transform.localToWorld({ x: lx, y: 0, z: lz });
        return Water.sample(w.x, w.z)?.height ?? 0;
      };
      const bow = at(0, HULL_HALF_LENGTH), stern = at(0, -HULL_HALF_LENGTH);
      const port = at(HULL_HALF_WIDTH, 0), star = at(-HULL_HALF_WIDTH, 0);
      let y = (bow + stern + port + star) / 4 - 0.1;
      let pitch = (Math.atan2(stern - bow, HULL_HALF_LENGTH * 2) * 180) / Math.PI;
      let roll = (Math.atan2(port - star, HULL_HALF_WIDTH * 2) * 180) / Math.PI * 0.6;
      if (ship.sunk > 0) {
        const t = RESPAWN_DELAY - ship.sunk;
        y -= t * t * 0.35;
        pitch -= Math.min(30, t * 12);
        roll += Math.min(20, t * 6);
      }
      visual.transform.position.set(0, y, 0);
      visual.transform.rotation = Quaternion.fromEuler(pitch, 0, roll);
      const show = ship.invulnerable <= 0 || Math.floor(now * 8) % 2 === 0;
      if (visual.active !== show) visual.setActive(show);
    }
  },
});

const SOUNDS: Record<number, { clip: string; volume: number; pitch?: [number, number] }> = {
  [FxKind.fire]: { clip: "audio/cannon_fire.wav", volume: 0.9, pitch: [0.9, 1.1] },
  [FxKind.splash]: { clip: "audio/cannonball_splash.wav", volume: 0.5, pitch: [0.85, 1.2] },
  [FxKind.hit]: { clip: "audio/wood_crunch.wav", volume: 0.8, pitch: [0.9, 1.15] },
  [FxKind.crunch]: { clip: "audio/wood_crunch.wav", volume: 1, pitch: [0.7, 0.85] },
  [FxKind.sink]: { clip: "audio/wood_crunch.wav", volume: 1, pitch: [0.5, 0.6] },
};

/** Plays what the server reports: a sound where it happened, and a splash on the water. */
defineSystem({
  name: "pirates.PlayFx",
  phase: "update",
  worlds: ["client"],
  run() {
    if (isResimulating()) return;
    for (const fx of Fx.read()) {
      const sound = SOUNDS[fx.kind];
      if (sound) {
        const [lo, hi] = sound.pitch ?? [1, 1];
        Audio.playOneShot(sound.clip, { position: { x: fx.x, y: fx.y, z: fx.z }, volume: sound.volume, pitch: lo + Math.random() * (hi - lo), minDistance: 6, maxDistance: 120 });
      }
      if (fx.kind === FxKind.splash || fx.kind === FxKind.hit || fx.kind === FxKind.sink || fx.kind === FxKind.crunch) {
        const size = fx.kind === FxKind.sink ? 3 : fx.kind === FxKind.splash ? 1 : 0.7;
        const node = GameObject.instantiate(SPLASH_PREFAB, { position: [fx.x, fx.y, fx.z] });
        node.transform!.scale.set(size, size, size);
      }
    }
  },
});
