import { AudioSource, GameBehavior, Input, behavior, field } from "myco";

/** A key pauses this node's AudioSource and resumes it from where it stopped. */
@behavior("lab.PauseToggle")
export class PauseToggle extends GameBehavior {
  @field(String) key = "p";
  private paused = false;

  update(): void {
    if (!Input.getKeyDown(this.key)) return;
    const source = this.node.getComponent(AudioSource);
    if (!source) return;
    this.paused = !this.paused;
    if (this.paused) source.pause();
    else source.resume();
  }
}
