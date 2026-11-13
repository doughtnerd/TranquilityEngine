// ADR 0171 amended by 0172 (M5a, task Pf4; api-and-models §7): the Profiler panel's chrome. It records (`Audio.capture`),
// stops, saves, opens a file or a dropped file, follows the live ring while the editor plays (`LiveFollow`), mounts the
// timeline canvas over the track modules it is given, and shows the banners. It draws no tables and no tracks itself.
//
// Thin over a pure model: `ProfilerController` holds every decision (flows, banners, the track list, the live follow)
// and is tested without a DOM; the Preact view only renders its `view` snapshot and forwards events. The canvas is
// redrawn by `TimelineCanvas` on requestAnimationFrame; Preact re-renders on a user action, a finished flow or
// `LiveFollow`'s coalesced update (at most once per 66 ms), never per STATUS block.
//
// SLOTS (contract H5). W8's tasks fill these without editing this file: each is a component in `profilerSlots`, with a
// placeholder default, and `mix/index.ts` is where a task's module sets its slot (one import and one line each):
//   `tables`  the tables region under the timeline: Pf5's `VoiceTable.tsx` and `BusTable.tsx` (`TablesSlotProps`);
//   `bar`     the record / stop / save / open bar: Pf8's open/save flow (`BarSlotProps`; the default is a plain bar
//             wired to the controller's `record`, `stop`, `save` and `openFile`);
//   `banners` the banner list: Pf8's `ProfilerBanners.tsx` (`BannersSlotProps`; the texts are `profilerBanners`);
//   `onDropFile` what a dropped file does (default: `controller.openFile`; X2 may route it through its `openCapture`).
// What the controller needs from outside is `ProfilerDeps`, all injected: `Audio.capture`, `openCapture`, the project's
// audio section, the live host (Rc4's `LiveHost`), the STATUS subscription and the track factories (Pf3b-d).
import type { ComponentChild, ComponentType } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { editor, theme } from "../../../../editor/sdk";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { Audio } from "../../runtime/Audio";
import type { AudioCapture } from "../../runtime/capture/capture";
import { CAPTURE_FLAG_MAIN_SIDE_ONLY, CaptureError } from "../../runtime/capture/format";
import type { CaptureSeekState } from "../../runtime/capture/reader";
import { CursorModel, cursorTargets, CURSOR_COLUMNS, seekAtCursor, type CursorSnapshot } from "./cursorModel";
import { cssVarReader, readTimelineColors, RULER_HEIGHT, TimelineCanvas, type TrackData } from "./drawTimeline";
import { chooseEmptyState } from "./emptyStates";
import { LiveFollow, type LiveFollowModel, type LiveHost } from "./liveFollow";
import { CaptureSource, type ProfileSource } from "./profilerSource";
import { TrackList } from "./timelineModel";
import type { TrackFactory, TrackModule } from "./tracks/types";
import { nameLookup } from "./voiceTableModel";
import "./profilerPanel.css";

// ---- banners (pure) -------------------------------------------------------------------------------------------------

export type ProfilerBannerId = "viewing" | "truncated" | "projectMismatch" | "wireMismatch" | "babylon" | "error";

export interface ProfilerBanner {
  readonly id: ProfilerBannerId;
  readonly severity: "info" | "warn" | "error";
  readonly text: string;
}

/** The banner texts (the design gives the behaviour; the words are these, and the tests assert them). */
export const BANNER_TEXT = {
  viewing: "Viewing, not replaying",
  truncated: "Truncated: the ring wrapped. This capture starts at a later keyframe, not at Play.",
  projectMismatch: "This capture was recorded with a different audio section than the open project's. It is shown as recorded.",
  babylon: "Babylon fallback: main-side events and keyframes only. The CPU, underrun and loudness tracks are absent.",
} as const;

/** What the banners are chosen from. */
export interface BannerInput {
  /** The open capture, if any. */
  readonly source: ProfileSource | null;
  /** The open project's `audio` section (parsed JSON), or undefined when no project is open. */
  readonly projectAudio: unknown;
  /** The last open's refusal. */
  readonly error: { readonly code: string; readonly message: string } | null;
  /** The file's name for the refusal's text. */
  readonly fileName: string | null;
}

/** The capture's META `audio` against the project's section, both as the engine parses them (a missing key and its default agree). */
export const sameAudioSettings = (a: unknown, b: unknown): boolean =>
  sameAudioSection(parseAudioSettings(a ?? undefined).settings, parseAudioSettings(b ?? undefined).settings);

