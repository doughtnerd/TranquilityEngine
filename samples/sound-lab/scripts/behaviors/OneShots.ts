import { Audio, GameBehavior, Input, behavior, field } from "myco";
import { exposeKeyScopes, keysClaimed } from "../keyScope";

/** Key 1: fire-and-forget sounds. `playOneShot` starts a clip and returns a handle you can stop or fade. */
@behavior("lab.OneShots")
export class OneShots extends GameBehavior {
  @field(String) key = "1";
  /** The last sound started, kept to show the handle's API. */
  last: ReturnType<typeof Audio.playOneShot> | null = null;

  start(): void {
    exposeKeyScopes();
  }

  update(): void {
    if (keysClaimed() || !Input.getKeyDown(this.key)) return;
    // A UI click on its own bus, then a pitched beep a little quieter.
    Audio.playOneShot("audio/click.wav", { bus: "UI" });
    this.last = Audio.playOneShot("audio/beep.wav", { bus: "UI", volume: 0.5, pitch: 1.25 });
  }
}
