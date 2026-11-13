// ADR 0171 amended by 0172 (M5, contract K0, H4; api-and-models §1.2, architecture §2.1, §3.1): `Audio.capture`, a
// take over the shared recorder ring. The recorder (`capture/recorder.ts`, Rc2) is a lazy chunk: this file is the only
// one that may load it, and only through a dynamic `import()` on the first `start()`, so a game that never captures
// loads no recorder. Nothing imports `recorder.ts` statically (a test checks every source file).
//
// K0 declares the surface with stubs; Rc4 fills it (the take, `start` from Held after a GAP, `mark`, `save` with
// deflate-raw, name sanitising, the web Blob and Tauri `Storage`, rotation of 16). Rc4 sets the loader to
// `() => import("./recorder")` once Rc2's module exists.

/** `Audio.capture` (§1.2). */
export interface AudioCapture {
  /** "idle" -> "loading" (recorder chunk fetching) -> "recording" -> "stopped" (a take exists to save). */
  readonly state: AudioCaptureState;
  /** The ring's content, seconds; 0 while idle. */
  readonly seconds: number;
  readonly bytes: number;
  /** True when the ring wrapped over the take's start: the file begins at a later keyframe and is marked truncated. */
  readonly truncated: boolean;
  /** Load the recorder (a lazy chunk) and begin a take. Resolves once recording; rejects with a message if the chunk or the core is unavailable. A second call while recording joins it, writes a marker and resolves at once. */
  start(): Promise<void>;
  /** End the caller's hold. The ring keeps recording while the Profiler panel is open (one ring, shared). */
  stop(): void;
  /** A timeline marker at the current frame, cut to `CAPTURE_MARK_BYTES` (120) UTF-8 bytes. No-op while no ring runs. */
  mark(text: string): void;
  /** Compress and save the take; resolves with the web file name or the app-data path. Rejects with "nothing recorded: call Audio.capture.start() first" when there is no take. */
  save(name?: string): Promise<string>;
}

/** `AudioCapture.state`. */
export type AudioCaptureState = "idle" | "loading" | "recording" | "stopped";

/** The empty-save rejection (§1.2). */
export const NOTHING_RECORDED = "nothing recorded: call Audio.capture.start() first";

/** What the recorder chunk exports to this file (Rc2 declares the real shape; Rc4 widens this to it). */
export interface RecorderModule {
  readonly recorderModule: true;
}

/** Loads the recorder chunk. Rc4: `() => import("./recorder")`. Until then nothing can record. */
let loadRecorder: () => Promise<RecorderModule> = () => Promise.reject(new Error("audio capture isn't available yet (Rc4)"));

/** @internal Tests: replace the chunk loader (a spy proves a game that never starts loads nothing). Returns the previous one. */
export function _setRecorderLoader(load: () => Promise<RecorderModule>): () => Promise<RecorderModule> {
  const previous = loadRecorder;
  loadRecorder = load;
  return previous;
}

/** The one `Audio.capture` object (K0's stubs; Rc4 fills each member). */
class Capture implements AudioCapture {
  /** Rc4. */
  get state(): AudioCaptureState {
    return "idle";
  }
  /** Rc4. */
  get seconds(): number {
    return 0;
  }
  /** Rc4. */
  get bytes(): number {
    return 0;
  }
  /** Rc4. */
  get truncated(): boolean {
    return false;
  }
  /** Rc4: load the chunk (the only `loadRecorder` call), allocate or join the ring, begin a take. */
  start(): Promise<void> {
    return loadRecorder().then(() => {
      throw new Error("audio capture isn't available yet (Rc4)");
    });
  }
  /** Rc4. */
  stop(): void {}
  /** Rc4. */
  mark(_text: string): void {}
  /** Rc4. */
  save(_name?: string): Promise<string> {
    return Promise.reject(new Error(NOTHING_RECORDED));
  }
}

/** `Audio.capture`. */
export const audioCapture: AudioCapture = new Capture();
