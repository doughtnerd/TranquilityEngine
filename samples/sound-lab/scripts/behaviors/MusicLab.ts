import { Audio, GameBehavior, GameObject, Input, SceneManager, behavior, field, type AudioPlaylistHandle } from "myco";
import { setHud } from "../labHud";
import { MusicReadout } from "../musicReadout";
import { TouchBar } from "../touchBar";

/**
 * The music page (ADR 0343 playlists, migrated from ADR 0166 music events; the page's key is M on the main scene, B comes back). Every clip is a stem
 * synthesised by `tools/makeMusic.mjs` at one tempo (120 bpm, 4/4, a bar is 2 s), so any piece can follow any other on
 * the grid. Three music playlists, one playing at a time (starting one stops the one before it):
 *
 * World (starts with the page; `audio/music/music-world.playlist.json`), a Switch on the label parameter State.
 * Keys 1, 2, 3 set State to explore, combat and calm. Each change lands on the next bar, by the Switch rule for the pair:
 *   - explore to combat (2): a CUT. The old entry stops and the new one starts on the same sample.
 *   - combat to explore (1): a 2-beat CROSSFADE, equal power (the loudness stays level).
 *   - explore to calm (3) and calm to explore (1): 4-beat crossfades (their old linear and S curves became the runtime's
 *     equal-power crossfade in the migration).
 *   - calm to combat (2): a TRANSITION, a one-bar noise riser, between the two (a 1-beat crossfade into the riser; combat
 *     enters at the riser's Exit marker, its end).
 *   - combat to calm (3): no rule of its own; the Switch's change rule (the next bar, a one-beat crossfade).
 * Stingers play over the music without touching its grid: T on the next BEAT ("hit"), Y on the next BAR ("hitBar").
 *
 * Loop (L; `music-loop.playlist.json`): a Sequence with a 2-bar loop (the old event's 1-bar tail over the next pass was
 * not kept by the migration). It loops while the local parameter Loop is "hold"; L again sets it to "release", the loop is
 * left at the end of the pass playing, and the sequence plays on through its last bar and ends.
 *
 * Playlist (P; `music-playlist.playlist.json`): explore, calm and combat, two plays of two bars each, forever.
 *
 * Two more playlists, both on the lab's own 4 s stems at 120 bpm (the ones the listening pass's M4a items use):
 *   - Eight stems (4; `music-stems8.playlist.json`): pad, pulse, lead and a STREAMED melody, each twice, one Sequence
 *     that loops. All eight start stamped on one instant.
 *   - A, B, C (5; `music-list3.playlist.json`): a Sequence of three 4 s sections, once through.
 *
 * O stops the music. D shows or hides the music readout (each music playlist's voices and late starts, `Audio.debug().events`).
 *
 * Touch: a row of buttons along the bottom of the view stands in for every key (a phone has none); they go through the same
 * code as the keys. Back (B) is the button for the key that goes back to the tour.
 * The label shows the playlist and the position; the Audio Studio's Profiler shows the rest.
 */
@behavior("lab.MusicLab")
export class MusicLab extends GameBehavior {
  /** The page's UI document node (ui/*.ui.xml): this script fills its `{music}` binding. */
  @field(GameObject) hud: GameObject | null = null;
  @field(String) worldEvent = "audio/music/music-world.playlist.json";
  @field(String) loopEvent = "audio/music/music-loop.playlist.json";
  @field(String) playlistEvent = "audio/music/music-playlist.playlist.json";
  @field(String) exploreKey = "1";
  @field(String) combatKey = "2";
  @field(String) calmKey = "3";
  @field(String) beatStingerKey = "t";
  @field(String) barStingerKey = "y";
  @field(String) loopKey = "l";
  @field(String) playlistKey = "p";
  @field(String) stopKey = "o";
  @field(String) stems8Event = "audio/music/music-stems8.playlist.json";
  @field(String) list3Event = "audio/music/music-list3.playlist.json";
  @field(String) stems8Key = "4";
  @field(String) list3Key = "5";
  @field(String) readoutKey = "d";
  @field(String) backScene = "scenes/main.scene.json";

  private handle: AudioPlaylistHandle | null = null;
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
    if (!this.hud) return;
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
    if (text !== this.shown) setHud(this.hud, "music", (this.shown = text));
  }
}
