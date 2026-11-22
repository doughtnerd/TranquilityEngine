// Recording the Studio's own runtime (ADR 0334 "Profiling a take as it plays"; the prototype's Record in the player
// bar): Record starts a capture (`Audio.capture.start()`, the public API) and follows the recorder's live ring through the
// editor profiler's `LiveFollow` (the `LiveHost` seam), so the timeline grows while it records; Stop ends the capture,
// takes the take's file bytes (the capture module's internal `captureFileBytes`, the same file `Audio.capture.save()`
// writes; decision log D13) and writes them into the project's `captures/` folder (`capture_NN.mycap`) on every
// platform, the browser included, then opens the saved file. Everything outside is a seam, so the flow is tested
// without a recorder.
import { signal } from "@preact/signals";
import type { AudioCapture } from "../../../plugins/audio/runtime";
import { LiveFollow, type LiveFollowOptions, type LiveHost } from "../../../plugins/audio/editor/mix/liveFollow";
import type { ProfileSource } from "../../../plugins/audio/editor/mix/profilerSource";
import { nextCapturePath } from "./captureTree";
import type { ProfilerStore } from "./profilerStore";

export type RecorderState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "recording" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved"; readonly path: string }
  | { readonly kind: "failed"; readonly message: string };

export interface RecorderSeams {
  readonly capture: Pick<AudioCapture, "state" | "seconds" | "start" | "stop">;
  /** The latest take as a `.mycap` file's bytes (rejects when nothing was recorded). */
  fileBytes(): Promise<Uint8Array>;
  /** The recorder's live ring; null where there is none (no live view while recording). */
  readonly liveHost: LiveHost | null;
  readonly store: Pick<ProfilerStore, "openLive" | "refreshLive" | "openPath" | "close">;
  /** The project's files now (to name the capture). */
  files(): readonly string[];
  /** Write `bytes` into the project at (or next to) `path`; resolves with the path written. */
  write(path: string, bytes: Uint8Array): Promise<string>;
  /** `LiveFollow` options (tests: the scheduler and the source's Worker). */
  readonly liveOptions?: Partial<Omit<LiveFollowOptions, "host" | "onUpdate">>;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class CaptureRecorder {
  readonly state = signal<RecorderState>({ kind: "idle" });
  private follow: LiveFollow | null = null;
  private shown: ProfileSource | null = null;

  constructor(private readonly seams: RecorderSeams) {}

  get recording(): boolean {
    const k = this.state.peek().kind;
    return k === "starting" || k === "recording";
  }

  /** Seconds recorded so far (the recorder's ring). */
  get seconds(): number {
    return this.seams.capture.seconds;
  }

  /** Record: start the capture and follow it live. */
  async start(): Promise<void> {
    if (this.recording || this.state.peek().kind === "saving") return;
    this.state.value = { kind: "starting" };
    try {
      await this.seams.capture.start();
    } catch (e) {
      this.state.value = { kind: "failed", message: `Couldn't start a capture: ${messageOf(e)}` };
      return;
    }
    this.state.value = { kind: "recording" };
    const host = this.seams.liveHost;
    if (!host) return;
    this.shown = null;
    this.follow = new LiveFollow({
      ...this.seams.liveOptions,
      host,
      onUpdate: (m) => {
        if (!m.source) return;
        if (m.source !== this.shown) {
          this.shown = m.source;
          void this.seams.store.openLive(m.source, "Recording the Studio");
        } else void this.seams.store.refreshLive();
      },
    });
    void this.follow.start();
  }

  /** Stop: end the capture, save it into the project's captures folder and open it. */
  async stop(): Promise<void> {
    if (!this.recording) return;
    this.seams.capture.stop();
    this.follow?.stop();
    this.follow = null;
    if (this.shown) this.seams.store.close();
    this.shown = null;
    this.state.value = { kind: "saving" };
    const path = nextCapturePath(this.seams.files());
    try {
      const bytes = await this.seams.fileBytes();
      const written = await this.seams.write(path, bytes);
      this.state.value = { kind: "saved", path: written };
      await this.seams.store.openPath(written);
    } catch (e) {
      this.state.value = { kind: "failed", message: `Couldn't save the capture: ${messageOf(e)}` };
    }
  }

  toggle(): Promise<void> {
    return this.recording ? this.stop() : this.start();
  }

  /** The screen went away: stop following (the capture itself goes on until Stop). */
  dispose(): void {
    this.follow?.stop();
    this.follow = null;
  }
}

/** What the player bar's status says of the recorder. */
export function recorderStatus(state: RecorderState, seconds: number): string | null {
  switch (state.kind) {
    case "idle":
      return null;
    case "starting":
      return "Starting a capture…";
    case "recording":
      return `Recording the Studio · ${seconds.toFixed(1)} s`;
    case "saving":
      return "Saving the capture…";
    case "saved":
      return `Saved ${state.path}`;
    case "failed":
      return state.message;
  }
}
