import { Audio, Calibration, GameBehavior, Input, Text, behavior, field, type AudioEventHandle, type CalibrationResult, type MusicEvent } from "myco";

/** What one tap read: the music's position at the key press, the raw offset, the calibrated one, and the grade. */
export interface RhythmTap {
  /** `MusicPositionAt.offset` in ms (positive: late), before calibration. */
  offsetMs: number;
  /** `MusicPositionAt.judged` in ms: the offset less `Audio.calibration`; what the game compares. */
  judgedMs: number;
  bar: number;
  beat: number;
  /** "perfect" and "good" are hits; "miss" is a tap outside the window. Calibration taps are "" (they are not graded). */
  grade: "perfect" | "good" | "miss" | "";
}

/** What the page exposes to tests and the browser e2e (`globalThis.__rhythmLab.state()`). */
export interface RhythmState {
  mode: "" | "calibrate" | "game";
  /** Calibration: taps wanted, taps collected, and the raw offsets (ms). */
  tapsWanted: number;
  taps: number;
  offsetsMs: number[];
  /** The last `Calibration.fromTaps` result in ms (offset, spread), with its flags; null before the first run. */
  result: { offsetMs: number; spreadMs: number; confidence: number; used: number; discarded: number; steady: boolean; applied: boolean } | null;
  calibrationMs: number;
  calibrationStale: boolean;
  rhythmMode: boolean;
  latencyMs: { base: number; output: number; limiter: number; total: number; reliable: boolean };
  /** The click or beat the music has counted, and the last beat's `bar:beat`. */
  beats: number;
  lastBeat: string;
  last: RhythmTap | null;
  hits: number;
  misses: number;
  streak: number;
  bestStreak: number;
}

/**
 * The rhythm page (ADR 0166, ADR 0167, task Rh3; key R on the tour page, B comes back): calibrate the audio output, then
 * tap along to the music. Click the game view first. Tap with the SPACE bar.
 *
 * Calibration (C): a click track plays (120 bpm, a click on every beat; beat 1 is higher). Tap SPACE exactly on each click.
 * Each tap goes through `handle.music.positionAt(event time)`, which gives its signed `offset` from the nearest click
 * (positive: you were late). After 4 warm-up taps and 16 more (`tapsWanted`, 20 in all) the page hands the raw offsets to
 * `Calibration.fromTaps`, which reports their median (the offset), spread (the median absolute deviation) and whether the
 * run was steady (spread within 40 ms, at least 8 usable taps). A steady result is applied: `Audio.calibration` is set to
 * the offset, which is stored for this output device (and is still there after a reload). An unsteady run is shown but not
 * applied: tap more evenly and run C again. X sets the calibration back to 0. The page also shows `Audio.calibrationStale`
 * (true after the output device changed: calibrate again), `Audio.latency` and `Audio.rhythmMode`.
 *
 * Tap game (G): a drum and bass loop plays. Tap SPACE on the beat. Each tap is judged with `positionAt(...).judged`, the
 * offset less the calibration, so a calibrated player taps at 0 ms: within 30 ms is PERFECT, within 80 ms is GOOD, anything
 * else is a MISS; the page shows early or late in ms and the streak. The beat marker is moved by `handle.onMusic("beat")`.
 *
 * O stops the music. The project has `audio.rhythmMode` on (the context asks for the lowest latency, and the readout below
 * shows what the browser gave back); `Audio.latency.reliable` says whether the output figure can be trusted, and if not,
 * calibrate. The state the page shows is also on `globalThis.__rhythmLab.state()`.
 *
 * Key presses are timed with the DOM event's own time stamp (`keydown`, read by `Audio.timeAt` through `positionAt`), not
 * the frame's, so a tap is not up to a frame (16 ms) late. Without a DOM (a headless test) the page falls back to
 * `Input.getKeyDown` and `performance.now()`, and a test can call `tap(performanceTime)`.
 */
@behavior("lab.RhythmLab")
export class RhythmLab extends GameBehavior {
  @field(String) clickEvent = "audio/music/rhythm-click.audioevent.json";
  @field(String) gameEvent = "audio/music/rhythm-game.audioevent.json";
  @field(String) tapKey = "space";
  @field(String) calibrateKey = "c";
  @field(String) gameKey = "g";
  @field(String) resetKey = "x";
  @field(String) stopKey = "o";
  /** Taps a calibration run collects, warm-up included (`Calibration.fromTaps` drops the first 4). */
  @field(Number) tapsWanted = 20;
  /** Seconds: a tap within this of the beat (after calibration) is a PERFECT, and within `goodWindow` a GOOD. */
  @field(Number) perfectWindow = 0.03;
  @field(Number) goodWindow = 0.08;

