import { Audio } from "myco";

/**
 * The music health readout (listening pass item P1): per playing music instance the prime lead and what sets it, from
 * `Audio.debug().music`. `lead` is how far ahead of the audio clock the player plans a start (`leadMs`), `prime` the smoothed
 * time the decoder takes to ready a streamed stem (`primeEmaMs`, with the last one), `late` the groups that started late and
 * `held` the ones the core held for a stem (`lateGroups`, `groupsHeld`; both should stay 0). `Audio.debug()` allocates, so the
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
    const rows = Audio.debug().music ?? [];
    if (rows.length === 0) {
      this.text = "music readout: no music playing";
      return this.text;
    }
    const f = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
    this.text = rows
      .map((r) => `${r.asset.replace(/^.*\//, "").replace(/\.audioevent\.json$/, "")}: lead ${f(r.leadMs)} ms, prime ${f(r.primeEmaMs)} ms (last ${f(r.primeLastMs)}), late ${r.lateGroups}, held ${r.groupsHeld}`)
      .join("\n");
    return this.text;
  }
}