/** JSON-like deep equality (key order ignored). */
export function sameAudioSection(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!sameAudioSection((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** Every banner that applies, most severe first. A live view is this session's own ring: no mismatch and no "Viewing". */
export function profilerBanners(input: BannerInput): ProfilerBanner[] {
  const out: ProfilerBanner[] = [];
  const { source, error } = input;
  if (error) {
    if (error.code === "wireMismatch") {
      out.push({ id: "wireMismatch", severity: "error", text: `Can't open ${input.fileName ?? "this capture"}: ${error.message}` });
    } else {
      out.push({ id: "error", severity: "error", text: `Can't open ${input.fileName ?? "this capture"}: ${error.code}: ${error.message}` });
    }
  }
  if (source) {
    if (source.truncated) out.push({ id: "truncated", severity: "warn", text: BANNER_TEXT.truncated });
    if (source.summary.header.flags & CAPTURE_FLAG_MAIN_SIDE_ONLY) out.push({ id: "babylon", severity: "warn", text: BANNER_TEXT.babylon });
    if (!source.live && input.projectAudio !== undefined && !sameAudioSettings(source.summary.meta.audio, input.projectAudio)) {
      out.push({ id: "projectMismatch", severity: "warn", text: BANNER_TEXT.projectMismatch });
    }
    if (!source.live) out.push({ id: "viewing", severity: "info", text: BANNER_TEXT.viewing });
  }
  return out;
}

// ---- the controller ---------------------------------------------------------------------------------------------------

/** Everything the panel needs from outside. Defaults are `defaultProfilerDeps`; tests and W8 inject their own. */
export interface ProfilerDeps {
  /** `Audio.capture` (the recorder surface). */
  readonly capture: AudioCapture;
  /** Opens capture-file bytes (transferred) as a source. Default: `CaptureSource.openFile` (X2 may replace it). */
  openCapture(bytes: ArrayBuffer, signal?: AbortSignal): Promise<ProfileSource>;
  /** The open project's audio section, or undefined with no project. */
  projectAudio(): unknown;
  /** Rc4's `LiveHost`; null where the recorder is unavailable (no live follow). */
  readonly liveHost: LiveHost | null;
  /** Called once per STATUS block of the live ring (Rc4/Rc6 supply it); returns an unsubscribe. */
  onStatus?(cb: () => void): () => void;
  /** The track modules' factories (Pf3b-d). */
  readonly trackFactories: readonly TrackFactory[];
  /** The editor is in Play. */
  playing(): boolean;
  /** `LiveFollow` options for tests (the scheduler, the source's Worker). */
  readonly liveOptions?: Partial<ConstructorParameters<typeof LiveFollow>[0]>;
}

/** What the view renders from: a new object per change. */
export interface ProfilerView {
  readonly playing: boolean;
  readonly recording: AudioCapture["state"];
  readonly source: ProfileSource | null;
  readonly origin: "none" | "file" | "live";
  readonly fileName: string | null;
  readonly busy: "opening" | "saving" | null;
  readonly savedAs: string | null;
  readonly flowError: string | null;
  readonly banners: readonly ProfilerBanner[];
  /** The panel-level empty state, or null with a capture open. */
  readonly empty: string | null;
  readonly cursor: CursorSnapshot;
  readonly seek: CaptureSeekState | null;
  readonly live: LiveFollowModel | null;
  readonly tracks: TrackList;
  /** Bumped when the source or the track list is replaced: the canvas is rebuilt. */
  readonly sourceVersion: number;
}

/** What the canvas hears of the controller. */
export interface TimelineListener {
  dataChanged(): void;
  cursorChanged(): void;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A `CaptureError`'s message without the "<code> at <offset>: " its constructor prefixes (the banner shows the code itself). */
const plainMessage = (e: CaptureError): string => (e.message.startsWith(`${e.code} at ${e.offset}: `) ? e.message.slice(`${e.code} at ${e.offset}: `.length) : e.message);

export class ProfilerController {
  readonly cursor: CursorModel;
  private cur: ProfilerView;
  private modules: readonly TrackModule[] = [];
  private fileSource: ProfileSource | null = null;
  private liveSource: ProfileSource | null = null;
  private follow: LiveFollow | null = null;
  private unStatus: (() => void) | null = null;
  private listener: TimelineListener | null = null;
  private abort: AbortController | null = null;
  private openError: { code: string; message: string } | null = null;
  private seekRun = 0;
  private disposed = false;
  /** How many times `onChange` ran (the render-count tests read it). */
  changes = 0;

  constructor(
    private readonly deps: ProfilerDeps,
    private readonly onChange: (view: ProfilerView) => void = () => {},
  ) {
    this.cursor = new CursorModel({ live: false });
    this.cur = this.build({ origin: "none", source: null, version: 0 });
  }

  get view(): ProfilerView {
    return this.cur;
  }

  setTimelineListener(l: TimelineListener | null): void {
    this.listener = l;
  }

  /** The canvas's `data(trackId)`. */
  trackData(id: string): TrackData | undefined {
    return this.modules.find((m) => m.track.id === id)?.data();
  }

  /** The hover text of a track at `t`. */
  tooltip(id: string, t: number): string | null {
    return this.modules.find((m) => m.track.id === id)?.tooltipAt?.(t) ?? null;
  }

  duration(): number {
    const s = this.cur.source;
    return s ? s.duration : 0;
  }

  // ---- record, stop, save ----

  /** Record: `Audio.capture.start()`. A failure shows in the bar (the recorder's message). */
  async record(): Promise<void> {
    try {
      await this.deps.capture.start();
      this.patch({ flowError: null });
    } catch (e) {
      this.patch({ flowError: messageOf(e) });
    }
  }

  /** Stop: ends this panel's hold on the take (`Audio.capture.stop()`). */
  stop(): void {
    this.deps.capture.stop();
    this.patch({});
  }

  /** Save the take (`Audio.capture.save()`); resolves with where it went, or null when it failed (the message shows). */
  async save(name?: string): Promise<string | null> {
    this.patch({ busy: "saving", flowError: null, savedAs: null });
    try {
      const where = await this.deps.capture.save(name);
      this.patch({ busy: null, savedAs: where });
      return where;
    } catch (e) {
      this.patch({ busy: null, flowError: messageOf(e) });
      return null;
    }
  }

  // ---- open and drop ----

  /** Open capture bytes (a chosen or dropped file). A refusal leaves the previous capture open and shows its banner. */
  async openFile(name: string, bytes: ArrayBuffer): Promise<boolean> {
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    this.openError = null;
    this.patch({ busy: "opening", flowError: null, fileName: name });
    let source: ProfileSource;
    try {
      source = await this.deps.openCapture(bytes, abort.signal);
    } catch (e) {
      if (abort.signal.aborted && !this.disposed) return false; // a newer open owns the panel
      this.openError = e instanceof CaptureError ? { code: e.code, message: plainMessage(e) } : { code: "open", message: messageOf(e) };
      this.patch({ busy: null });
      return false;
    }
    if (abort.signal.aborted || this.disposed) {
      source.close();
      return false;
    }
    try {
      this.attach(source, "file");
    } catch (e) {
      source.close();
      this.openError = { code: "open", message: messageOf(e) };
      this.patch({ busy: null });
      return false;
    }
    this.patch({ busy: null });
    return true;
  }

  /** Cancel an open in progress. */
  cancelOpen(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.cur.busy === "opening") this.patch({ busy: null });
  }

  /** The Open file input or a drop: reads the file's bytes and opens them. */
  async openBlob(file: { readonly name: string; arrayBuffer(): Promise<ArrayBuffer> }): Promise<boolean> {
    let bytes: ArrayBuffer;
    try {
      bytes = await file.arrayBuffer();
    } catch (e) {
      this.openError = { code: "open", message: messageOf(e) };
      this.patch({ fileName: file.name });
      return false;
    }
    return this.openFile(file.name, bytes);
  }

  /** Close the open file capture (back to the live view in Play, or the empty state). */
  closeFile(): void {
    this.openError = null;
    this.fileSource?.close();
    this.fileSource = null;
    this.attachLiveOrNone();
  }

  // ---- live follow ----

  /** The editor entered or left Play: join the ring and follow it, or release it. */
  setPlaying(): void {
    const playing = this.deps.playing();
    if (playing && !this.follow && this.deps.liveHost) {
      this.follow = new LiveFollow({ host: this.deps.liveHost, onUpdate: (m) => this.onLive(m), ...this.deps.liveOptions });
      this.unStatus = this.deps.onStatus?.(() => this.follow?.notify()) ?? null;
      void this.follow.start();
    } else if (!playing && this.follow) {
      this.stopFollow();
      this.liveSource = null;
      if (this.cur.origin === "live") this.attachLiveOrNone();
    }
    this.patch({});
  }

  /** The panel closed: end the live hold, close the sources. */
  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
    this.stopFollow();
    this.fileSource?.close();
    this.fileSource = null;
  }

  private stopFollow(): void {
    this.unStatus?.();
    this.unStatus = null;
    this.follow?.stop();
    this.follow = null;
  }

  /** `LiveFollow`'s coalesced update: the one place a STATUS flow reaches the view. */
  private onLive(m: LiveFollowModel): void {
    if (this.disposed) return;
    const source = m.source;
    const first = source !== null && source !== this.liveSource;
    if (first) this.liveSource = source;
    if (first && !this.fileSource) {
      this.attach(source, "live", { live: m }); // one patch for the whole first update
    } else {
      if (source && !this.fileSource) {
        for (const mod of this.modules) void mod.refresh().then(() => this.listener?.dataChanged(), () => {});
        this.cursor.setDuration(source.duration);
      }
      this.patch({ live: m });
    }
    this.listener?.dataChanged();
    this.listener?.cursorChanged();
  }

  private attachLiveOrNone(): void {
    if (this.liveSource && this.follow) this.attach(this.liveSource, "live");
    else this.attach(null, "none");
  }

  // ---- the open capture ----

  private attach(source: ProfileSource | null, origin: "none" | "file" | "live", extra: Partial<ProfilerView> = {}): void {
    const prevFile = this.fileSource;
    const modules = source ? this.deps.trackFactories.flatMap((f) => f({ source, names: nameLookup(source.summary.names) })) : [];
    const tracks = new TrackList(modules.map((m) => m.track)); // throws on a duplicate id, before anything changed
    if (origin === "file") {
      if (prevFile && prevFile !== source) prevFile.close();
      this.fileSource = source;
    }
    this.modules = modules;
    this.cursor.setDuration(source ? source.duration : 0);
    if (source) {
      this.cursor.setTargets(cursorTargets({ ...emptyColumns() }, source.markers, source.startSeconds));
      void this.loadTargets(source);
    }
    if (origin === "live") this.cursor.goLive();
    else if (origin === "file") this.cursor.seekTo(0);
    this.patch({ ...extra, origin, source, tracks, version: this.cur.sourceVersion + 1, seek: null });
    void Promise.all(modules.map((m) => m.refresh())).then(() => this.listener?.dataChanged(), () => {});
  }

  private async loadTargets(source: ProfileSource): Promise<void> {
    try {
      const cols = await source.range(source.startSeconds, source.startSeconds + source.duration, CURSOR_COLUMNS);
      if (this.cur.source === source) this.cursor.setTargets(cursorTargets(cols, source.markers, source.startSeconds));
    } catch {
      // a closed source or a Worker that died: the jumps stay empty, the open itself already succeeded
    }
  }

  /** The cursor moved (a click, a drag, a step): the state at it, unless a newer move owns the answer. */
  async cursorMoved(): Promise<void> {
    const source = this.cur.source;
    this.listener?.cursorChanged();
    if (!source) return;
    const run = ++this.seekRun;
    try {
      const r = await seekAtCursor(source, this.cursor);
      if (run === this.seekRun && r && this.cur.source === source) this.patch({ seek: r.state });
    } catch (e) {
      if (run === this.seekRun) this.patch({ flowError: messageOf(e) });
    }
  }

  private build(p: { origin: ProfilerView["origin"]; source: ProfileSource | null; version: number }): ProfilerView {
    const playing = this.deps.playing();
    const source = p.source;
    return {
      playing,
      recording: this.deps.capture.state,
      source,
      origin: p.origin,
      fileName: null,
      busy: null,
      savedAs: null,
      flowError: null,
      banners: this.banners(source, null),
      empty: this.empty(source, playing),
      cursor: this.cursor.snapshot(),
      seek: null,
      live: null,
      tracks: new TrackList(),
      sourceVersion: p.version,
    };
  }

  private banners(source: ProfileSource | null, fileName: string | null): ProfilerBanner[] {
    return profilerBanners({ source, projectAudio: this.deps.projectAudio(), error: this.openError, fileName });
  }

  private empty(source: ProfileSource | null, playing: boolean): string | null {
    return chooseEmptyState("cpu", {
      playing,
      hasCapture: source !== null,
      mainSideOnly: source ? (source.summary.header.flags & CAPTURE_FLAG_MAIN_SIDE_ONLY) !== 0 : false,
      cpuLoadPermille: 0,
    });
  }

  private patch(p: Partial<Omit<ProfilerView, "banners" | "empty" | "cursor" | "playing" | "recording" | "sourceVersion">> & { version?: number }): void {
    const { version, ...rest } = p;
    const next = { ...this.cur, ...rest } as { -readonly [K in keyof ProfilerView]: ProfilerView[K] };
    next.sourceVersion = version ?? this.cur.sourceVersion;
    next.playing = this.deps.playing();
    next.recording = this.deps.capture.state;
    next.cursor = this.cursor.snapshot();
    next.banners = this.banners(next.source, next.fileName);
    next.empty = this.empty(next.source, next.playing);
    this.cur = next;
    this.changes++;
    this.onChange(next);
  }
}

function emptyColumns(): Record<string, Float64Array> {
  const out: Record<string, Float64Array> = { seconds: new Float64Array(0) };
  for (const c of CURSOR_COLUMNS) out[c] = new Float64Array(0);
  return out;
}

// ---- slots (H5) ---------------------------------------------------------------------------------------------------------

export interface TablesSlotProps {
  readonly source: ProfileSource;
  readonly cursor: CursorSnapshot;
  readonly seek: CaptureSeekState | null;
  readonly live: LiveFollowModel | null;
}
export interface BarSlotProps {
  readonly view: ProfilerView;
  readonly controller: ProfilerController;
}
export interface BannersSlotProps {
  readonly banners: readonly ProfilerBanner[];
}
export interface ProfilerSlots {
  tables: ComponentType<TablesSlotProps>;
  bar: ComponentType<BarSlotProps>;
  banners: ComponentType<BannersSlotProps>;
  onDropFile(controller: ProfilerController, file: { readonly name: string; arrayBuffer(): Promise<ArrayBuffer> }): void;
}

const TablesPlaceholder = () => <p class="profiler-placeholder">Voice and bus tables appear here.</p>;

function DefaultBanners({ banners }: BannersSlotProps) {
  return (
    <div class="profiler-banners" role="region" aria-label="Profiler notices">
      {banners.map((b) => (
        <p key={b.id} class="profiler-banner" data-banner={b.id} data-severity={b.severity} role={b.severity === "error" ? "alert" : "status"}>
          {b.text}
        </p>
      ))}
    </div>
  );
}

function DefaultBar({ view, controller }: BarSlotProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const recording = view.recording === "recording" || view.recording === "loading";
  return (
    <div class="profiler-bar" role="toolbar" aria-label="Capture">
      <button type="button" data-action="record" disabled={recording || view.busy !== null} onClick={() => void controller.record()}>
        Record
      </button>
      <button type="button" data-action="stop" disabled={view.recording !== "recording"} onClick={() => controller.stop()}>
        Stop
      </button>
      <button type="button" data-action="save" disabled={view.recording !== "stopped" && view.recording !== "recording" || view.busy !== null} onClick={() => void controller.save()}>
        Save
      </button>
      <button type="button" data-action="open" disabled={view.busy !== null} onClick={() => fileInput.current?.click()}>
        Open
      </button>
      {view.busy === "opening" ? (
        <button type="button" data-action="cancel" onClick={() => controller.cancelOpen()}>
          Cancel
        </button>
      ) : null}
      <input
        ref={fileInput}
        type="file"
        accept=".mycap"
        hidden
        aria-label="Open a capture file"
        onChange={(e) => {
          const input = e.currentTarget as HTMLInputElement;
          const f = input.files?.[0];
          input.value = "";
          if (f) profilerSlots.onDropFile(controller, f);
        }}
      />
      <span class="profiler-status" role="status">
        {view.busy === "saving" ? "Saving" : view.flowError ?? (view.savedAs ? `Saved ${view.savedAs}` : view.fileName && view.origin === "file" ? view.fileName : "")}
      </span>
    </div>
  );
}

/** The slots W8 fills (see the top of the file). */
export const profilerSlots: ProfilerSlots = {
  tables: TablesPlaceholder,
  bar: DefaultBar,
  banners: DefaultBanners,
  onDropFile: (controller, file) => void controller.openBlob(file),
};

// ---- defaults and the view ----------------------------------------------------------------------------------------------

/** Track factories Pf3b-d provide: they push theirs here from `mix/index.ts`, and the panel reads the list per capture. */
export const profilerTrackFactories: TrackFactory[] = [];

/** Rc4's live host and the STATUS subscription, set from `mix/index.ts` when they exist. */
export const profilerHost: { liveHost: LiveHost | null; onStatus?: (cb: () => void) => () => void } = { liveHost: null };

export function defaultProfilerDeps(): ProfilerDeps {
  return {
    capture: Audio.capture,
    openCapture: (bytes, signal) => CaptureSource.openFile(bytes, signal ? { signal } : {}),
    // `undefined` with no project open (no mismatch to report); an open project without the key reads as the defaults.
    projectAudio: () => {
      const p = editor.project.peek();
      return p ? ((p.settings as { audio?: unknown }).audio ?? null) : undefined;
    },
    liveHost: profilerHost.liveHost,
    ...(profilerHost.onStatus ? { onStatus: profilerHost.onStatus } : {}),
    trackFactories: profilerTrackFactories,
    playing: () => editor.scene.playState === "playing",
  };
}

/** The canvas over the controller's tracks. Preact never re-renders it for data: the controller tells the canvas. */
function Timeline({ controller, view }: { controller: ProfilerController; view: ProfilerView }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const timeline = useRef<TimelineCanvas | null>(null);
  const tracksHeight = view.tracks.tracks.filter((t) => t.visible).reduce((h, t) => h + t.height, 0);
  const height = RULER_HEIGHT + tracksHeight;
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !view.source) return;
    const width = Math.max(1, canvas.clientWidth || 600);
    const dpr = globalThis.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    const t = new TimelineCanvas({
      ctx,
      tracks: view.tracks,
      data: (id) => controller.trackData(id),
      duration: () => controller.duration(),
      readColors: () => readTimelineColors(cssVarReader(canvas)),
      width,
      height,
      dpr,
      onCursor: (time) => {
        controller.cursor.seekTo(time);
        void controller.cursorMoved();
      },
    });
    timeline.current = t;
    t.setCursor(controller.cursor.time);
    controller.setTimelineListener({
      dataChanged: () => t.dataChanged(),
      cursorChanged: () => t.setCursor(controller.cursor.time),
    });
    const stopTheme = theme.subscribe(() => t.themeChanged());
    const point = (e: PointerEvent) => ({ x: e.offsetX, y: e.offsetY, shiftKey: e.shiftKey });
    const down = (e: PointerEvent) => t.pointerDown(point(e));
    const move = (e: PointerEvent) => t.pointerMove(point(e));
    const up = (e: PointerEvent) => t.pointerUp(point(e));
    const cancel = () => t.pointerCancel();
    const wheel = (e: WheelEvent) => {
      if (t.wheel({ x: e.offsetX, deltaX: e.deltaX, deltaY: e.deltaY })) e.preventDefault();
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("wheel", wheel);
      stopTheme();
      controller.setTimelineListener(null);
      t.dispose();
      timeline.current = null;
    };
  }, [controller, view.sourceVersion, height]);
  return <canvas ref={ref} class="profiler-timeline" style={{ height: `${height}px` }} aria-label="Timeline" />;
}

