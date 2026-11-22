// ADR 0334: the Play toolbar's Record take and Record capture toggles, as a pure model. A toggle starts the recorder
// (`Audio.take` or `Audio.capture`, the public API), and the next press stops it and writes the file into the project's
// `takes/` or `captures/` folder under a free name (`take_01.mycotake`, `capture_01.mycap`, ...). Play stopping ends a
// running recording the same way (the recorders keep the last take for a save after Stop). Everything outside is a seam.

/** Which recorder a toggle drives. */
export type RecordKind = "take" | "capture";

export type RecordToggleState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "recording" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved"; readonly path: string }
  | { readonly kind: "failed"; readonly message: string };

export interface RecordToggleSeams {
  /** The recorder (`Audio.take` or `Audio.capture`). */
  readonly recorder: { readonly state: "idle" | "loading" | "recording" | "stopped"; readonly seconds: number; start(): Promise<void>; stop(): void };
  /** The stopped recording's file bytes. */
  bytes(): Promise<Uint8Array>;
  /** The project's files now (to pick a free name). */
  files(): readonly string[];
  /** Write `bytes` at the project path; resolves with the path written, or null when the project refused (read-only). */
  write(path: string, bytes: Uint8Array): Promise<string | null>;
}

/** Where a kind's files go and how they are named. */
export const RECORD_FOLDERS: Readonly<Record<RecordKind, { folder: string; stem: string; extension: string }>> = {
  take: { folder: "takes", stem: "take", extension: ".mycotake" },
  capture: { folder: "captures", stem: "capture", extension: ".mycap" },
};

/** The first free `<folder>/<stem>_NN<ext>` (two digits at least) among `files`. */
export function nextRecordPath(kind: RecordKind, files: readonly string[]): string {
  const { folder, stem, extension } = RECORD_FOLDERS[kind];
  const taken = new Set(files.map((f) => f.toLowerCase()));
  for (let n = 1; ; n++) {
    const path = `${folder}/${stem}_${String(n).padStart(2, "0")}${extension}`;
    if (!taken.has(path.toLowerCase())) return path;
  }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class RecordToggle {
  private s: RecordToggleState = { kind: "idle" };
  private readonly subs = new Set<() => void>();

  constructor(readonly kind: RecordKind, private readonly seams: RecordToggleSeams) {}

  get state(): RecordToggleState {
    return this.s;
  }

  /** Starting or recording. */
  get recording(): boolean {
    return this.s.kind === "starting" || this.s.kind === "recording";
  }

  get seconds(): number {
    return this.seams.recorder.seconds;
  }

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  toggle(): Promise<void> {
    return this.recording ? this.stop() : this.start();
  }

  async start(): Promise<void> {
    if (this.recording || this.s.kind === "saving") return;
    this.set({ kind: "starting" });
    try {
      await this.seams.recorder.start();
    } catch (e) {
      this.set({ kind: "failed", message: `Couldn't start the ${this.kind}: ${messageOf(e)}` });
      return;
    }
    this.set({ kind: "recording" });
  }

  /** Stop and write the file. Also what Play stopping calls: a recording the recorder already ended is saved too. */
  async stop(): Promise<void> {
    if (!this.recording) return;
    this.seams.recorder.stop();
    this.set({ kind: "saving" });
    try {
      const bytes = await this.seams.bytes();
      const path = await this.seams.write(nextRecordPath(this.kind, this.seams.files()), bytes);
      this.set(path === null ? { kind: "failed", message: `The ${this.kind} wasn't saved: the project is read-only.` } : { kind: "saved", path });
    } catch (e) {
      this.set({ kind: "failed", message: `Couldn't save the ${this.kind}: ${messageOf(e)}` });
    }
  }

  private set(next: RecordToggleState): void {
    this.s = next;
    for (const fn of [...this.subs]) fn();
  }
}

/** The toggle's tooltip and status words. */
export function recordToggleTitle(kind: RecordKind, state: RecordToggleState, seconds: number, playing: boolean): string {
  const what = kind === "take" ? "a take (what the game asks of audio, with the engine's profile) into takes/" : "a capture of the engine's profile into captures/";
  switch (state.kind) {
    case "starting":
      return `Starting the ${kind}…`;
    case "recording":
      return `Recording the ${kind} · ${seconds.toFixed(1)} s. Press again to stop and save it.`;
    case "saving":
      return `Saving the ${kind}…`;
    case "saved":
      return `Saved ${state.path}. Press to record ${what}.`;
    case "failed":
      return state.message;
    default:
      return playing ? `Record ${what}` : `Record ${what} (while playing)`;
  }
}
