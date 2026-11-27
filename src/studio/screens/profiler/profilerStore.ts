// The Profiler screen's state (ADR 0348 "The Profiler screen"): the open capture (a project file, or the Studio's own
// runtime recorded live), what is read from it (`ProfilerDataReader`), the cursor (the editor profiler's `CursorModel`:
// its STATUS steps and jumps), the state at the cursor (`seekAtCursor`), the selected voice, and the timeline's filter
// and grouping. Every panel of the screen reads these signals; nothing here touches the DOM. Opening is injected
// (`ProfilerStoreSeams`), so the store runs over the in-process capture Worker in tests.
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import { CursorModel, seekAtCursor } from "../../../plugins/audio/editor/mix/cursorModel";
import { captureErrorMessage } from "../../../plugins/audio/editor/mix/openSaveFlow";
import type { ProfileSource } from "../../../plugins/audio/editor/mix/profilerSource";
import type { CaptureReplayOf } from "../../../plugins/audio/runtime/capture/format";
import { CaptureError, captureNames, type CaptureSeekState } from "../../../plugins/audio/runtime/capture/reader";
import { captureTitle } from "../run/captureTree";
import { runCursorKey, type CursorKeyAction } from "./cursorKeys";
import { busReadouts, type BusReadout } from "./cursorReadout";
import { ProfilerDataReader, type ProfilerData } from "./profilerData";
import type { GroupBy, VoiceBlock } from "./voiceModel";

export interface ProfilerStoreSeams {
  /** Opens capture bytes (transferred) as a source. */
  open(bytes: ArrayBuffer): Promise<ProfileSource>;
  /** A project file's bytes. */
  readFile(path: string): Promise<ArrayBuffer>;
}

export type OpenState =
  | { readonly kind: "none" }
  | { readonly kind: "opening"; readonly path: string }
  | {
      readonly kind: "open";
      readonly origin: "file" | "live";
      readonly path: string | null;
      readonly title: string;
      /** ADR 0348: the take this capture recorded the Studio replaying (META `replayOf`), or null. */
      readonly replayOf: CaptureReplayOf | null;
      /** ADR 0409: the recording holds take data (META `take`), so it is a take itself. */
      readonly take: boolean;
    }
  | { readonly kind: "failed"; readonly path: string; readonly message: string };

const messageOf = (e: unknown): string =>
  e instanceof CaptureError ? captureErrorMessage(e.code, e.message.replace(`${e.code} at ${e.offset}: `, "")) : e instanceof Error ? e.message : String(e);

export class ProfilerStore {
  readonly state = signal<OpenState>({ kind: "none" });
  readonly data = signal<ProfilerData | null>(null);
  /** The cursor's viewport time, seconds. */
  readonly cursor = signal(0);
  readonly seek = signal<CaptureSeekState | null>(null);
  /** The selected voice block's key. */
  readonly selected = signal<string | null>(null);
  readonly problemsOnly = signal(false);
  readonly groupBy = signal<GroupBy>("bus");

  readonly selectedVoice: ReadonlySignal<VoiceBlock | null> = computed(() => {
    const key = this.selected.value;
    return key ? (this.data.value?.voices.find((v) => v.key === key) ?? null) : null;
  });

  /** Each bus at the cursor (the keyframe in force). */
  readonly readouts: ReadonlySignal<BusReadout[]> = computed(() => {
    const seek = this.seek.value;
    const src = this.src;
    if (!seek || !src) return [];
    return busReadouts(seek.keyframe, captureNames(src.summary), src.startSeconds + this.cursor.value);
  });

  private src: ProfileSource | null = null;
  private reader: ProfilerDataReader | null = null;
  private model = new CursorModel({ live: false });
  private run = 0;
  private seekRun = 0;

  constructor(private readonly seams: ProfilerStoreSeams) {}

  /** The open source (for the recorder's live view and the stories). */
  get source(): ProfileSource | null {
    return this.src;
  }

