// The marks rain and ships leave on the sea, drawn where the game is drawn (client Worlds, and the
// menu's own World for its backdrop ships), never on the server: they're only for the eye.
// - Rain: faint rings spread where drops land, as many as the rain is heavy (the `Rain` particle
//   system's emission, which weather.ts eases with the storm), none in calm weather.
// - Ships: a bow wave (a V of churned water from the stem) and a stern wake (a widening band along
//   the path the stern took), both as strong as the ship is fast and gone when it stops.
// Every mark lies on the waves: each frame its points take the sea's height (`Water.sample`). The
// shapes and the speed-to-strength curve are in seaMarkShapes.ts.
import { Color, GameObject, LineRenderer, ParticleSystem, Quaternion, Replicated, Water, defineSystem, type Curve, type Gradient } from "myco";
import { HULL_HALF_LENGTH, SHIP_SPEED, cloudSpots, inCloudAmong, myShip, ships } from "./data";
import { MenuBackdrop } from "./behaviors/MenuBackdrop";
import { WakePath, bowWave, rippleAt, wakeStrength, type RippleLook } from "./seaMarkShapes";

const RIPPLE_TEXTURE = "asset:textures/ripple.png";
const WAKE_TEXTURE = "asset:textures/wake.png";

/** How far above the sampled surface marks float, so the waves don't swallow them. */
const LIFT = 0.06;
/** A flat mark faces +Z: this turns a node's +Z to world up. */
const FACE_UP = Quaternion.lookRotation([0, 1, 0], [0, 0, 1]);

// --- rain ripples ------------------------------------------------------------------------------------

/** Ripples at most at once (the pool). */
const RIPPLE_POOL = 48;
/** Ripples a second in full rain (they live `RIPPLE_LIFE`, so about 40 show at once). */
const RIPPLE_RATE = 70;
const RIPPLE_LIFE = 0.6;
const RIPPLE_RADIUS = 0.55;
const RIPPLE_ALPHA = 0.35;
/** Metres around the rain's middle (the point the camera looks at) where ripples show. */
const RIPPLE_SPREAD = 22;

interface Ripple {
  node: GameObject;
  line: LineRenderer;
  x: number;
  z: number;
  age: number;
  alive: boolean;
}
interface Rain {
  root: GameObject;
  ripples: Ripple[];
  /** Ripples owed, carried between frames. */
  due: number;
  /** Seed of this World's ripple placement. */
  seed: number;
}
const rains = new WeakMap<object, Rain>();

function buildRain(): Rain {
  const root = GameObject.create("Rain Ripples");
  const ripples: Ripple[] = [];
  for (let i = 0; i < RIPPLE_POOL; i++) {
    const node = GameObject.create(`Ripple ${i + 1}`, { parent: root });
    const line = node.addComponent(LineRenderer, { texture: RIPPLE_TEXTURE, alignment: "transformZ", textureMode: "stretch", castShadows: false, receiveShadows: false });
    node.setActive(false);
    ripples.push({ node, line, x: 0, z: 0, age: 0, alive: false });
  }
  return { root, ripples, due: 0, seed: 1 };
}

/** A cheap repeatable random number in [0, 1) (each World's ripples follow their own sequence). */
function next(rain: Rain): number {
  rain.seed = (Math.imul(rain.seed, 1664525) + 1013904223) >>> 0;
  return rain.seed / 4294967296;
}

const look: RippleLook = { radius: 0, alpha: 0 };

/**
 * Lays one quad per ripple on the waves, facing along the surface's normal: two points across it,
 * as wide as it is long, showing the ring texture at the ripple's size and fade.
 */
function drawRipple(r: Ripple): void {
  rippleAt(r.age / RIPPLE_LIFE, RIPPLE_RADIUS, RIPPLE_ALPHA, look);
  const sea = Water.sample(r.x, r.z);
  const y = (sea?.height ?? 0) + LIFT * 0.5;
  const n = sea?.normal ?? { x: 0, y: 1, z: 0 };
  // A direction along the surface: world Z crossed with the normal (never parallel: the sea faces up).
  const tl = Math.hypot(n.y, n.x) || 1;
  const tx = -n.y / tl, ty = n.x / tl;
  const s = look.radius;
  r.node.transform!.rotation = Quaternion.lookRotation([n.x, n.y, n.z], [0, 0, 1]);
  r.line.width = s * 2;
  r.line.setPositions([
    [r.x - tx * s, y - ty * s, r.z],
    [r.x + tx * s, y + ty * s, r.z],
  ]);
  r.line.color = new Color(1, 1, 1, look.alpha);
}

/** Spreads ripples under the rain, as many as it is heavy, and grows and fades them on the waves. */
defineSystem({
  name: "pirates.RainRipples",
  phase: "lateUpdate",
  worlds: ["client", "local"],
  after: ["pirates.Weather"],
  run(_rows, ctx) {
    const source = GameObject.findObjectsOfType(ParticleSystem).find((p) => p.node.name === "Rain");
    let rain = rains.get(ctx.world);
    if (!source || !Water.surface) {
      if (rain?.root.isValid) for (const r of rain.ripples) if (r.alive) (r.alive = false), r.node.setActive(false);
      return;
    }
    if (!rain || !rain.root.isValid) {
      rain = buildRain();
      rains.set(ctx.world, rain);
    }
    const heavy = Math.max(0, Math.min(1, source.emissionScale));
    const at = source.node.transform!.position;
    rain.due = heavy > 0.01 ? rain.due + RIPPLE_RATE * heavy * ctx.dt : 0;
    for (const r of rain.ripples) {
      if (r.alive) {
        r.age += ctx.dt;
        if (r.age >= RIPPLE_LIFE) {
          r.alive = false;
          r.node.setActive(false);
        }
      }
      if (!r.alive && rain.due >= 1) {
        rain.due -= 1;
        // Even over the disc: the radius goes as the square root of a uniform number.
        const d = Math.sqrt(next(rain)) * RIPPLE_SPREAD, a = next(rain) * Math.PI * 2;
        r.x = at.x + Math.cos(a) * d;
        r.z = at.z + Math.sin(a) * d;
        r.age = next(rain) * ctx.dt; // drops land through the frame, not all at its start
        r.alive = true;
        r.node.setActive(true);
      }
      if (r.alive) drawRipple(r);
    }
    rain.due = Math.min(rain.due, 1); // a full pool drops the rest rather than queueing them
  },
});

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
