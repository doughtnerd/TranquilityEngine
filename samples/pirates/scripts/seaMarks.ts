// The marks ships leave on the sea, drawn where the game is drawn (client Worlds, and the
// menu's own World for its backdrop ships), never on the server: they're only for the eye. (Rain
// rings the water in its own effect, effects/rain.particles.json: drops die where they meet the
// scene's depth, and some deaths spawn a flat ring there.)
// - a bow wave (a V of churned water from the stem) and a stern wake (a widening band along
//   the path the stern took), both as strong as the ship is fast and gone when it stops.
// Every mark lies on the waves: each frame its points take the sea's height (`Water.sample`). The
// shapes and the speed-to-strength curve are in seaMarkShapes.ts.
import { Color, GameObject, LineRenderer, Quaternion, Replicated, Water, defineSystem, type Curve, type Gradient } from "myco";
import { HULL_HALF_LENGTH, SHIP_SPEED, cloudSpots, inCloudAmong, myShip, ships } from "./data";
import { MenuBackdrop } from "./behaviors/MenuBackdrop";
import { WakePath, bowWave, wakeStrength } from "./seaMarkShapes";

const WAKE_TEXTURE = "asset:textures/wake.png";

/** How far above the sampled surface marks float, so the waves don't swallow them. */
const LIFT = 0.06;
/** A flat mark faces +Z: this turns a node's +Z to world up. */
const FACE_UP = Quaternion.lookRotation([0, 1, 0], [0, 0, 1]);

// --- bow waves and stern wakes -------------------------------------------------------------------

/** Seconds a wake's water stays churned, and the metres between its points. */
const WAKE_LIFE = 2.6;
const WAKE_SPACING = 1;
const WAKE_MAX_POINTS = 48;
/** The wake's width at its far end at full strength (it starts narrower at the stern). */
const WAKE_WIDTH = 3.2;
const WAKE_ALPHA = 0.55;
/** The bow wave: its arms' width at full strength and how strongly it shows. */
const BOW_WIDTH = 1.1;
const BOW_ALPHA = 0.7;
/** A ship that moves further than this in one frame jumped (it respawned): its wake starts again. */
const JUMP = 8;
/** How quickly the measured speed follows the ship (per second). */
const SPEED_FOLLOW = 6;

/** Narrow under the stern, widening behind; faint where it leaves the hull, fading out at its end. */
const WAKE_WIDTH_CURVE: Curve = [[0, 0.4], [1, 1]];
const WAKE_GRADIENT: Gradient = { colors: [[0, "#ffffff"]], alphas: [[0, 0], [0.08, 1], [0.45, 0.6], [1, 0]] };
/** Thin at the stem, wider along the arms; strongest near the stem, gone at the arms' ends. */
const BOW_WIDTH_CURVE: Curve = [[0, 1], [0.5, 0.35], [1, 1]];
const BOW_GRADIENT: Gradient = { colors: [[0, "#ffffff"]], alphas: [[0, 0], [0.3, 0.8], [0.5, 1], [0.7, 0.8], [1, 0]] };

interface Hull {
  /** The ship's node last frame, and where it was. */
  x: number;
  z: number;
  /** Its speed over the water (m/s), measured from how it moves, smoothed. */
  speed: number;
  /** How strongly it churns the water now, 0..1 (`wakeStrength`, eased; 0 while hidden). */
  strength: number;
  path: WakePath;
  root: GameObject;
  wake: LineRenderer;
  bow: LineRenderer;
}
const hulls = new WeakMap<object, Map<GameObject, Hull>>();

function markLine(root: GameObject, name: string, width: number, curve: Curve, gradient: Gradient): LineRenderer {
  const node = GameObject.create(name, { parent: root });
  node.transform!.rotation = FACE_UP;
  return node.addComponent(LineRenderer, {
    texture: WAKE_TEXTURE,
    alignment: "transformZ",
    textureMode: "stretch",
    width,
    widthCurve: curve,
    colorGradient: gradient,
    color: new Color(1, 1, 1, 0),
    castShadows: false,
    receiveShadows: false,
  });
}

function buildHull(node: GameObject): Hull {
  const p = node.transform!.worldPosition;
  const root = GameObject.create(`Sea Marks (${node.name})`);
  return {
    x: p.x,
    z: p.z,
    speed: 0,
    strength: 0,
    path: new WakePath(WAKE_SPACING, WAKE_LIFE, WAKE_MAX_POINTS),
    root,
    wake: markLine(root, "Stern Wake", WAKE_WIDTH, WAKE_WIDTH_CURVE, WAKE_GRADIENT),
    bow: markLine(root, "Bow Wave", BOW_WIDTH, BOW_WIDTH_CURVE, BOW_GRADIENT),
  };
}

