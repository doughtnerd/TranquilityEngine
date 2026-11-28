// The marks ships leave on the sea, drawn where the game is drawn (client Worlds, and the menu's own
// World for its backdrop ships), never on the server: they're only for the eye. (Rain rings the water
// in its own effect, effects/rain.particles.json: drops die where they meet the scene's depth, and
// some deaths spawn a flat ring there.)
// - Wakes are the water's own (ADR 0451): each ship carries a WaterWake, and the sea's shader draws
//   its bow wave and stern wake as strongly as the ship is fast. This script only hides a ship's
//   wake while this client can't see the ship (inside someone else's fog cloud) or it has sunk.
// - Bow spray: two particle emitters at the stem (effects/bowspray.particles.json) throw water up and
//   out along each side of the bow, as hard as the ship is fast, in either wake mode.
// - V switches how the sea draws wakes, to compare them: a foam trail with Kelvin ripples along each
//   stern's path ("trail"), or a simulated wave height field the hulls press into ("field").
import { GameObject, Input, ParticleSystem, Quaternion, Replicated, Water, WaterWake, defineSystem, type WaterWakeMode } from "myco";
import { HULL_HALF_LENGTH, SHIP_SPEED, cloudSpots, inCloudAmong, myShip, ships } from "./data";
import { MenuBackdrop } from "./behaviors/MenuBackdrop";

/** The wake every ship carries: its stem and stern, full size at full sail. */
const WAKE = {
  bow: HULL_HALF_LENGTH + 0.15,
  stern: -HULL_HALF_LENGTH + 0.3,
  fullSpeed: SHIP_SPEED,
  width: 3.2,
  life: 2.6,
  foam: 0.6,
  ripples: 0.6,
};

/** The bow spray: where it leaves the hull (just aft of the stem, either side), and which way it flies (out, up and a little aft). */
const SPRAY_EFFECT = "asset:effects/bowspray.particles.json";
const SPRAY_AT = { side: 0.4, up: 0.2, along: HULL_HALF_LENGTH - 0.35 };
const SPRAY_DIRECTION = { out: 0.75, up: 0.6, back: 0.3 };
/** The speed (m/s) where the spray starts; it is full at SHIP_SPEED. */
const SPRAY_FROM = 2;
/** How quickly the measured speed follows the ship (per second); a jump further than this (a respawn) resets it. */
const SPEED_FOLLOW = 6;
const JUMP = 8;

interface Bow {
  x: number;
  z: number;
  speed: number;
  sprays: ParticleSystem[];
}
const bows = new WeakMap<object, Map<GameObject, Bow>>();

/** The two spray emitters under a ship: each emits along its +Y, turned out to its side, up and aft. */
function buildBow(node: GameObject): Bow {
  const p = node.transform!.worldPosition;
  const sprays = [-1, 1].map((side) => {
    const emitter = GameObject.create(side < 0 ? "Bow Spray (port)" : "Bow Spray (starboard)", { parent: node });
    emitter.transform!.position.set(side * SPRAY_AT.side, SPRAY_AT.up, SPRAY_AT.along);
    emitter.transform!.rotation = Quaternion.lookRotation([0, 0, 1], [side * SPRAY_DIRECTION.out, SPRAY_DIRECTION.up, -SPRAY_DIRECTION.back]);
    return emitter.addComponent(ParticleSystem, { effect: SPRAY_EFFECT, emissionScale: 0 });
  });
  return { x: p.x, z: p.z, speed: 0, sprays };
}

/** The wake mode picked with V (kept across scenes), or null to leave each scene's own. */
let picked: WaterWakeMode | null = null;

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
 * Gives every ship its wake and bow spray, hidden while this client can't see the ship or it has sunk;
 * V switches the sea's wake mode.
 */
defineSystem({
  name: "pirates.ShipWakes",
  phase: "lateUpdate",
  worlds: ["client", "local"],
  after: ["pirates.ShipVisuals"],
  run(_rows, ctx) {
    let map = bows.get(ctx.world);
    if (!map) bows.set(ctx.world, (map = new Map()));
    const dt = ctx.dt;
    const seen = new Set<GameObject>();
    const surface = Water.surface;
    if (surface && Input.getKeyDown("v")) {
      picked = surface.wakeMode === "field" ? "trail" : "field";
      console.info(`[pirates] wakes: ${picked}`);
    }
    if (surface && picked && surface.wakeMode !== picked) surface.wakeMode = picked;
    for (const ship of sailing()) {
      const wake = ship.node.getComponent(WaterWake) ?? ship.node.addComponent(WaterWake, WAKE);
      wake.strength = ship.hidden || ship.sunk ? 0 : 1;

      // The spray, as hard as the ship is fast (its speed measured from how it moves).
      seen.add(ship.node);
      let bow = map.get(ship.node);
      if (!bow || !bow.sprays[0]!.node.isValid) map.set(ship.node, (bow = buildBow(ship.node)));
      const p = ship.node.transform!.worldPosition;
      const moved = Math.hypot(p.x - bow.x, p.z - bow.z);
      if (moved > JUMP) bow.speed = 0;
      else if (dt > 0) bow.speed += (moved / dt - bow.speed) * (1 - Math.exp(-SPEED_FOLLOW * dt));
      bow.x = p.x;
      bow.z = p.z;
      const t = Math.min(1, Math.max(0, (bow.speed - SPRAY_FROM) / (SHIP_SPEED - SPRAY_FROM)));
      const spray = ship.hidden || ship.sunk || !surface ? 0 : t * t;
      for (const ps of bow.sprays) ps.emissionScale = spray;
    }
    // Ships that have gone take their spray with them (it's under the ship's node); forget them.
    for (const node of [...map.keys()]) if (!seen.has(node)) map.delete(node);
  },
});