  private handle: AudioEventHandle | null = null;
  private unsubscribe: (() => void) | null = null;
  private mode: "" | "calibrate" | "game" = "";
  private offsets: number[] = [];
  private result: RhythmState["result"] = null;
  private beats = 0;
  private lastBeat = "";
  private flash = 0;
  private last: RhythmTap | null = null;
  private hits = 0;
  private misses = 0;
  private streak = 0;
  private bestStreak = 0;
  private shown = "";
  private pressed: number[] = [];
  private listener: ((e: { key: string; repeat?: boolean; timeStamp: number }) => void) | null = null;

  start(): void {
    const g = globalThis as unknown as {
      addEventListener?: (type: string, fn: (e: never) => void) => void;
      __rhythmLab?: { state(): RhythmState; tap(t: number): RhythmTap | null; page: RhythmLab };
    };
    if (typeof g.addEventListener === "function") {
      const want = this.tapKey.toLowerCase();
      this.listener = (e) => {
        const k = e.key === " " ? "space" : String(e.key).toLowerCase();
        if (k === want && !e.repeat) this.pressed.push(e.timeStamp);
      };
      g.addEventListener("keydown", this.listener as (e: never) => void);
    }
    g.__rhythmLab = { state: () => this.state(), tap: (t) => this.tap(t), page: this };
  }

  update(): void {
    if (Input.getKeyDown(this.calibrateKey)) this.begin(this.mode === "calibrate" ? "" : "calibrate");
    else if (Input.getKeyDown(this.gameKey)) this.begin(this.mode === "game" ? "" : "game");
    else if (Input.getKeyDown(this.stopKey)) this.begin("");
    if (Input.getKeyDown(this.resetKey)) Audio.calibration = 0;
    if (this.listener) {
      for (const t of this.pressed) this.tap(t);
      this.pressed.length = 0;
    } else if (Input.getKeyDown(this.tapKey)) {
      this.tap(performance.now());
    }
    if (this.handle && !this.handle.playing && this.mode !== "") this.begin("");
    if (this.flash > 0) this.flash -= 1;
    this.show();
  }

  onDestroy(): void {
    this.begin("");
    const g = globalThis as unknown as { removeEventListener?: (type: string, fn: (e: never) => void) => void; __rhythmLab?: unknown };
    if (this.listener) g.removeEventListener?.("keydown", this.listener as (e: never) => void);
    this.listener = null;
    delete g.__rhythmLab;
  }

