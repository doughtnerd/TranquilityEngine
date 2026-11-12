import { Audio, GameBehavior, Input, Text, behavior, field, type AudioEventHandle } from "myco";

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
 *   - calm to combat (2): a BRIDGE, a one-bar noise riser from the library, between the two. (Needs the bridge player, R3b:
 *     until it lands this change plays as a plain crossfade, as the guide says.)
 *   - combat to calm (3): no rule of its own; the default rule (the next bar, a one-beat equal-power crossfade).
 * Stingers play over the music without touching its grid: T on the next BEAT ("hit"), Y on the next BAR ("hitBar").
 *
 * Loop (L; `music-loop.audioevent.json`): a 2-bar loop region with a 1-bar TAIL (a crash and a chord) that rings over
 * the start of the next pass. It loops while the local parameter Loop is "hold"; L again sets it to "release", the loop is
 * left, and the segment plays on through its last bar and ends. (Needs `while` regions and tails, R4a and R4b: until
 * they land a segment with such a region is a plain forever loop and L's release does nothing.)
 *
 * Playlist (P; `music-playlist.audioevent.json`): explore, calm and combat, two plays of two bars each, forever.
 *
 * O stops the music. The label shows the segment, the position and the change that is waiting; the full story is in the
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

  private handle: AudioEventHandle | null = null;
  private mode: "world" | "loop" | "playlist" | "" = "";
  private state = "explore";
  private released = false;
  private stinger = "";
  private shown = "";

  start(): void {
    this.play("world");
  }

  update(): void {
    if (Input.getKeyDown(this.exploreKey)) this.setState("explore");
    else if (Input.getKeyDown(this.combatKey)) this.setState("combat");
    else if (Input.getKeyDown(this.calmKey)) this.setState("calm");
    if (Input.getKeyDown(this.beatStingerKey)) this.fire("hit");
    if (Input.getKeyDown(this.barStingerKey)) this.fire("hitBar");
    if (Input.getKeyDown(this.loopKey)) this.toggleLoop();
    if (Input.getKeyDown(this.playlistKey)) this.play(this.mode === "playlist" ? "" : "playlist");
    if (Input.getKeyDown(this.stopKey)) this.play("");
    if (this.handle && !this.handle.playing && this.mode !== "") {
      this.handle = null;
      this.mode = "";
    }
    this.show();
  }

  onDestroy(): void {
    this.handle?.stop(0.2);
  }

  /** Stops what plays and starts the page `mode` ("" starts nothing). */
  private play(mode: "world" | "loop" | "playlist" | ""): void {
    this.handle?.stop(0.3);
    this.handle = null;
    this.mode = mode;
    this.released = false;
    this.stinger = "";
    if (mode === "world") this.handle = Audio.play(this.worldEvent, { parameters: { State: this.state } });
    else if (mode === "loop") this.handle = Audio.play(this.loopEvent, { parameters: { Loop: "hold" } });
    else if (mode === "playlist") this.handle = Audio.play(this.playlistEvent);
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
      this.mode === "world" ? `world, State ${this.state}${next}` : this.mode === "loop" ? `loop, ${this.released ? "released (playing out)" : "holding"}` : this.mode === "playlist" ? "playlist" : "off";
    const text =
      `Music: ${what} (${where})${this.stinger ? `; stinger ${this.stinger}` : ""}\n` +
      "1 explore, 2 combat, 3 calm: each pair has its own transition (see the notes in MusicLab.ts)\n" +
      "T stinger on the beat, Y on the bar; L loop with a tail, L again leaves it; P playlist; O stops; B goes back";
    if (text !== this.shown) label.text = this.shown = text;
  }
}
