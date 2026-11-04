import { Engine, GameBehavior, GameObject, Input, Text, behavior, field } from "myco";
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
  /** A Text node for the controls line. */
  @field(GameObject) help: GameObject | null = null;

  update(): void {
    const hosting = Engine.findWorld(SERVER_WORLD) !== null;
    const second = Engine.findWorld(SECOND_CLIENT_WORLD);
    if (hosting && !second && Input.getKeyDown("p")) this.addLocalPlayer();

    const connection = connectionStates.get(this.world) ?? "none";
    if (connection === "lost") {
      this.setText(this.node, "Not connected to a server");
      this.setText(this.help, "Escape: back to the menu");
      if (Input.getKeyDown("escape")) this.leave();
      return;
    }

    const all = players();
    const scores = all.map((p) => `${p.rep.isOwnedLocally ? "▶ " : ""}P${p.rep.ownerId}  ${p.data.score}`);
    this.setText(this.node, all.length > 0 ? scores.join("        ") : "Connecting…");

    const tips = ["WASD or arrows: move", "Space: fire"];
    if (hosting && !second) tips.push("P: add a local player");
    if (second) tips.push("click a view to control it");
    this.setText(this.help, tips.join("   ·   "));
  }

  /** A second client World in this page, playing against the same server (the bootstrap's link connects it). */
  private addLocalPlayer(): void {
    Engine.createWorld(SECOND_CLIENT_WORLD);
  }

  /** Back to the menu (a second local player's World just goes). */
  private leave(): void {
    const me = Engine.findWorld(this.world.name)!;
    if (me.name === SECOND_CLIENT_WORLD) me.destroy();
    else void me.loadScene("scenes/main.scene.json");
  }

  private setText(node: GameObject | null, value: string): void {
    const text = node?.getBehavior(Text);
    if (text && text.text !== value) text.text = value;
  }
}