  /** Stops what plays and starts the page `mode` ("" starts nothing). A calibration or a game starts from zero taps. */
  begin(mode: "" | "calibrate" | "game"): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.handle?.stop(0.2);
    this.handle = null;
    this.mode = mode;
    this.offsets = [];
    this.beats = 0;
    this.lastBeat = "";
    this.last = null;
    if (mode === "calibrate") this.result = null;
    if (mode === "game") this.hits = this.misses = this.streak = this.bestStreak = 0;
    if (mode === "") return;
    this.handle = Audio.play(mode === "calibrate" ? this.clickEvent : this.gameEvent);
    this.unsubscribe = this.handle.onMusic("beat", (e: MusicEvent) => this.onBeat(e));
  }

  private onBeat(e: MusicEvent): void {
    this.beats += 1 + e.missed;
    this.lastBeat = `${e.bar}:${e.beat}`;
    this.flash = 6;
  }

  /**
   * A key press at `performanceTime` (`performance.now()` base, as `event.timeStamp`). In a calibration run it records the
   * raw offset and, on the last tap, runs `Calibration.fromTaps` and applies a steady result; in the game it judges the
   * tap. Returns what it read, or null when no music was playing at that instant (the tap does not count).
   */
  tap(performanceTime: number): RhythmTap | null {
    const m = this.handle?.music;
    if (!m || this.mode === "") return null;
    const at = m.positionAt(performanceTime);
    if (at.segment === null) return null;
    const tap: RhythmTap = { offsetMs: at.offset * 1000, judgedMs: at.judged * 1000, bar: at.bar, beat: at.beat, grade: "" };
    if (this.mode === "calibrate") {
      if (this.offsets.length >= this.tapsWanted) return tap;
      this.offsets.push(at.offset);
      this.last = tap;
      if (this.offsets.length === this.tapsWanted) this.finish(Calibration.fromTaps(this.offsets));
      return tap;
    }
    const a = Math.abs(at.judged);
    tap.grade = a <= this.perfectWindow ? "perfect" : a <= this.goodWindow ? "good" : "miss";
    if (tap.grade === "miss") {
      this.misses++;
      this.streak = 0;
    } else {
      this.hits++;
      this.bestStreak = Math.max(this.bestStreak, ++this.streak);
    }
    this.last = tap;
    return tap;
  }

  private finish(r: CalibrationResult): void {
    const applied = r.steady;
    if (applied) Audio.calibration = r.offset;
    this.result = { offsetMs: r.offset * 1000, spreadMs: r.spread * 1000, confidence: r.confidence, used: r.used, discarded: r.discarded, steady: r.steady, applied };
    this.handle?.stop(0.2);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.handle = null;
    this.mode = "";
  }

  state(): RhythmState {
    const l = Audio.latency;
    return {
      mode: this.mode,
      tapsWanted: this.tapsWanted,
      taps: this.offsets.length,
      offsetsMs: this.offsets.map((x) => x * 1000),
      result: this.result,
      calibrationMs: Audio.calibration * 1000,
      calibrationStale: Audio.calibrationStale,
      rhythmMode: Audio.rhythmMode,
      latencyMs: { base: l.base * 1000, output: l.output * 1000, limiter: l.limiter * 1000, total: l.total * 1000, reliable: l.reliable },
      beats: this.beats,
      lastBeat: this.lastBeat,
      last: this.last,
      hits: this.hits,
      misses: this.misses,
      streak: this.streak,
      bestStreak: this.bestStreak,
    };
  }

  private show(): void {
    const label = this.node.getBehavior(Text);
    if (!label) return;
    const s = this.state();
    const ms = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)} ms`;
    const pulse = this.flash > 0 ? "(*)" : "( )";
    const lines: string[] = [];
    if (s.mode === "calibrate") {
      lines.push(`Calibrating: tap SPACE on every click ${pulse} (${s.taps}/${s.tapsWanted}; the first 4 are warm-up)`);
      if (this.last) lines.push(`last tap ${ms(this.last.offsetMs)} from the click (${this.last.offsetMs >= 0 ? "late" : "early"})`);
    } else if (s.mode === "game") {
      lines.push(`Tap game: tap SPACE on the beat ${pulse} beat ${s.lastBeat || "-"}`);
      lines.push(`hits ${s.hits}, misses ${s.misses}, streak ${s.streak} (best ${s.bestStreak})`);
      if (this.last) lines.push(`${this.last.grade.toUpperCase()}: ${ms(this.last.judgedMs)} (${this.last.judgedMs >= 0 ? "late" : "early"}); raw ${ms(this.last.offsetMs)}`);
    } else if (s.result) {
      const r = s.result;
      lines.push(`Calibration: ${ms(r.offsetMs)}, spread ${r.spreadMs.toFixed(1)} ms, ${r.used} taps used (${r.discarded} dropped), confidence ${(r.confidence * 100).toFixed(0)}%`);
      lines.push(r.steady ? "Steady: applied to Audio.calibration and stored for this output device." : "Unsteady: NOT applied. Tap more evenly and press C again.");
    } else {
      lines.push("Idle. Press C to calibrate with a click track, then G to play the tap game.");
    }
    lines.push(`Audio.calibration ${ms(s.calibrationMs)}${s.calibrationStale ? "  STALE: the output device changed, calibrate again (C)" : ""}`);
    lines.push(`Audio.latency: output ${s.latencyMs.output.toFixed(1)} ms, base ${s.latencyMs.base.toFixed(1)} ms, total ${s.latencyMs.total.toFixed(1)} ms, ${s.latencyMs.reliable ? "reliable" : "not reliable (calibrate)"}; rhythm mode ${s.rhythmMode ? "on" : "off"}`);
    lines.push("C calibrate (tap SPACE on each click), G tap game, X reset the calibration to 0, O stops; B goes back");
    const text = lines.join("\n");
    if (text !== this.shown) label.text = this.shown = text;
  }
}
