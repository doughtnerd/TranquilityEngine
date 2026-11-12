import { GameBehavior, SceneManager, behavior } from "myco";
import { TouchBar } from "../touchBar";

/**
 * The tour page's way to the other pages for a screen with no keyboard: a row of buttons along the bottom of the view,
 * Events (E), Spatial (S), Music (M) and Rhythm (R), each loading the page its key loads (the `lab.SceneSwitch` nodes on
 * this page keep the keys). The music and rhythm pages carry their own buttons, among them Back.
 */
@behavior("lab.PageNav")
export class PageNav extends GameBehavior {
  private bar: TouchBar | null = null;
  private loading = false;
  private static readonly pages: Record<string, string> = {
    e: "scenes/events.scene.json",
    s: "scenes/spatial.scene.json",
    m: "scenes/music.scene.json",
    r: "scenes/rhythm.scene.json",
  };

  start(): void {
    this.bar = new TouchBar([
      { key: "e", label: "E Events" },
      { key: "s", label: "S Spatial" },
      { key: "m", label: "M Music" },
      { key: "r", label: "R Rhythm" },
    ]);
  }

  update(): void {
    const scene = this.bar?.drain().map((k) => PageNav.pages[k])[0];
    if (!scene || this.loading) return;
    this.loading = true;
    SceneManager.load(scene).catch((err: Error) => {
      this.loading = false;
      console.error(`[sound-lab] Couldn't load ${scene}: ${err.message}`);
    });
  }

  onDestroy(): void {
    this.bar?.destroy();
    this.bar = null;
  }
}
