import { Audio, GameBehavior, Input, behavior, field } from "myco";

/** Key 4: switch the project's "Underwater" snapshot (muffled, quieter music) on and off. */
@behavior("lab.Snapshots")
export class Snapshots extends GameBehavior {
  @field(String) key = "4";
  @field(Number) fade = 0.5;
  private on = false;

  update(): void {
    if (!Input.getKeyDown(this.key)) return;
    this.on = !this.on;
    if (this.on) Audio.snapshot("Underwater", this.fade);
    else Audio.clearSnapshot(this.fade);
  }
}
