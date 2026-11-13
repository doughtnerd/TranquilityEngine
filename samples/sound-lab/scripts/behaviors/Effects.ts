import { Audio, GameBehavior, Input, behavior, field } from "myco";
import { exposeKeyScopes, keysClaimed } from "../keyScope";

/**
 * Key 5: a loud noise burst on SFX, whose bus has a compressor. While it plays, the project's ducking rule lowers
 * Music (SFX is the trigger). Key 6 plays a low beep on Ambience, whose bus sends to the reverb. Key X plays the same
 * burst scheduled one second ahead (`at`): the M5-0 listening section hears Music duck on the burst's own frame, not
 * before and not after (`docs/design/0171-audio-mix/listening-notes/m5-0.md`).
 */
@behavior("lab.Effects")
export class Effects extends GameBehavior {
  @field(String) burstKey = "5";
  @field(String) reverbKey = "6";
  @field(String) scheduledBurstKey = "x";

  update(): void {
    if (keysClaimed()) return;
    if (Input.getKeyDown(this.burstKey)) Audio.playOneShot("audio/burst.wav", { bus: "SFX" });
    if (Input.getKeyDown(this.scheduledBurstKey)) Audio.playOneShot("audio/burst.wav", { bus: "SFX", at: Audio.time + 1 });
    if (Input.getKeyDown(this.reverbKey)) Audio.playOneShot("audio/beep.wav", { bus: "Ambience", pitch: 0.5 });
  }
}
