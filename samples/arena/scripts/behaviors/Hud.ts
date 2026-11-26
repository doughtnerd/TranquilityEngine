import { Engine, GameBehavior, Input, UIView, behavior } from "myco";
import { SECOND_CLIENT_WORLD, SERVER_WORLD, connectionStates, players } from "../data";

/**
 * The arena's heads-up display in client Worlds: the replicated scores (the server keeps them),
 * the controls, and, for a host, P to add a second local player: another client World, made from
 * the `Client 2` Spawnable World, which the bootstrap's link connects to the same server over
 * loopback (ADR 0062). The editor's game view
 * tiles the two; clicking a tile gives that player the keyboard. If the connection is lost (or a
 * Join never reached a server), Escape goes back to the menu.
 */
@behavior("arena.Hud", { worlds: ["client"] })
export class Hud extends GameBehavior {
  update(): void {
    const data = this.node.getBehavior(UIView)?.props;
    if (!data) return;
    const hosting = Engine.findWorld(SERVER_WORLD) !== null;
    const second = Engine.findWorld(SECOND_CLIENT_WORLD);
    if (hosting && !second && Input.getKeyDown("p")) this.addLocalPlayer();

    const connection = connectionStates.get(this.time) ?? "none";
    if (connection === "lost") {
      data.scores = "Not connected to a server";
      data.help = "Escape: back to the menu";
      if (Input.getKeyDown("escape")) this.leave();
      return;
    }

    const all = players();
    const scores = all.map((p) => `${p.rep.isOwnedLocally ? "▶ " : ""}P${p.rep.ownerId}  ${p.data.score}`);
    data.scores = all.length > 0 ? scores.join("        ") : "Connecting…";

    const tips = ["WASD or arrows: move", "Space: fire"];
    if (hosting && !second) tips.push("P: add a local player");
    if (second) tips.push("click a view to control it");
    data.help = tips.join("   ·   ");
  }

  /** A second client World in this page, playing against the same server (the bootstrap's link connects it). */
  private addLocalPlayer(): void {
    Engine.createWorld(SECOND_CLIENT_WORLD);
  }

  /** Back to the menu (a second local player's World just goes). */
  private leave(): void {
    const me = this.world;
    if (me.name === SECOND_CLIENT_WORLD) me.destroy();
    else void me.loadScene("scenes/main.scene.json");
  }
}
