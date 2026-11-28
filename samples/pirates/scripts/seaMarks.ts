// The marks ships leave on the sea, drawn where the game is drawn (client Worlds, and the menu's own
// World for its backdrop ships), never on the server: they're only for the eye. (Rain rings the water
// in its own effect, effects/rain.particles.json: drops die where they meet the scene's depth, and
// some deaths spawn a flat ring there.)
// - Wakes are the water's own (ADR 0445): each ship carries a WaterWake, and the sea's shader draws
//   its bow wave and stern wake as strongly as the ship is fast. This script only hides a ship's
//   wake while this client can't see the ship (inside someone else's fog cloud) or it has sunk.
// - V switches how the sea draws wakes, to compare them: a foam trail with Kelvin ripples along each
//   stern's path ("trail"), or a simulated wave height field the hulls press into ("field").
import { GameObject, Input, Replicated, Water, WaterWake, defineSystem, type WaterWakeMode } from "myco";
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

/** Gives every ship its wake, hidden while this client can't see the ship or it has sunk; V switches the sea's wake mode. */
defineSystem({
  name: "pirates.ShipWakes",
  phase: "lateUpdate",
  worlds: ["client", "local"],
  after: ["pirates.ShipVisuals"],
  run() {
    const surface = Water.surface;
    if (surface && Input.getKeyDown("v")) {
      picked = surface.wakeMode === "field" ? "trail" : "field";
      console.info(`[pirates] wakes: ${picked}`);
    }
    if (surface && picked && surface.wakeMode !== picked) surface.wakeMode = picked;
    for (const ship of sailing()) {
      const wake = ship.node.getComponent(WaterWake) ?? ship.node.addComponent(WaterWake, WAKE);
      wake.strength = ship.hidden || ship.sunk ? 0 : 1;
    }
  },
});
