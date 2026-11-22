// The calibration dialog's clicks (by ear): a short tick on every beat through Web Audio, on the system's output
// device like the Studio's runtime. The beats are given on the page clock (`performance.now()`), so the clicks, the
// flashing boxes and the taps (`event.timeStamp`) share one timeline; whatever the output adds is what the user's
// taps measure.

export interface ClickTrack {
  /** Tick on every beat at `startMs + k·periodMs` (page clock) until stopped. */
  start(startMs: number, periodMs: number): void;
  stop(): void;
}

/** How far ahead clicks are scheduled, s. */
const AHEAD = 0.6;

export function webAudioClickTrack(): ClickTrack {
  let ctx: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    start(startMs, periodMs) {
      this.stop();
      const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
      if (!Ctor) return;
      const context = (ctx = new Ctor({ latencyHint: "interactive" }));
      void context.resume();
      let next = 0; // beat index to schedule next
      const schedule = () => {
        const nowMs = performance.now();
        const ctxNow = context.currentTime;
        for (;;) {
          const beatMs = startMs + next * periodMs;
          const at = ctxNow + (beatMs - nowMs) / 1000;
          if (at > ctxNow + AHEAD) break;
          next++;
          if (at < ctxNow) continue; // missed (a stalled tab): skip it
          const osc = context.createOscillator();
          const gain = context.createGain();
          osc.frequency.value = next % 4 === 1 ? 1760 : 1320;
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(0.5, at + 0.002);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.04);
          osc.connect(gain).connect(context.destination);
          osc.start(at);
          osc.stop(at + 0.05);
        }
      };
      schedule();
      timer = setInterval(schedule, 100);
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
      void ctx?.close();
      ctx = null;
    },
  };
}
