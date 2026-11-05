import { Color, GameBehavior, UIPanel, UIText, behavior } from "myco";
import { Battery, Phase, RELOAD, RESULTS_SECONDS, SHIP_HP, TEAM_COLORS, flag, game, myShip, ranking, ships, type ShipInfo } from "../data";

/** A ship's name on the scoreboard. */
export function captain(s: ShipInfo, names?: ReadonlyMap<number, string>): string {
  return names?.get(s.data.team) ?? (s.rep.isOwnedLocally ? "You" : s.data.bot ? `Bot ${s.data.team + 1}` : `Captain ${s.data.team + 1}`);
}

/** Names by team, from the lobby when there is one (lobby.ts sets it). */
let captainNames: (() => ReadonlyMap<number, string>) | null = null;
export function setCaptainNames(names: (() => ReadonlyMap<number, string>) | null): void {
  captainNames = names;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The heads-up display: the clock and the scoreboard (score, enemy ships sunk, who holds the
 * flag), the hull's health, the batteries and their reloads, power-ups in effect, a line in the
 * middle while sunk, and the results when the match ends. It reads this client's ship and the
 * replicated match; the nodes it fills are found by path under the canvas.
 */
@behavior("pirates.Hud", { worlds: ["client"] })
export class Hud extends GameBehavior {
  update(): void {
    const ship = myShip();
    const g = game();
    const names = captainNames?.();
    const hp = ship ? Math.max(0, ship.data.hp) : SHIP_HP;
    const fill = this.node.find("Screen/Bottom/Hull/Bar/Fill")?.getBehavior(UIPanel);
    if (fill) {
      const width = `${Math.round((hp / SHIP_HP) * 100)}%`;
      if (fill.width !== width) fill.width = width;
      setColor(fill, "backgroundColor", hp > 50 ? "#59cc4d" : hp > 25 ? "#e6a63d" : "#e6403d");
    }
    this.text("Screen/Bottom/Hull/Label", `Hull ${Math.ceil(hp)}`);
    const swatch = this.node.find("Screen/Bottom/Hull/Swatch")?.getBehavior(UIPanel);
    if (swatch && ship) setColor(swatch, "backgroundColor", TEAM_COLORS[ship.data.team]);

    const battery = ship?.data.battery ?? Battery.starboard;
    this.battery("Screen/Bottom/Port", "[A] Port", battery === Battery.port, ship?.data.reloadPort ?? 0);
    this.battery("Screen/Bottom/Starboard", "Starboard [D]", battery === Battery.starboard, ship?.data.reloadStarboard ?? 0);

    const powers: string[] = [];
    if (ship && ship.data.wind > 0) powers.push(`Wind in your sails ${Math.ceil(ship.data.wind)}s`);
    if (ship && ship.data.ghost > 0) powers.push(`Ghost ship ${Math.ceil(ship.data.ghost)}s${ship.data.cloud ? "  -  F: drop a fog cloud" : ""}`);
    if (g && g.storm > 0) powers.push(g.stormTeam === ship?.data.team ? `Your storm ${Math.ceil(g.storm)}s` : `Stormy seas ${Math.ceil(g.storm)}s - beware lightning!`);
    this.text("Screen/Bottom/Help/Powers", powers.join("   |   "));

    const holder = flag()?.data.carrier ?? -1;
    const order = ranking(ships());
    this.text(
      "Screen/Top/Fleet",
      order.map((s) => `${s.data.team === holder ? "[FLAG] " : ""}${captain(s, names)} ${Math.floor(s.data.score)}`).join("     "),
    );
    this.text("Screen/Top/Clock", g ? clock(g.phase === Phase.playing ? g.timeLeft : 0) : "");

    let status = "";
    let lines: string[] = [];
    let next = "";
    if (!ship) status = "Raising the sails...";
    else if (g?.phase === Phase.over) {
      const winner = order.find((s) => s.data.team === g.winner);
      status = winner?.rep.isOwnedLocally ? "You are the King of Pirates!" : `${winner ? captain(winner, names) : "Nobody"} is the King of Pirates`;
      lines = order.map((s, i) => `${i + 1}.  ${captain(s, names)}   ${Math.floor(s.data.score)} pts   ${s.data.kills} sunk`);
      const left = Math.max(0, Math.ceil(RESULTS_SECONDS - g.results));
      next = this.resultsNote ?? (left > 0 ? `Next match in ${left}` : "");
    } else if (ship.data.sunk > 0) status = `Sunk! Back in ${Math.ceil(ship.data.sunk)}`;
    this.text("Screen/MiddleRow/Middle/Status", status);
    for (let i = 0; i < 8; i++) this.text(`Screen/MiddleRow/Middle/Line${i}`, lines[i] ?? "");
    this.text("Screen/MiddleRow/Middle/Next", next);
    const panel = this.node.find("Screen/MiddleRow/Middle")?.getBehavior(UIPanel);
    if (panel) setColor(panel, "backgroundColor", "#0d1219", lines.length ? 0.85 : 0);
  }

  /** Replaces "Next match in…" under the results (a lobby's match says where players go next). */
  resultsNote: string | null = null;

  private battery(path: string, label: string, chosen: boolean, reload: number): void {
    const panel = this.node.find(path)?.getBehavior(UIPanel);
    if (panel) {
      setColor(panel, "borderColor", chosen ? "#ffd966" : "#667080");
      if (panel.opacity !== (chosen ? 1 : 0.6)) panel.opacity = chosen ? 1 : 0.6;
    }
    this.text(`${path}/Label`, reload > 0 ? `${label}  ${reload.toFixed(1)}s` : `${label}  ready`);
    const fill = this.node.find(`${path}/Reload`)?.getBehavior(UIPanel);
    const width = `${Math.round((1 - reload / RELOAD) * 100)}%`;
    if (fill && fill.width !== width) fill.width = width;
  }

  private text(path: string, value: string): void {
    const t = this.node.find(path)?.getBehavior(UIText);
    if (t && t.text !== value) t.text = value;
  }
}

/** Sets a colour field only when it differs, as a new value (UI fields are compared, not watched). */
function setColor(panel: UIPanel, field: "backgroundColor" | "borderColor", hex: string, alpha = 1): void {
  const current = panel[field];
  if (current && current.toHex().toLowerCase() === hex.slice(0, 7).toLowerCase() && Math.abs(current.a - alpha) < 0.01) return;
  const c = Color.from(hex.slice(0, 7));
  c.a = alpha;
  panel[field] = c;
}
