import { Audio } from "myco";

/**
 * The music readout: per playing music playlist (`Audio.debug().events`, the playlist instances under `audio/music/` and
 * the events page's music) its voices and the entries it started late (should stay 0). `Audio.debug()` allocates, so the
 * text is rebuilt four times a second at most, and only while the readout is on.
 */
export class MusicReadout {
  on = false;
  private text = "";
  private at = -Infinity;

  toggle(): boolean {
    this.on = !this.on;
    this.at = -Infinity;
    return this.on;
  }

  /** The readout's lines (empty while it is off). */
  lines(now = performance.now()): string {
    if (!this.on) return "";
    if (now - this.at < 250) return this.text;
    this.at = now;
    const rows = Audio.debug().events.filter((r) => r.asset.includes("/music"));
    if (rows.length === 0) {
      this.text = "music readout: no music playing";
      return this.text;
    }
    this.text = `music readout: ${rows.map((r) => `${r.asset.replace(/^.*\//, "").replace(/\.playlist\.json$/, "")}: ${r.voices} voices, late ${r.lateStarts}`).join("\n")}`;
    return this.text;
  }
}
