import { Audio, GameBehavior, Input, behavior, field } from "myco";

/** Seconds between the sounds of a sequence. Each is scheduled with `at` on the audio clock, so the spacing is exact. */
const ladderGap = 1.25;

/**
 * The listening pass's test keys (docs/design/0157-audio-core/listening-pass.md). Each key plays one test:
 * - 7: the bright sawtooth at pitch 0.5, 1, 1.5, 2 and 4, one after another (the resampler, and its aliasing).
 * - 8: eight near-full-scale tones at once, about 18 dB over full scale (the master limiter).
 * - 9: 300 sounds in 1.5 s, half on the "Load" bus (at most 12 at once: stealing), half spread around the
 *   listener (more than the mixed voices: promote and demote).
 * - 0: the sawtooth dry, then through the "Filters" bus (a resonant high-pass and low-pass).
 * - Q: the "Sweep" snapshot on and off over 4 s (the snapshot low-pass sweeps the Tape and Music buses).
 * - O: the sawtooth stopped with a 0.25 s fade, then again stopped at once.
 * - I / K: block the main thread for 300 ms / 800 ms (the core and streams keep playing).
 */
@behavior("lab.ListeningBench")
export class ListeningBench extends GameBehavior {
  @field(String) pitchKey = "7";
  @field(String) limiterKey = "8";
  @field(String) loadKey = "9";
  @field(String) filterKey = "0";
  @field(String) sweepKey = "q";
  @field(String) stopKey = "o";
  @field(String) stallKey = "i";
  @field(String) longStallKey = "k";
  private sweeping = false;

  update(): void {
    if (Input.getKeyDown(this.pitchKey)) this.pitchLadder();
    if (Input.getKeyDown(this.limiterKey)) this.stack();
    if (Input.getKeyDown(this.loadKey)) this.load();
    if (Input.getKeyDown(this.filterKey)) this.filters();
    if (Input.getKeyDown(this.sweepKey)) this.sweep();
    if (Input.getKeyDown(this.stopKey)) void this.stops();
    if (Input.getKeyDown(this.stallKey)) stall(300);
    if (Input.getKeyDown(this.longStallKey)) stall(800);
  }

  private pitchLadder(): void {
    const t0 = Audio.time + 0.1;
    [0.5, 1, 1.5, 2, 4].forEach((pitch, i) => Audio.playOneShot("audio/bright.wav", { bus: "UI", volume: 0.6, pitch, at: t0 + i * ladderGap }));
  }

  private stack(): void {
    const t0 = Audio.time + 0.05;
    for (const pitch of [1, 1.5, 2, 2.5, 3, 4, 5, 6]) Audio.playOneShot("audio/loud.wav", { bus: "UI", pitch, at: t0 });
  }

  private load(): void {
    const t0 = Audio.time + 0.05;
    for (let i = 0; i < 300; i++) {
      const at = t0 + i * 0.005;
      const pitch = 0.5 + Math.random() * 1.5;
      const priority = Math.floor(Math.random() * 256);
      if (i % 2 === 0) Audio.playOneShot("audio/bright.wav", { bus: "Load", volume: 0.15, pitch, priority, at });
      else {
        const position = { x: (Math.random() - 0.5) * 30, y: 1, z: (Math.random() - 0.5) * 20 };
        Audio.playOneShot("audio/bright.wav", { volume: 0.08, pitch, priority, at, position, minDistance: 2, maxDistance: 30 });
      }
    }
  }

  private filters(): void {
    const t0 = Audio.time + 0.1;
    Audio.playOneShot("audio/bright.wav", { bus: "UI", volume: 0.6, at: t0 });
    Audio.playOneShot("audio/bright.wav", { bus: "Filters", volume: 0.6, at: t0 + ladderGap });
  }

  private sweep(): void {
    this.sweeping = !this.sweeping;
    if (this.sweeping) Audio.snapshot("Sweep", 4);
    else Audio.clearSnapshot(4);
  }

  private async stops(): Promise<void> {
    const faded = Audio.playOneShot("audio/bright.wav", { bus: "UI", volume: 0.6 });
    await this.wait.realtime(0.4);
    faded.stop(0.25);
    await this.wait.realtime(1);
    const cut = Audio.playOneShot("audio/bright.wav", { bus: "UI", volume: 0.6 });
    await this.wait.realtime(0.4);
    cut.stop();
  }
}

/** Keeps the main thread busy for `ms` milliseconds: a long frame, as a heavy script or a GC pause would cause. */
function stall(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // busy
  }
}
