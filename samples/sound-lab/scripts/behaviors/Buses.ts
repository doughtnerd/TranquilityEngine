import { Audio, GameBehavior, Input, behavior, field } from "myco";
import { exposeKeyScopes, keysClaimed } from "../keyScope";

/**
 * Key 2: toggle the Music bus's mute. Key 3 fades its volume down and back up. Buses are the project's mixer groups.
 * A second node with `bus: "Ambience"` (keys N and Z) does the same for the Ambience bus, whose reverb send the M5-0
 * listening section mutes (`docs/design/0171-audio-mix/listening-notes/m5-0.md`).
 */
@behavior("lab.Buses")
export class Buses extends GameBehavior {
  @field(String) bus = "Music";
  @field(String) muteKey = "2";
  @field(String) fadeKey = "3";
  private faded = false;

  update(): void {
    if (keysClaimed()) return;
    const bus = Audio.bus(this.bus);
    if (Input.getKeyDown(this.muteKey)) bus.mute = !bus.mute;
    if (Input.getKeyDown(this.fadeKey)) {
      this.faded = !this.faded;
      // `fadeTo` sets the multiplier on the bus's authored volume (Music 0.6: 0.25 x 0.6 = 0.15 heard, 1 x 0.6 = 0.6).
      bus.fadeTo(this.faded ? 0.25 : 1, 0.5);
    }
  }
}
