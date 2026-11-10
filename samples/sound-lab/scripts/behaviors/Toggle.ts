import { AudioSource, GameBehavior, Input, behavior, field } from "myco";

/** A key starts and stops this node's AudioSource. */
@behavior("lab.Toggle")
export class Toggle extends GameBehavior {
  @field(String) key = "h";

  update(): void {
    if (!Input.getKeyDown(this.key)) return;
    const source = this.node.getComponent(AudioSource);
    if (!source) return;
    if (source.isPlaying) source.stop();
    else source.play();
  }
}