/** The chrome as a pure function of the view: the tests walk this tree; the stateful wrapper below feeds it. */
export function ProfilerChrome({ controller, view, slots = profilerSlots }: { controller: ProfilerController; view: ProfilerView; slots?: ProfilerSlots }): ComponentChild {
  const Bar = slots.bar;
  const Banners = slots.banners;
  const Tables = slots.tables;
  return (
    <section
      class="profiler"
      aria-label="Audio Profiler"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = (e as DragEvent).dataTransfer?.files?.[0];
        if (f) slots.onDropFile(controller, f);
      }}
    >
      <Bar view={view} controller={controller} />
      <Banners banners={view.banners} />
      {view.source ? (
        <>
          <Timeline controller={controller} view={view} />
          <Tables source={view.source} cursor={view.cursor} seek={view.seek} live={view.live} />
        </>
      ) : (
        <p class="profiler-empty">{view.empty}</p>
      )}
    </section>
  );
}

/** The registered panel: owns a controller for its lifetime and re-renders on its changes only. */
export function ProfilerPanel() {
  const controller = useRef<ProfilerController | null>(null);
  const [view, setView] = useState<ProfilerView | null>(null);
  if (!controller.current) controller.current = new ProfilerController(defaultProfilerDeps(), (v) => setView(v));
  const c = controller.current;
  const playing = editor.scene.playState === "playing";
  useEffect(() => {
    c.setPlaying();
  }, [c, playing]);
  useEffect(() => () => c.dispose(), [c]);
  return <ProfilerChrome controller={c} view={view ?? c.view} />;
}
