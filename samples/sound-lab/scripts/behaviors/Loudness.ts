import { Audio, AudioSource, GameBehavior, GameObject, Input, Text, behavior, field } from "myco";
import { exposeKeyScopes, keysClaimed } from "../keyScope";

/**
 * The M5b listening section's page (`docs/design/0171-audio-mix/listening-notes/m5b.md`): loudness meters against a reference.
 * The project meters Master (always) and UI (`meter: "loudness"`); the targets are the project's defaults (console -24 LUFS
 * +/- 2 LU, mobile -18 LUFS +/- 2 LU, both -1 dBTP).
 *
 * - L: the reference. Pauses every other sound on the page (so Master carries the reference alone), plays
 *   `loudness-reference.wav` (a 1 kHz sine at -23 dBFS, stereo, on UI) and resets both meters. L again stops it and
 *   gives the other sounds back. A reset right after L still holds the tail of the page's reverb (the hum rings out for
 *   about 2.5 s); press C once the readout says the momentary level is steady.
 * - W: the hot signal, once: `loudness-hot.wav` (the same sine at -0.5 dBFS, 2 s) on UI. Its true peak is over the targets' ceiling.
 * - C: resets Master's and UI's meters ("all": integrated, maxima, flags).
 * - F: pauses or resumes Master's and UI's meters (a paused meter holds its readings and counts no time).
 * - V: the next loudness target (`Audio.loudnessTarget`).
 * - D: shows or hides the readout (M, S, I, LRA, true peak, elapsed, flags, the target's verdict), a few times a second.
 */
@behavior("lab.Loudness")
export class Loudness extends GameBehavior {
  @field(String) referenceKey = "l";
  @field(String) hotKey = "w";
  @field(String) resetKey = "c";
  @field(String) pauseKey = "f";
  @field(String) targetKey = "v";
  @field(String) readoutKey = "d";
  /** The buses whose meters the keys act on. */
  @field(String) buses = "Master,UI";
  /** The targets V cycles through (names of the project's `loudnessTargets`). */
  @field(String) targets = "console,mobile";

  private quieted: AudioSource[] | null = null;
  private shown = "";
  private readout = false;
  private at = -Infinity;

  start(): void {
    exposeKeyScopes();
  }

  update(): void {
    if (!keysClaimed()) {
      if (Input.getKeyDown(this.referenceKey)) this.toggleReference();
      if (Input.getKeyDown(this.hotKey)) Audio.playOneShot("audio/loudness-hot.wav", { bus: "UI" });
      if (Input.getKeyDown(this.resetKey)) for (const b of this.names()) Audio.bus(b).loudness.reset("all");
      if (Input.getKeyDown(this.pauseKey)) this.togglePause();
      if (Input.getKeyDown(this.targetKey)) this.nextTarget();
      if (Input.getKeyDown(this.readoutKey)) {
        this.readout = !this.readout;
        this.at = -Infinity;
      }
    }
    this.show();
  }

  private names(): string[] {
    return this.buses.split(",").map((s) => s.trim()).filter((s) => s !== "");
  }

  private toggleReference(): void {
    const ref = this.node.getComponent(AudioSource);
    if (!ref) return;
    if (this.quieted) {
      ref.stop();
      for (const s of this.quieted) if (s.enabled) s.play();
      this.quieted = null;
      return;
    }
    this.quieted = GameObject.findObjectsOfType(AudioSource).filter((s) => s !== ref && s.isPlaying);
    for (const s of this.quieted) s.stop();
    ref.play();
    for (const b of this.names()) Audio.bus(b).loudness.reset("all");
  }

  private togglePause(): void {
    const paused = this.names().some((b) => Audio.bus(b).loudness.paused);
    for (const b of this.names()) {
      const m = Audio.bus(b).loudness;
      if (paused) m.resume();
      else m.pause();
    }
  }

  private nextTarget(): void {
    const list = this.targets.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (list.length === 0) return;
    const i = list.indexOf(Audio.loudnessTarget ?? "");
    Audio.loudnessTarget = list[(i + 1) % list.length]!;
  }

  private show(): void {
    const label = this.node.getBehavior(Text);
    if (!label) return;
    let text = "";
    if (this.readout) {
      const now = performance.now();
      if (now - this.at < 250) return;
      this.at = now;
      const f = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
      const lines = this.names().map((b) => {
        const m = Audio.bus(b).loudness;
        const flags = [m.paused ? `paused by ${m.pausedBy}` : "", m.incomplete ? "incomplete" : "", m.tainted ? "tainted" : ""].filter((s) => s !== "").join(", ");
        const t = m.target;
        return (
          `${b}: M ${f(m.momentary)}  S ${f(m.shortTerm)}  I ${f(m.integrated)} LUFS  LRA ${f(m.lra)} LU  peak ${f(m.maxTruePeak)} dBTP  ${f(m.elapsed)} s` +
          (flags ? `  [${flags}]` : "") +
          (t ? `\n    ${t.name} (${t.integrated} LUFS +/- ${t.tolerance}, ${t.truePeak} dBTP): ${t.state}, ${t.deviation === -Infinity ? "-" : (t.deviation >= 0 ? "+" : "") + f(t.deviation)} LU${t.peakOver ? ", PEAK OVER" : ""}` : "")
        );
      });
      text = `Loudness (${Audio.loudnessTarget ?? "no target"})\n${lines.join("\n")}`;
    }
    if (text !== this.shown) label.text = this.shown = text;
  }
}
