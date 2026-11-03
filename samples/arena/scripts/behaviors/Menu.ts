import { Engine, GameBehavior, GameObject, Input, Text, behavior, field, type WorldHandle } from "myco";
import { ARENA_SCENE, DEDICATED_SERVER_URL, SERVER_WORLD } from "../data";

/**
 * The frontend (Unity Netcode for Entities' pattern): the game starts with one client World
 * showing this menu, and a server World exists only once the player picks Host, made from the
 * `Server` template in project.json's bootstrap.
 *
 * - Host (H or 1): create the `Server` World, connect this World to it over loopback, load the arena.
 * - Join (J or 2): connect this World to a dedicated server (`npm run server -- samples/arena`)
 *   over WebSocket at `serverUrl`, and load the arena.
 */
@behavior("arena.Menu", { worlds: ["client"] })
export class Menu extends GameBehavior {
  /** A Text node for messages. */
  @field(GameObject) status: GameObject | null = null;
  /** The Join item's Text node, which shows `serverUrl`. */
  @field(GameObject) joinLabel: GameObject | null = null;
  /** Where Join connects: a dedicated server's address. */
  @field(String) serverUrl = DEDICATED_SERVER_URL;

  private busy = false;

  update(): void {
    const join = this.joinLabel?.getBehavior(Text);
    if (join && join.text !== `[J]  Join ${this.serverUrl}`) join.text = `[J]  Join ${this.serverUrl}`;
    if (this.busy) return;
    if (Input.getKeyDown("h") || Input.getKeyDown("1")) this.begin("Starting the server…", (me) => me.connect(Engine.findWorld(SERVER_WORLD) ?? Engine.createWorld(SERVER_WORLD), "loopback"));
    else if (Input.getKeyDown("j") || Input.getKeyDown("2")) this.begin(`Joining ${this.serverUrl}…`, (me) => me.connect(this.serverUrl, "websocket"));
  }

  /** Connect this World with `connect`, then load the arena; players appear under its Actors node once it's in. */
  private begin(message: string, connect: (me: WorldHandle) => void): void {
    this.busy = true;
    this.say(message);
    const me = Engine.findWorld(this.world.name)!;
    try {
      connect(me);
    } catch (err) {
      this.busy = false;
      this.say(`Couldn't connect: ${(err as Error).message}`);
      return;
    }
    me.loadScene(ARENA_SCENE).catch((err: Error) => {
      this.busy = false;
      this.say(`Couldn't load the arena: ${err.message}`);
    });
  }

  private say(message: string): void {
    const text = this.status?.getBehavior(Text);
    if (text) text.text = message;
  }
}
