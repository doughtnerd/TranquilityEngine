import { Audio, AudioSource, GameBehavior, GameObject, Input, Time, behavior, field } from "myco";
import { exposeKeyScopes, keysClaimed } from "../keyScope";

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
 *
 * `mode: "spatial"` is the spatial page's set for the M3 pass (docs/design/0162-audio-spatial/listening-pass.md),
 * on the listener node, and it replaces the keys above:
 * - 4: a loud source 1.5 m away and 200 quiet ones at 4 to 25 m, all at once (the 8-voice HRTF boundary, a bed under load).
 * - 5: cycles the "Bed orbit" child node (pulses of pink noise 3 m from the head, moving with the listener): first a
 *   level circle at ear height, front, right, behind, left, once every 12 s (behind and the sides); press again for a
 *   vertical circle, front, overhead, behind, below the floor, once every 12 s (above and below); again to stop it.
 * - 6 / 7: jump the listener behind the west wall (the wall between it and the corridor) and to the corner of the cave.
 * - 8: turns the listener 90 degrees on the spot (an ambience's orientation).
 * - 9: stops the orbit and the key-4 sounds.
 * - 0: stops every other sound on the page (the Ambience, Radio, Machine and Flyover), and on the second press starts
 *   again the ones it stopped (the idle-silence check needs nothing playing at all).
 */
@behavior("lab.ListeningBench")
export class ListeningBench extends GameBehavior {
  /** "listening" (the M1 keys above) or "spatial" (the M3 keys). */
  @field(String) mode = "listening";
  @field(String) pitchKey = "7";
  @field(String) limiterKey = "8";
  @field(String) loadKey = "9";
  @field(String) filterKey = "0";
  @field(String) sweepKey = "q";
  @field(String) stopKey = "o";
  @field(String) stallKey = "i";
  @field(String) longStallKey = "k";
  /** Spatial mode: the keys for the burst, the orbit, the two stations, the turn and the stop. */
  @field(String) burstKey = "4";
  @field(String) orbitKey = "5";
  @field(String) wallKey = "6";
  @field(String) cornerKey = "7";
  @field(String) turnKey = "8";
  @field(String) silenceKey = "9";
  @field(String) pageQuietKey = "0";
  /** Spatial mode: the child node the orbit moves, with an AudioSource. */
  @field(String) orbitNode = "Bed orbit";
  /** Spatial mode: seconds for one turn of the orbit. */
  @field(Number) orbitSeconds = 12;
  /** Spatial mode: the listener's stations (x, z in metres; the eye stays at its height). */
  @field(Number) wallX = -3.2;
  @field(Number) wallZ = 0;
  @field(Number) cornerX = -2.6;
  @field(Number) cornerZ = 20.5;
  private sweeping = false;
  private burstHandles: { stop(fade?: number): void }[] = [];
  private warnedNoOrbit = false;
  /** Key 5's orbit: off, a level circle ("level") or a vertical one ("vertical"), and the seconds since it started. */
  private orbitMode: "off" | "level" | "vertical" = "off";
  private orbitTime = 0;
  /** The page's sources key 0 stopped, to start again on the next press. */
  private quieted: AudioSource[] | null = null;

  update(): void {
    if (this.mode !== "spatial") {
      this.listeningKeys();
      return;
    }
    this.spatialKeys();
    this.moveOrbit();
  }

  private listeningKeys(): void {
    if (keysClaimed()) return;
    if (Input.getKeyDown(this.pitchKey)) this.pitchLadder();
    if (Input.getKeyDown(this.limiterKey)) this.stack();
    if (Input.getKeyDown(this.loadKey)) this.load();
    if (Input.getKeyDown(this.filterKey)) this.filters();
    if (Input.getKeyDown(this.sweepKey)) this.sweep();
    if (Input.getKeyDown(this.stopKey)) void this.stops();
    if (Input.getKeyDown(this.stallKey)) stall(300);
    if (Input.getKeyDown(this.longStallKey)) stall(800);
  }

  private spatialKeys(): void {
    if (Input.getKeyDown(this.burstKey)) this.burst();
    if (Input.getKeyDown(this.orbitKey)) this.toggleOrbit();
    if (Input.getKeyDown(this.wallKey)) this.teleport(this.wallX, this.wallZ);
    if (Input.getKeyDown(this.cornerKey)) this.teleport(this.cornerX, this.cornerZ);
    if (Input.getKeyDown(this.turnKey)) {
      const e = this.transform.eulerAngles;
      this.transform.eulerAngles = { x: e.x, y: e.y - Math.PI / 2, z: e.z };
    }
    if (Input.getKeyDown(this.silenceKey)) this.silence();
    if (Input.getKeyDown(this.pageQuietKey)) this.togglePageQuiet();
  }

  /** Stops every playing AudioSource on the page except the orbit (whose own keys are 5 and 9), or restarts the ones it stopped. */
  private togglePageQuiet(): void {
    if (this.quieted) {
      for (const source of this.quieted) if (source.enabled) source.play();
      this.quieted = null;
      return;
    }
    const orbit = this.orbitSource();
    this.quieted = GameObject.findObjectsOfType(AudioSource).filter((s) => s !== orbit && s.isPlaying);
    for (const source of this.quieted) source.stop();
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

  /** One loud source close to the listener and 200 quiet ones spread out around it, all starting together. */
  private burst(): void {
    const t0 = Audio.time + 0.05;
    const p = this.transform.position;
    this.burstHandles.push(Audio.playOneShot("audio/loud.wav", { volume: 1, position: { x: p.x + 0.9, y: p.y, z: p.z + 1.2 }, minDistance: 1, maxDistance: 30, at: t0 }));
    for (let i = 0; i < 200; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 4 + Math.random() * 21;
      const position = { x: p.x + Math.cos(angle) * distance, y: p.y, z: p.z - Math.sin(angle) * distance };
      this.burstHandles.push(Audio.playOneShot("audio/bright.wav", { volume: 0.02, position, minDistance: 1, maxDistance: 30, at: t0 }));
    }
  }

  /** Key 5: off → level circle → vertical circle → off. Each circle starts in front of the listener. */
  private toggleOrbit(): void {
    const source = this.orbitSource();
    if (!source) return;
    this.orbitMode = this.orbitMode === "off" ? "level" : this.orbitMode === "level" ? "vertical" : "off";
    this.orbitTime = 0;
    this.placeOrbit();
    if (this.orbitMode === "off") source.stop();
    else if (!source.isPlaying) source.play();
  }

  private moveOrbit(): void {
    if (this.orbitMode === "off") return;
    this.orbitTime += Time.deltaTime;
    this.placeOrbit();
  }

  /**
   * Puts the orbit node on its circle, 3 m from the listener in the listener's own axes (it is a child, so it turns with
   * the listener): +Z ahead, +X right, +Y up (ADR 0164). One turn every `orbitSeconds`.
   */
  private placeOrbit(): void {
    const p = this.node.find(this.orbitNode)?.transform?.position;
    if (!p) return;
    const r = 3, a = (2 * Math.PI * this.orbitTime) / this.orbitSeconds;
    if (this.orbitMode === "vertical") {
      p.x = 0;
      p.y = r * Math.sin(a); // front → overhead → behind → below
      p.z = r * Math.cos(a);
    } else {
      p.x = r * Math.sin(a); // front → right → behind → left
      p.y = 0;
      p.z = r * Math.cos(a);
    }
  }

  private orbitSource(): AudioSource | null {
    const source = this.node.find(this.orbitNode)?.getComponent(AudioSource) ?? null;
    if (!source && !this.warnedNoOrbit) {
      this.warnedNoOrbit = true;
      console.warn(`[sound-lab] The listening bench has no "${this.orbitNode}" child with an AudioSource: key ${this.orbitKey} does nothing.`);
    }
    return source;
  }

  private teleport(x: number, z: number): void {
    const p = this.transform.position;
    p.x = x;
    p.z = z;
  }

  /** Stops the orbit and the burst (the sounds this bench started). */
  private silence(): void {
    this.orbitSource()?.stop();
    this.orbitMode = "off";
    for (const handle of this.burstHandles) handle.stop(0.05);
    this.burstHandles = [];
  }
}

/** Keeps the main thread busy for `ms` milliseconds: a long frame, as a heavy script or a GC pause would cause. */
function stall(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // busy
  }
}
