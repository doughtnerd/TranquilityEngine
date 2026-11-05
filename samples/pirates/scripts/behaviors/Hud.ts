import { Color, GameBehavior, UIPanel, UIText, behavior } from "myco";
import { Battery, RELOAD, SHIP_HP, TEAM_COLORS, myShip, ships } from "../data";

/**
 * The heads-up display: the hull's health, which battery is chosen and whether each is loaded,
 * the fleet's sinkings, and a line in the middle when the ship is sunk. It reads this client's
 * ship; the nodes it fills are found by path under the canvas.
 */
@behavior("pirates.Hud", { worlds: ["client"] })
export class Hud extends GameBehavior {
  update(): void {
    const ship = myShip();
    const hp = ship ? Math.max(0, ship.data.hp) : SHIP_HP;
    const fill = this.node.find("Screen/Bottom/Hull/Bar/Fill")?.getBehavior(UIPanel);
    if (fill) {
      fill.width = `${Math.round((hp / SHIP_HP) * 100)}%`;
      setColor(fill, "backgroundColor", hp > 50 ? "#59cc4d" : hp > 25 ? "#e6a63d" : "#e6403d");
    }
    this.text("Screen/Bottom/Hull/Label", `Hull ${Math.ceil(hp)}`);

    const battery = ship?.data.battery ?? Battery.starboard;
    this.battery("Screen/Bottom/Port", "[A] Port", battery === Battery.port, ship?.data.reloadPort ?? 0);
    this.battery("Screen/Bottom/Starboard", "Starboard [D]", battery === Battery.starboard, ship?.data.reloadStarboard ?? 0);

    const fleet = ships().sort((a, b) => a.data.team - b.data.team);
    this.text("Screen/Top/Fleet", fleet.map((s) => `${s.data.bot ? "Bot" : "You"} ${s.data.team + 1}: sunk ${s.data.sinks}`).join("     "));

    const sunk = ship && ship.data.sunk > 0 ? `Sunk! Back in ${Math.ceil(ship.data.sunk)}` : ship ? "" : "Raising the sails...";
    this.text("Screen/Middle/Status", sunk);
    const colour = this.node.find("Screen/Bottom/Hull/Swatch")?.getBehavior(UIPanel);
    if (colour && ship) setColor(colour, "backgroundColor", TEAM_COLORS[ship.data.team]);
  }

  private battery(path: string, label: string, chosen: boolean, reload: number): void {
    const panel = this.node.find(path)?.getBehavior(UIPanel);
    if (panel) {
      setColor(panel, "borderColor", chosen ? "#ffd966" : "#667080");
      if (panel.opacity !== (chosen ? 1 : 0.6)) panel.opacity = chosen ? 1 : 0.6;
    }
    this.text(`${path}/Label`, reload > 0 ? `${label}  ${reload.toFixed(1)}s` : `${label}  ready`);
    const fill = this.node.find(`${path}/Reload`)?.getBehavior(UIPanel);
    if (fill) fill.width = `${Math.round((1 - reload / RELOAD) * 100)}%`;
  }

  private text(path: string, value: string): void {
    const t = this.node.find(path)?.getBehavior(UIText);
    if (t && t.text !== value) t.text = value;
  }
}

/** Sets a colour field only when it differs, as a new value (UI fields are compared, not watched). */
function setColor(panel: UIPanel, field: "backgroundColor" | "borderColor", hex: string): void {
  const current = panel[field];
  if (current && current.toHex().toLowerCase() === hex.toLowerCase()) return;
  panel[field] = Color.from(hex);
}
