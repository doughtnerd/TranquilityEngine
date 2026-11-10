import { AudioSource, GameBehavior, Input, behavior, field } from "myco";

/** The same one-second loop (whole cycles, no fades) in each format the core decodes, for the gapless-loop check. */
const LOOPS = ["audio/loops/loop.wav", "audio/loops/loop.flac", "audio/loops/loop.ogg", "audio/loops/loop.mp3"];

/** Key G loops this node's AudioSource on the next format in turn (WAV, FLAC, Vorbis, MP3), then stops; the console names it. */
@behavior("lab.LoopCycler")
export class LoopCycler extends GameBehavior {
  @field(String) key = "g";
  private index = -1;

  update(): void {
    if (!Input.getKeyDown(this.key)) return;
    const source = this.node.getComponent(AudioSource);
    if (!source) return;
    source.stop();
    this.index = this.index + 1 < LOOPS.length ? this.index + 1 : -1;
    if (this.index < 0) {
      console.log("[sound-lab] loop: off");
      return;
    }
    source.clip = `asset:${LOOPS[this.index]}`;
    source.loop = true;
    source.play();
    console.log(`[sound-lab] loop: ${LOOPS[this.index]}`);
  }
}
