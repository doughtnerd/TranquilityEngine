import { Audio, GameBehavior, GameObject, Input, behavior, field, type AudioPlaylistHandle } from "myco";
import { setHud } from "../labHud";

/**
 * An engine two ways (ADR 0343 playlists). E starts and key-offs `engine.playlist.json`: a Sequence whose start clip runs
 * into a held loop over a Blend of idle, mid and high RPM clips (each sample looping its region, from its sidecar), and
 * whose end clip is the engine-off tail. T does the same with `engine-single.playlist.json`, one sample with its own
 * run-up, a held loop region (its sidecar) and a spin-down tail. Hold the Up arrow for full throttle, the Right arrow for half:
 * the local parameter "RPM" is set once when the throttle changes and the core smooths it (seekSpeed), moving the blend
 * and the pitch. Releasing the engine (E or T again) is `handle.release()`: the loop ends and the tail plays.
 */
@behavior("lab.EngineBench")
export class EngineBench extends GameBehavior {
  /** The page's UI document node (ui/*.ui.xml): this script fills its `{engine}` binding. */
  @field(GameObject) hud: GameObject | null = null;
  @field(String) blendEvent = "audio/events/engine.playlist.json";
  @field(String) singleEvent = "audio/events/engine-single.playlist.json";
  @field(String) blendKey = "e";
  @field(String) singleKey = "t";
  @field(String) fullKey = "arrowup";
  @field(String) halfKey = "arrowright";
  private handle: AudioPlaylistHandle | null = null;
  private which = "";
  private released = false;
  private throttle = 0;
  private shown = "";

  update(): void {
    if (Input.getKeyDown(this.blendKey)) this.toggle("blend", this.blendEvent);
    if (Input.getKeyDown(this.singleKey)) this.toggle("single", this.singleEvent);
    const throttle = Input.getKey(this.fullKey) ? 1 : Input.getKey(this.halfKey) ? 0.5 : 0;
    if (throttle !== this.throttle) {
      this.throttle = throttle;
      this.handle?.setParameter("RPM", throttle);
    }
    if (this.handle && !this.handle.playing) {
      this.handle = null;
      this.which = "";
    }
    this.show();
  }

  private toggle(which: string, event: string): void {
    if (this.handle?.playing && !this.released && this.which === which) {
      this.handle.release();
      this.released = true;
      return;
    }
    // Starting the other engine, or one still playing its tail: the old one is cut with a short fade.
    this.handle?.stop(0.1);
    this.handle = Audio.play(event, { bus: "Engine", parameters: { RPM: this.throttle } });
    this.which = which;
    this.released = false;
  }

  private show(): void {
    if (!this.hud) return;
    const state = !this.handle ? "off" : this.released ? "released (playing its tail)" : "running";
    const text = `Engine: E blend + start/off clips, T single clip. Now: ${this.which || "-"} ${state}\nUp = full throttle, Right = half (RPM ${this.throttle})`;
    if (text !== this.shown) setHud(this.hud, "engine", (this.shown = text));
  }
}
