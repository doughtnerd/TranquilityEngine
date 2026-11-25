// The open take's replay, for the whole Studio (ADR 0348 "Replay"; owner decision 2026-11-22: take replay stands in for
// the game session in v1). One take is open at a time; its replay (`runtime/takeReplay.ts`) keeps playing when the user
// switches screens, and the player bar's replay slot shows it with play/pause and a scrub on every screen, so a Mixer or
// Playlists edit is heard against the take. While a take is open, the curve editor's parameter histogram (ADR 0346) is
// computed from the values its PARAM records sent.
//
// The page's store is `replayStore()`, over the Studio's runtime; `ReplayStore` takes its seams, so it runs in tests on
// a fake target, clock and frame loop.
import { computed, effect, signal, type ReadonlySignal } from "@preact/signals";
import type { Take } from "../../engine/audio/take/reader";
import { currentProject } from "../../editor/state";
import { performanceClock, studioReplayTarget, TakeReplay, type ReplayClock, type ReplayTarget } from "../runtime/takeReplay";
import { studioReplayWorld } from "../runtime/takeWorld";
import { setParameterHistogramSource, setParameterNowSource } from "../screens/curveInputs";
import { audioHost } from "./studioServices";

export interface OpenTake {
  /** The take file, project-relative. */
  readonly path: string;
  /** Its name without folder and extension. */
  readonly title: string;
  readonly take: Take;
  readonly replay: TakeReplay;
}

export interface ReplaySeams {
  /** A fresh target for a take being opened. */
  target(): ReplayTarget;
  readonly clock: ReplayClock;
  /** Call `fn` every frame until the returned stop. */
  frame(fn: () => void): () => void;
}

/** Bins of the parameter histogram. */
export const HISTOGRAM_BINS = 32;

const titleOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.toLowerCase().endsWith(".sporesample") ? name.slice(0, -".sporesample".length) : name;
};

export class ReplayStore {
  private readonly current = signal<OpenTake | null>(null);
  readonly open: ReadonlySignal<OpenTake | null> = this.current;
  /** The playhead, take seconds (0 with no take). */
  readonly time = computed(() => this.current.value?.replay.time.value ?? 0);
  readonly playing = computed(() => this.current.value?.replay.playing.value ?? false);
  private stops: (() => void)[] = [];

  constructor(private readonly seams: ReplaySeams) {}

  /** Open `take` (read from `path`) for replay, closing the one open. Paused at the start. */
  openTake(path: string, take: Take): TakeReplay {
    this.close();
    const replay = new TakeReplay(take, this.seams.target(), this.seams.clock);
    this.current.value = { path, title: titleOf(path), take, replay };
    let stopFrames: (() => void) | null = null;
    this.stops = [
      setParameterHistogramSource((name, range) => parameterHistogram(take, name, range)),
      // The curve editor's "Game now": the last value the take sent for the parameter at its playhead.
      setParameterNowSource((name) => parameterAt(take, name, replay.time.peek())),
      effect(() => {
        const playing = replay.playing.value;
        if (playing && !stopFrames) stopFrames = this.seams.frame(() => replay.tick());
        else if (!playing && stopFrames) {
          stopFrames();
          stopFrames = null;
        }
      }),
      () => stopFrames?.(),
    ];
    return replay;
  }

  /** Close the open take: its sounds stop and the mix it changed goes back. */
  close(): void {
    const open = this.current.peek();
    if (!open) return;
    for (const stop of this.stops) stop();
    this.stops = [];
    open.replay.dispose();
    this.current.value = null;
  }

  /** The open take's file moved (renamed or moved): it stays open under its new path. */
  moved(from: string, to: string): void {
    const open = this.current.peek();
    if (open && open.path === from) this.current.value = { ...open, path: to, title: titleOf(to) };
  }

  toggle(): void {
    this.current.peek()?.replay.toggle();
  }

  seek(t: number): void {
    this.current.peek()?.replay.seek(t);
  }
}

/**
 * How often the game sent each value of parameter `name` (globally or to an instance) in `take`, in `HISTOGRAM_BINS`
 * bins over `range` (values outside it count at its ends). Null when the take never sent it.
 */
function parameterHistogram(take: Take, name: string, range: readonly [number, number]): number[] | null {
  const [lo, hi] = range;
  const bins = new Array<number>(HISTOGRAM_BINS).fill(0);
  let any = false;
  const add = (v: number) => {
    const k = hi > lo ? Math.floor(((v - lo) / (hi - lo)) * HISTOGRAM_BINS) : 0;
    bins[Math.min(HISTOGRAM_BINS - 1, Math.max(0, k))]!++;
    any = true;
  };
  for (const q of take.requests) {
    if (q.kind === "param" && q.name === name) add(q.value);
    else if (q.kind === "play" && q.options.parameters && name in q.options.parameters) add(q.options.parameters[name]!);
  }
  return any ? bins : null;
}

/** The last value `take` sent for parameter `name` (globally or to an instance) at or before `t`, or null when none yet. */
function parameterAt(take: Take, name: string, t: number): number | null {
  let value: number | null = null;
  for (const q of take.requests) {
    if (q.t > t) break;
    if (q.kind === "param" && q.name === name) value = q.value;
    else if (q.kind === "play" && q.options.parameters && name in q.options.parameters) value = q.options.parameters[name]!;
  }
  return value;
}

let store: ReplayStore | null = null;

/** The page's replay store, over the Studio's runtime; it closes the take when the project changes. */
export function replayStore(): ReplayStore {
  if (store) return store;
  const s = new ReplayStore({
    target: () => studioReplayTarget(audioHost(), studioReplayWorld()),
    clock: performanceClock,
    frame(fn) {
      let id = requestAnimationFrame(function loop() {
        fn();
        id = requestAnimationFrame(loop);
      });
      return () => cancelAnimationFrame(id);
    },
  });
  let project = currentProject.peek();
  effect(() => {
    const next = currentProject.value;
    if (next !== project) s.close();
    project = next;
  });
  return (store = s);
}

