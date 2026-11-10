import { AudioSource, GameBehavior, Input, behavior, field } from "myco";

/**
 * Key T starts and stops this node's AudioSource (the streamed melody); key Y jumps it between the first note and the
 * fifth (2 s in), for the listening pass's seek check.
 */
@behavior("lab.Tape")
export class Tape extends GameBehavior {
  @field(String) toggleKey = "t";
  @field(String) seekKey = "y";
  private atFifth = false;

  update(): void {
    const source = this.node.getComponent(AudioSource);
    if (!source) return;
    if (Input.getKeyDown(this.toggleKey)) {
      if (source.isPlaying) source.stop();
      else source.play();
    }
    if (Input.getKeyDown(this.seekKey) && source.isPlaying) {
      this.atFifth = !this.atFifth;
      // Seeking isn't public API yet (owner review 21, a decision record pending); this test bench reaches it directly.
      (source as unknown as { seek?(seconds: number): void }).seek?.(this.atFifth ? 2 : 0);
    }
  }
}
