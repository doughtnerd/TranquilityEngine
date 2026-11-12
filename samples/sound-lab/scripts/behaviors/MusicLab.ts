import { Audio, GameBehavior, Input, SceneManager, Text, behavior, field, type AudioEventHandle } from "myco";
import { MusicReadout } from "../musicReadout";
import { TouchBar } from "../touchBar";

/**
 * The music page (ADR 0166, ADR 0167; the page's key is M on the main scene, B comes back). Every clip is a stem
 * synthesised by `tools/makeMusic.mjs` at one tempo (120 bpm, 4/4, a bar is 2 s), so any piece can follow any other on
 * the grid. Three music events, one playing at a time (starting one stops the one before it):
 *
 * World (starts with the page; `audio/music/music-world.audioevent.json`), a `musicSwitch` on the label parameter State.
 * Keys 1, 2, 3 set State to explore, combat and calm. Each change lands on the next bar, by the transition rule for the pair:
 *   - explore to combat (2): a CUT. The old segment stops and the new one starts on the same sample.
 *   - combat to explore (1): a 2-beat CROSSFADE, equal power (the loudness stays level).
 *   - explore to calm (3): a 4-beat crossfade with the LINEAR curve (it dips in the middle).
 *   - calm to explore (1): a 4-beat crossfade with the S curve (slow at both ends).
 *   - calm to combat (2): a BRIDGE, a one-bar noise riser from the library, between the two (a 1-beat equal-power crossfade
 *     into the riser; combat lands at full level on the riser's last sample).
 *   - combat to calm (3): no rule of its own; the default rule (the next bar, a one-beat equal-power crossfade).
 * Stingers play over the music without touching its grid: T on the next BEAT ("hit"), Y on the next BAR ("hitBar").
 *
 * Loop (L; `music-loop.audioevent.json`): a 2-bar loop region with a 1-bar TAIL (a crash and a chord) that rings over
 * the start of the next pass. It loops while the local parameter Loop is "hold"; L again sets it to "release", the loop is
 * left, and the segment plays on through its last bar and ends. The condition is read just before each loop end, so a
 * release lands at the end of the pass playing when L is pressed (one pass later when pressed in the last ~60 ms of it).
 *
 * Playlist (P; `music-playlist.audioevent.json`): explore, calm and combat, two plays of two bars each, forever.
 *
 * Two more events, both on the lab's own 4 s stems at 120 bpm (the ones the listening pass's M4a items use):
 *   - Eight stems (4; `music-stems8.audioevent.json`): pad, pulse, lead and a STREAMED melody, each twice, one segment
 *     that loops. All eight start on one instant (a group), the two melodies through music rings.
 *   - A, B, C (5; `music-list3.audioevent.json`): a playlist of three one-pass 4 s items, each change on the beat, once through.
 *
 * O stops the music. D shows or hides the music health readout (prime lead and late groups, `Audio.debug().music`).
 *
 * Touch: a row of buttons along the bottom of the view stands in for every key (a phone has none); they go through the same
 * code as the keys. Back (B) is the button for the key that goes back to the tour.
 * The label shows the segment, the position and the change that is waiting; the full story is in the
 * Audio Debug panel's Music section (the Pending column names the rule that was chosen).
 */
@behavior("lab.MusicLab")
export class MusicLab extends GameBehavior {
  @field(String) worldEvent = "audio/music/music-world.audioevent.json";
  @field(String) loopEvent = "audio/music/music-loop.audioevent.json";
  @field(String) playlistEvent = "audio/music/music-playlist.audioevent.json";
  @field(String) exploreKey = "1";
  @field(String) combatKey = "2";
  @field(String) calmKey = "3";
  @field(String) beatStingerKey = "t";
  @field(String) barStingerKey = "y";
  @field(String) loopKey = "l";
  @field(String) playlistKey = "p";
  @field(String) stopKey = "o";
  @field(String) stems8Event = "audio/music/music-stems8.audioevent.json";
  @field(String) list3Event = "audio/music/music-list3.audioevent.json";
  @field(String) stems8Key = "4";
  @field(String) list3Key = "5";
  @field(String) readoutKey = "d";
  @field(String) backScene = "scenes/main.scene.json";

  private handle: AudioEventHandle | null = null;
  private mode: "world" | "loop" | "playlist" | "stems8" | "list3" | "" = "";
  private state = "explore";
  private released = false;
  private stinger = "";
  private shown = "";
  private readonly readout = new MusicReadout();
  private bar: TouchBar | null = null;
  private leaving = false;

