import { Engine, GameBehavior, GameObject, Input, Text, behavior, field } from "tranquility";
import { ARENA_SCENE, DEDICATED_SERVER_URL, SERVER_WORLD } from "../data";

/**
 * The frontend (Unity Netcode for Entities' pattern): the game starts with one client World
 * showing this menu, and the server World is created only when the player picks Host, from the
 * `Server` template in project.json's bootstrap.
 *
 * - Host (H): create the `Server` World, connect this World to it over loopback, load the arena.
 * - Join (J): connect to a dedicated server (`npm run server -- samples/arena`) over WebSocket.
 *   The engine can't connect a World to a server address yet (`WorldHandle.connect` takes a
 *   World in the same page), so for now this explains that instead.
 */
@behavior("arena.Menu", { worlds: ["client"] })
export class Menu extends GameBehavior {
  /** A Text node for messages. */
  @field(GameObject) status: GameObject | null = null;

  private busy = false;

  update(): void {
    if (this.busy) return;
    if (Input.getKeyDown("h") || Input.getKeyDown("1")) this.host();
    else if (Input.getKeyDown("j") || Input.getKeyDown("2")) this.join();
  }

  /** Host: a server World in this page, this World its first client. */
  host(): void {
    this.busy = true;
    this.say("Starting the server…");
    const me = Engine.findWorld(this.world.name)!;
    const server = Engine.findWorld(SERVER_WORLD) ?? Engine.createWorld(SERVER_WORLD);
    me.connect(server, "loopback");
    // Players spawn under the arena's Actors node, so they show up once this scene is in.
    me.loadScene(ARENA_SCENE).catch((err: Error) => {
      this.busy = false;
      this.say(`Couldn't load the arena: ${err.message}`);
    });
  }

  /** Join: a dedicated server at `DEDICATED_SERVER_URL`. */
  join(): void {
    // With an engine API to connect by address this becomes:
    //   me.connect(DEDICATED_SERVER_URL, "websocket"); me.loadScene(ARENA_SCENE);
    this.say(`Joining ${DEDICATED_SERVER_URL} needs an engine API that isn't there yet:\na World can only connect to another World in this page. Host instead (H).`);
  }

  private say(message: string): void {
    const text = this.status?.getBehavior(Text);
    if (text) text.text = message;
  }
}