const seaHeight = (x: number, z: number) => (Water.sample(x, z)?.height ?? 0) + LIFT;

/** The ships to mark: the match's (each hidden from this client while it's inside someone else's fog cloud), and the menu backdrop's. */
function sailing(): { node: GameObject; hidden: boolean; sunk: boolean }[] {
  const out: { node: GameObject; hidden: boolean; sunk: boolean }[] = [];
  const all = ships();
  if (all.length) {
    const spots = cloudSpots();
    const team = myShip()?.data.team ?? -1;
    for (const s of all) {
      const mine = s.node.getBehavior(Replicated)?.isOwnedLocally ?? false;
      const p = s.node.transform!.position;
      out.push({ node: s.node, hidden: !mine && inCloudAmong(spots, p.x, p.z, team), sunk: s.data.sunk > 0 });
    }
  }
  for (const backdrop of GameObject.findObjectsOfType(MenuBackdrop)) {
    for (const node of backdrop.node.children) if (node.name.startsWith("Ship") && node.transform) out.push({ node, hidden: false, sunk: false });
  }
  return out;
}

/**
 * Measures each ship's speed from how it moves, and draws its bow wave and stern wake on the waves
 * as strongly as it is fast: none at rest, none while this client can't see it.
 */
defineSystem({
  name: "pirates.ShipWakes",
  phase: "lateUpdate",
  worlds: ["client", "local"],
  after: ["pirates.ShipVisuals"],
  run(_rows, ctx) {
    let map = hulls.get(ctx.world);
    if (!map) hulls.set(ctx.world, (map = new Map()));
    const dt = ctx.dt;
    const time = ctx.world.time.time;
    const seen = new Set<GameObject>();
    const water = !!Water.surface;
    for (const ship of sailing()) {
      seen.add(ship.node);
      let hull = map.get(ship.node);
      if (!hull || !hull.root.isValid) map.set(ship.node, (hull = buildHull(ship.node)));
      const t = ship.node.transform!;
      const p = t.worldPosition;
      const moved = Math.hypot(p.x - hull.x, p.z - hull.z);
      if (moved > JUMP) {
        hull.path.clear();
        hull.speed = 0;
        hull.strength = 0;
      } else if (dt > 0) {
        hull.speed += (moved / dt - hull.speed) * (1 - Math.exp(-SPEED_FOLLOW * dt));
      }
      hull.x = p.x;
      hull.z = p.z;
      const target = ship.hidden || ship.sunk || !water ? 0 : wakeStrength(hull.speed, SHIP_SPEED);
      // Hiding in fog cuts the marks at once; otherwise they ease, as the measured speed does.
      hull.strength = ship.hidden ? 0 : hull.strength + (target - hull.strength) * (1 - Math.exp(-SPEED_FOLLOW * dt));
      const strong = hull.strength > 0.01;

      // The stern wake: the stern's path (newest first) behind where the stern is now.
      const local = t.localToWorld;
      const stern = local.transformPoint({ x: 0, y: 0, z: -HULL_HALF_LENGTH + 0.3 });
      hull.path.step(stern.x, stern.z, dt, strong && !ship.hidden);
      if (strong && hull.path.points.length) {
        const pts: [number, number, number][] = [[stern.x, seaHeight(stern.x, stern.z), stern.z]];
        for (const q of hull.path.points) pts.push([q.x, seaHeight(q.x, q.z), q.z]);
        hull.wake.setPositions(pts);
        hull.wake.width = WAKE_WIDTH * (0.5 + 0.5 * hull.strength);
        hull.wake.color = new Color(1, 1, 1, WAKE_ALPHA * hull.strength);
        hull.wake.enabled = true;
      } else hull.wake.enabled = false;

      // The bow wave: a V from the stem, its arms longer the faster the ship goes.
      if (strong) {
        const v = bowWave({ stem: HULL_HALF_LENGTH + 0.15, length: 0.8 + Math.min(4, hull.speed * 0.3), spread: 32, perArm: 4 }, time);
        hull.bow.setPositions(
          v.map((q) => {
            const w = local.transformPoint({ x: q.x, y: 0, z: q.z });
            return [w.x, seaHeight(w.x, w.z), w.z] as [number, number, number];
          }),
        );
        hull.bow.width = BOW_WIDTH * (0.6 + 0.4 * hull.strength);
        hull.bow.color = new Color(1, 1, 1, BOW_ALPHA * hull.strength);
        hull.bow.enabled = true;
      } else hull.bow.enabled = false;
    }
    // Ships that have gone take their marks with them.
    for (const [node, hull] of map) {
      if (seen.has(node)) continue;
      if (hull.root.isValid) GameObject.destroy(hull.root);
      map.delete(node);
    }
  },
});
