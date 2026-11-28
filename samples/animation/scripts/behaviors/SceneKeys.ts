import { GameBehavior, Input, SceneManager, behavior, field } from "myco";

/** Key 1 goes back to the main scene (the sprites page's HUD carries it). */
@behavior("demo.SceneKeys")
export class SceneKeys extends GameBehavior {
  @field(String) back = "scenes/main.scene.json";

  update(): void {
    if (Input.getKeyDown("1")) void SceneManager.load(this.back);
  }
}