  /** Open a project capture file. A failure says why and leaves nothing open. */
  async openPath(path: string): Promise<boolean> {
    const s = this.state.peek();
    if ((s.kind === "open" || s.kind === "opening") && "path" in s && s.path === path) return true;
    const run = ++this.run;
    this.drop();
    this.state.value = { kind: "opening", path };
    try {
      const source = await this.seams.open(await this.seams.readFile(path));
      if (run !== this.run) {
        source.close();
        return false;
      }
      await this.attach(source, { kind: "open", origin: "file", path, title: captureTitle(path), replayOf: source.summary.meta.replayOf ?? null, take: source.summary.meta.take != null });
      return run === this.run;
    } catch (e) {
      if (run === this.run) this.state.value = { kind: "failed", path, message: messageOf(e) };
      return false;
    }
  }

  /** Show a live source (the Studio's runtime recording); `refreshLive` after it grew. The store doesn't close it (its follower does). */
  async openLive(source: ProfileSource, title: string): Promise<void> {
    ++this.run;
    this.drop();
    await this.attach(source, { kind: "open", origin: "live", path: null, title, replayOf: source.summary.meta.replayOf ?? null, take: false }, true);
  }

  /** The live source grew: read what it gained; a live cursor follows its newest block. */
  async refreshLive(): Promise<void> {
    if (!this.src?.live || !this.reader) return;
    const run = this.run;
    const data = await this.reader.refresh();
    if (run !== this.run) return;
    this.apply(data);
    if (this.model.mode === "live") await this.moved();
  }

  /** Close what is open (the live source is left to its follower). */
  close(): void {
    ++this.run;
    this.drop();
    this.state.value = { kind: "none" };
  }

  /** Move the cursor to viewport time `t` (a click, a message, a voice). */
  seekTo(t: number): void {
    this.model.seekTo(t);
    void this.moved();
  }

  /** ← → and Shift+← →; false when there was nowhere to go. */
  key(action: CursorKeyAction): boolean {
    if (!this.src) return false;
    const moved = runCursorKey(action, this.model);
    if (moved) void this.moved();
    return moved;
  }

  /** Select a voice (null: none); `seek` also moves the cursor to its start (the prototype's click on a block). */
  select(key: string | null, seek = false): void {
    this.selected.value = key;
    if (!key || !seek) return;
    const v = this.data.peek()?.voices.find((b) => b.key === key);
    if (v) this.seekTo(v.start);
  }

  private drop(): void {
    const prev = this.src;
    this.src = null;
    this.reader = null;
    if (prev && !prev.live) prev.close();
    this.data.value = null;
    this.seek.value = null;
    this.selected.value = null;
    this.cursor.value = 0;
  }

  private async attach(source: ProfileSource, state: OpenState, live = false): Promise<void> {
    const run = this.run;
    this.src = source;
    this.reader = new ProfilerDataReader(source);
    this.model = new CursorModel({ live });
    const data = await this.reader.refresh();
    if (run !== this.run) return;
    this.apply(data);
    // At the start before it shows as open, so whatever moves the cursor once it is open (the review link to the open
    // take) isn't undone.
    if (!live) {
      this.model.seekTo(0);
      this.cursor.value = this.model.time;
    }
    this.state.value = state;
    await this.moved();
  }

  private apply(data: ProfilerData): void {
    this.model.setDuration(data.duration);
    this.model.setTargets(data.targets);
    this.data.value = data;
    this.cursor.value = this.model.time;
  }

  /** The cursor moved: the state at it, unless a newer move owns the answer. */
  private async moved(): Promise<void> {
    this.cursor.value = this.model.time;
    const src = this.src;
    if (!src) return;
    const run = ++this.seekRun;
    try {
      const r = await seekAtCursor(src, this.model);
      if (r && run === this.seekRun && this.src === src) this.seek.value = r.state;
    } catch {
      // a closed source: the panels keep the last state
    }
  }
}
