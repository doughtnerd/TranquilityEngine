import { GameBehavior, Input, SceneManager, behavior, field } from "myco";

/** A key loads another scene (the Sound Lab's pages: the audio core's tour and the events page). */
@behavior("lab.SceneSwitch")
export class SceneSwitch extends GameBehavior {
  @field(String) key = "e";
  @field(String) scene = "scenes/events.scene.json";
  private loading = false;

  update(): void {
    if (this.loading || !Input.getKeyDown(this.key)) return;
    this.loading = true;
    SceneManager.load(this.scene).catch((err: Error) => {
      this.loading = false;
      console.error(`[sound-lab] Couldn't load ${this.scene}: ${err.message}`);
    });
  }
}
