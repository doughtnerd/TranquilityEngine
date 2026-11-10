import { Audio, GameBehavior, Input, Text, behavior, field } from "myco";

/**
 * Music intensity (ADR 0158 §2, §3). This node's AudioSource plays `music-intensity.audioevent.json`: three layers in
 * one loop (pad, pulse, lead). The global parameter "Intensity" (0..1, seekSpeed 0.5, so a change glides over about two
 * seconds) fades the pulse and then the lead in with automation on the event, and the project's `audio.automation` also
 * drives the Music bus: louder and brighter (its low-pass opens from 900 Hz to 18 kHz) as intensity rises. N and M
 * lower and raise it by a quarter. The parameter is global, so the main page's music is untouched: this page starts it
 * at 0 and puts it back to 1 (its default, where the bus automation changes nothing) when the page closes.
 */
@behavior("lab.MusicIntensity")
export class MusicIntensity extends GameBehavior {
  @field(String) upKey = "m";
  @field(String) downKey = "n";
  @field(Number) stepSize = 0.25;
  private value = 0;

  start(): void {
    this.apply();
  }

  update(): void {
    if (Input.getKeyDown(this.upKey)) this.value = Math.min(1, this.value + this.stepSize);
    else if (Input.getKeyDown(this.downKey)) this.value = Math.max(0, this.value - this.stepSize);
    else return;
    this.apply();
  }

  onDestroy(): void {
    Audio.setParameter("Intensity", 1);
  }

  private apply(): void {
    Audio.setParameter("Intensity", this.value);
    const label = this.node.getBehavior(Text);
    if (label) label.text = `Music intensity ${this.value.toFixed(2)}: N lower, M raise (the heard value glides to it)`;
  }
}
