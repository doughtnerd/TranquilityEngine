import { Audio, AudioSource, GameBehavior, GameObject, Input, Text, Time, behavior, field } from "myco";
import { Loudness } from "./Loudness";

/**
 * The Mixer page (key `-` on the tour page, `scenes/mixer.scene.json`; ADR 0171 amended by 0172, M5c): every ducking rule
 * of the project, audible, and the loudness meters against a reference. The project's buses: Music (a loop), Ambience
 * (a noise bed through the reverb send), SFX and Voice (the speech-like loop `audio/mixer/voice-loop.wav`). Its rules:
 *
 * - **SFX ducks Music**, presence mode: a burst on SFX (key 2) dips Music to 0.3 for as long as the sound plays.
 * - **Voice ducks Music**, level mode, RMS detector, -30 dBFS: the voice (key 1) dips Music to 0.35 inside each phrase
 *   and releases in the gaps, because the detector reads the voice's level, not whether it plays.
 * - **Voice ducks Ambience**, level mode, peak detector, -20 dBFS: the bed dips to 0.5 under the voice.
 *
 * Keys: 1 the voice on or off; 2 an SFX burst; 3 the tour on or off (a script that cycles the triggers: the voice alone,
 * a burst alone, both together, quiet); 4 the Music bed on or off; 5 the Ambience bed on or off. The readout shows each
 * ducked bus's duck lane (`Bus.duckGain`: 1 = not ducked) with the rules that act on it. The loudness reference and meters
 * are the tour page's (`lab.Loudness` on another node of this page): L the reference (the page's other sounds pause, the
 * tour with them), W the hot signal, C reset, F pause, V the next target, D the readout. The project meters Master and UI.
 * B goes back to the tour (a `lab.SceneSwitch` node).
 */
@behavior("lab.MixerLab")
export class MixerLab extends GameBehavior {
  @field(String) voiceKey = "1";
  @field(String) sfxKey = "2";
  @field(String) tourKey = "3";
  @field(String) musicKey = "4";
  @field(String) ambienceKey = "5";

  /** The tour's steps: how long (s) and what starts at the step's beginning (a burst, the voice on or off). */
  private static readonly tour: readonly { seconds: number; voice: boolean; burst?: boolean; label: string }[] = [
    { seconds: 5, voice: true, label: "the voice alone: Voice ducks Music (level, RMS) and Ambience (level, peak)" },
    { seconds: 2, voice: false, label: "quiet: both release" },
    { seconds: 2.5, voice: false, burst: true, label: "a burst alone: SFX ducks Music (presence)" },
    { seconds: 5, voice: true, burst: true, label: "the voice and a burst: Music takes the lower of its two ducks" },
    { seconds: 2, voice: false, label: "quiet" },
  ];

  private voice: AudioSource | null = null;
  private music: AudioSource | null = null;
  private bed: AudioSource | null = null;
  private touring = false;
  private step = 0;
  private stepLeft = 0;
  private shownAt = -Infinity;
  private shown = "";

  start(): void {
    const all = GameObject.findObjectsOfType(AudioSource);
    const by = (output: string) => all.find((s) => s.output === output && s !== this.voice);
    this.voice = this.node.getComponent(AudioSource) ?? all.find((s) => s.output === "Voice") ?? null;
    this.music = by("Music") ?? null;
    this.bed = by("Ambience") ?? null;
  }

  update(): void {
    const reference = GameObject.findObjectsOfType(Loudness).some((l) => l.referenceOn);
    // The reference pauses every other sound (Loudness stops what plays and gives it back): the keys and the tour wait.
    if (!reference) {
      if (Input.getKeyDown(this.voiceKey)) this.toggle(this.voice);
      if (Input.getKeyDown(this.sfxKey)) Audio.playOneShot("audio/burst.wav", { bus: "SFX" });
      if (Input.getKeyDown(this.tourKey)) this.setTour(!this.touring);
      if (Input.getKeyDown(this.musicKey)) this.toggle(this.music);
      if (Input.getKeyDown(this.ambienceKey)) this.toggle(this.bed);
      if (this.touring) this.runTour(Time.deltaTime);
    }
    this.show();
  }

  private toggle(source: AudioSource | null): void {
    if (!source) return;
    if (source.isPlaying) source.stop();
    else source.play();
  }

  private setTour(on: boolean): void {
    this.touring = on;
    this.step = 0;
    this.stepLeft = 0;
    if (!on) this.voice?.stop();
  }

  private runTour(dt: number): void {
    this.stepLeft -= dt;
    if (this.stepLeft > 0) return;
    const s = MixerLab.tour[this.step % MixerLab.tour.length]!;
    this.step++;
    this.stepLeft = s.seconds;
    if (s.voice) this.voice?.play();
    else this.voice?.stop();
    if (s.burst) Audio.playOneShot("audio/burst.wav", { bus: "SFX" });
  }

  private show(): void {
    const label = this.node.getBehavior(Text);
    if (!label) return;
    const now = Time.time;
    if (now - this.shownAt < 0.1) return;
    this.shownAt = now;
    const music = Audio.bus("Music").duckGain;
    const ambience = Audio.bus("Ambience").duckGain;
    const tour = this.touring ? MixerLab.tour[(this.step + MixerLab.tour.length - 1) % MixerLab.tour.length]!.label : "off (3)";
    const text =
      `Voice ${this.voice?.isPlaying ? "on" : "off"} (1)   Music bed ${this.music?.isPlaying ? "on" : "off"} (4)   Ambience bed ${this.bed?.isPlaying ? "on" : "off"} (5)   burst (2)\n` +
      `Tour (3): ${tour}\n` +
      `Music duck x${music.toFixed(2)}   SFX presence 0.30, Voice level RMS -30 dBFS 0.35\n` +
      `Ambience duck x${ambience.toFixed(2)}   Voice level peak -20 dBFS 0.50`;
    if (text !== this.shown) label.text = this.shown = text;
  }
}
