import { Audio, GameBehavior, Input, behavior, field } from "myco";
import { exposeKeyScopes, keysClaimed } from "../keyScope";

/** Key 2: toggle the Music bus's mute. Key 3 fades its volume down and back up. Buses are the project's mixer groups. */
@behavior("lab.Buses")
export class Buses extends GameBehavior {
  @field(String) muteKey = "2";
  @field(String) fadeKey = "3";
  private faded = false;

  update(): void {
    if (keysClaimed()) return;
    const music = Audio.bus("Music");
    if (Input.getKeyDown(this.muteKey)) music.mute = !music.mute;
    if (Input.getKeyDown(this.fadeKey)) {
      this.faded = !this.faded;
      music.fadeTo(this.faded ? 0.15 : 0.6, 0.5);
    }
  }
}