  start(): void {
    this.play("world");
    this.bar = new TouchBar([
      { key: "1", label: "1 Explore" },
      { key: "2", label: "2 Combat" },
      { key: "3", label: "3 Calm" },
      { key: "t", label: "T Beat hit" },
      { key: "y", label: "Y Bar hit" },
      { key: "l", label: "L Loop" },
      { key: "p", label: "P Playlist" },
      { key: "4", label: "4 Eight stems" },
      { key: "5", label: "5 A-B-C" },
      { key: "o", label: "O Stop" },
      { key: "d", label: "D Readout" },
      { key: "b", label: "B Back" },
    ]);
  }

  update(): void {
    const touched = this.bar?.drain() ?? [];
    const key = (k: string) => Input.getKeyDown(k) || touched.includes(k);
    if (key(this.exploreKey)) this.setState("explore");
    else if (key(this.combatKey)) this.setState("combat");
    else if (key(this.calmKey)) this.setState("calm");
    if (key(this.beatStingerKey)) this.fire("hit");
    if (key(this.barStingerKey)) this.fire("hitBar");
    if (key(this.loopKey)) this.toggleLoop();
    if (key(this.playlistKey)) this.play(this.mode === "playlist" ? "" : "playlist");
    if (key(this.stems8Key)) this.play(this.mode === "stems8" ? "" : "stems8");
    if (key(this.list3Key)) this.play(this.mode === "list3" ? "" : "list3");
    if (key(this.stopKey)) this.play("");
    if (key(this.readoutKey)) this.readout.toggle();
    if (touched.includes("b") && !this.leaving) {
      this.leaving = true;
      SceneManager.load(this.backScene).catch((err: Error) => {
        this.leaving = false;
        console.error(`[sound-lab] Couldn't load ${this.backScene}: ${err.message}`);
      });
    }
    if (this.handle && !this.handle.playing && this.mode !== "") {
      this.handle = null;
      this.mode = "";
    }
    this.show();
  }

  onDestroy(): void {
    this.bar?.destroy();
    this.bar = null;
    this.handle?.stop(0.2);
  }

  /** Stops what plays and starts the page `mode` ("" starts nothing). */
  private play(mode: "world" | "loop" | "playlist" | "stems8" | "list3" | ""): void {
    this.handle?.stop(0.3);
    this.handle = null;
    this.mode = mode;
    this.released = false;
    this.stinger = "";
    if (mode === "world") this.handle = Audio.play(this.worldEvent, { parameters: { State: this.state } });
    else if (mode === "loop") this.handle = Audio.play(this.loopEvent, { parameters: { Loop: "hold" } });
    else if (mode === "playlist") this.handle = Audio.play(this.playlistEvent);
    else if (mode === "stems8") this.handle = Audio.play(this.stems8Event);
    else if (mode === "list3") this.handle = Audio.play(this.list3Event);
  }

  private setState(state: string): void {
    if (this.mode !== "world") {
      this.state = state;
      this.play("world");
      return;
    }
    this.state = state;
    this.handle?.setParameter("State", state);
  }

  private fire(name: string): void {
    if (this.mode !== "world" || !this.handle) return;
    this.stinger = `${name} ${this.handle.trigger(name) ? "accepted" : "refused"}`;
  }

  private toggleLoop(): void {
    if (this.mode !== "loop") {
      this.play("loop");
      return;
    }
    this.released = !this.released;
    this.handle?.setParameter("Loop", this.released ? "release" : "hold");
  }

  private show(): void {
    const label = this.node.getBehavior(Text);
    if (!label) return;
    const m = this.handle?.music;
    const where = m && m.segment ? `${m.segment} ${m.bar}:${m.beat}` : this.handle ? "starting" : "-";
    const next = m?.transition ? `, next: ${m.transition.to}` : "";
    const what =
      this.mode === "world" ? `world, State ${this.state}${next}` : this.mode === "loop" ? `loop, ${this.released ? "released (playing out)" : "holding"}` : this.mode === "playlist" ? "playlist" : this.mode === "stems8" ? "eight stems" : this.mode === "list3" ? "playlist A, B, C" : "off";
    const text =
      `Music: ${what} (${where})${this.stinger ? `; stinger ${this.stinger}` : ""}\n` +
      "1 explore, 2 combat, 3 calm: each pair has its own transition (see the notes in MusicLab.ts)\n" +
      "T stinger on the beat, Y on the bar; L loop with a tail, L again leaves it; P playlist; 4 eight stems, 5 playlist A, B, C\n" +
      "O stops; D music readout; B goes back (on a phone the buttons along the bottom do the same)" +
      (this.readout.on ? `\n${this.readout.lines()}` : "");
    if (text !== this.shown) label.text = this.shown = text;
  }
}
