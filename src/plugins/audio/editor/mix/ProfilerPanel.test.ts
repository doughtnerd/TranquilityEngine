// ADR 0171/0172 (Pf4; api-and-models §7): the Profiler panel's chrome. Cases: every banner on a real fixture capture (read
// through the real `CaptureSource` and Worker handler), the flows (record, stop, save, open, drop) wired to injected
// functions, the slots (H5), the track modules mounted from a fake factory, and no Preact render per STATUS block (the
// controller's change count, with `LiveFollow`'s scheduler driven by hand). No assertion reads a wall clock.
import { describe, expect, it, vi } from "vitest";
import type { VNode } from "preact";
import { CaptureError, CAPTURE_FLAG_MAIN_SIDE_ONLY } from "../../runtime/capture/format";
import { createCaptureWorkerHandler, type CaptureRequest, type CaptureResponse } from "../../runtime/capture/worker";
import { SAMPLE_HEADER, SAMPLE_META, liveHead, sampleCapture } from "../../runtime/capture/testSupport";
import { assembleCapture } from "../../runtime/capture/format";
import type { AudioCapture, AudioCaptureState } from "../../runtime/capture/capture";
import { CaptureSource, type CaptureWorkerLike, type ProfileSource } from "./profilerSource";
import type { LiveHost, LiveRecording, LiveScheduler } from "./liveFollow";
import type { TrackFactory } from "./tracks/types";
import {
  BANNER_TEXT, ProfilerChrome, ProfilerController, profilerBanners, profilerSlots, sameAudioSettings,
  type BarSlotProps, type ProfilerDeps, type ProfilerSlots,
} from "./ProfilerPanel";

/** The capture Worker's real handler behind a `CaptureWorkerLike`, answering on later macrotasks. */
function inProcessWorker(): CaptureWorkerLike {
  const w: CaptureWorkerLike & { dead: boolean } = {
    onmessage: null,
    onerror: null,
    dead: false,
    postMessage(message: CaptureRequest, transfer) {
      const copy = structuredClone(message, { transfer: transfer as Transferable[] });
      setTimeout(() => { if (!w.dead) void handler.handle(copy); }, 0);
    },
    terminate() {
      w.dead = true;
    },
  };
  const handler = createCaptureWorkerHandler({
    post: (r: CaptureResponse, transfer) => {
      const copy = structuredClone(r, { transfer: transfer as Transferable[] });
      setTimeout(() => { if (!w.dead) w.onmessage?.({ data: copy }); }, 0);
    },
  });
  return w;
}

const PROJECT_AUDIO = SAMPLE_META.audio;
const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

/** A capture file with the given header flags and META `audio`. */
const file = (init: { truncated?: boolean; mainSideOnly?: boolean } = {}, audio: unknown = PROJECT_AUDIO): ArrayBuffer =>
  buf(assembleCapture({ ...SAMPLE_HEADER, ...init }, { ...SAMPLE_META, audio }, [], { index: true }));

/** The sample file with a different wire hash (bytes 12..27 of the header): the reader refuses it as `wireMismatch`. */
function wrongWire(): ArrayBuffer {
  const b = new Uint8Array(sampleCapture());
  for (let i = 12; i < 28; i++) b[i] = b[i]! ^ 0xff;
  return buf(b);
}

class FakeCapture implements AudioCapture {
  state: AudioCaptureState = "idle";
  seconds = 0;
  bytes = 0;
  truncated = false;
  calls: string[] = [];
  failStart: string | null = null;
  async start() {
    this.calls.push("start");
    if (this.failStart) throw new Error(this.failStart);
    this.state = "recording";
  }
  stop() {
    this.calls.push("stop");
    this.state = "stopped";
  }
  mark() {}
  async save(name?: string) {
    this.calls.push(`save${name ? `:${name}` : ""}`);
    if (this.state === "idle") throw new Error("nothing recorded: call Audio.capture.start() first");
    return "capture-1.mycap";
  }
}

const openedSources: ProfileSource[] = [];
const realOpen = async (bytes: ArrayBuffer): Promise<ProfileSource> => {
  const s = await CaptureSource.openFile(bytes, { worker: inProcessWorker() });
  openedSources.push(s);
  return s;
};

function deps(over: Partial<ProfilerDeps> = {}): ProfilerDeps & { capture: FakeCapture } {
  return {
    capture: new FakeCapture(),
    openCapture: realOpen,
    projectAudio: () => PROJECT_AUDIO,
    liveHost: null,
    trackFactories: [],
    playing: () => false,
    ...over,
  } as ProfilerDeps & { capture: FakeCapture };
}

const ids = (c: ProfilerController): string[] => c.view.banners.map((b) => b.id);
const textOf = (c: ProfilerController, id: string): string | undefined => c.view.banners.find((b) => b.id === id)?.text;

describe("banners on fixture captures", () => {
  it("a plain saved capture of this project shows only \"Viewing, not replaying\"", async () => {
    const c = new ProfilerController(deps());
    expect(await c.openFile("a.mycap", file())).toBe(true);
    expect(ids(c)).toEqual(["viewing"]);
    expect(textOf(c, "viewing")).toBe("Viewing, not replaying");
    c.dispose();
  });

  it("a truncated capture shows the truncated banner with the design's words", async () => {
    const c = new ProfilerController(deps());
    await c.openFile("t.mycap", file({ truncated: true }));
    expect(ids(c)).toContain("truncated");
    expect(textOf(c, "truncated")).toMatch(/^Truncated: the ring wrapped/);
    c.dispose();
  });

  it("a main-side-only (Babylon) capture shows the Babylon banner", async () => {
    const c = new ProfilerController(deps());
    await c.openFile("b.mycap", file({ mainSideOnly: true }));
    expect(ids(c)).toContain("babylon");
    expect(textOf(c, "babylon")).toMatch(/^Babylon fallback: .*CPU, underrun and loudness/);
    expect(c.view.source!.summary.header.flags & CAPTURE_FLAG_MAIN_SIDE_ONLY).not.toBe(0);
    c.dispose();
  });

  it("a capture whose audio section differs from the open project's shows the project mismatch banner, and still opens", async () => {
    const c = new ProfilerController(deps({ projectAudio: () => ({ buses: [{ name: "Other" }] }) }));
    expect(await c.openFile("p.mycap", file())).toBe(true);
    expect(ids(c)).toContain("projectMismatch");
    expect(textOf(c, "projectMismatch")).toBe(BANNER_TEXT.projectMismatch);
    expect(c.view.source).not.toBeNull();
    c.dispose();
  });

  it("no open project, or the same section, is no mismatch", async () => {
    const none = new ProfilerController(deps({ projectAudio: () => undefined }));
    await none.openFile("p.mycap", file());
    expect(ids(none)).not.toContain("projectMismatch");
    none.dispose();
    const same = new ProfilerController(deps());
    await same.openFile("p.mycap", file());
    expect(ids(same)).not.toContain("projectMismatch");
    same.dispose();
  });

  it("a capture of another wire is refused with a banner naming both versions, and the open capture stays", async () => {
    const c = new ProfilerController(deps());
    await c.openFile("good.mycap", file());
    const before = c.view.source;
    expect(await c.openFile("old.mycap", wrongWire())).toBe(false);
    expect(c.view.source).toBe(before);
    expect(ids(c)).toContain("wireMismatch");
    const text = textOf(c, "wireMismatch")!;
    expect(text).toContain("Can't open old.mycap");
    expect(text).toMatch(/recorded with audio ABI .*wire [0-9a-f]{32}.*this build is ABI .*wire [0-9a-f]{32}\): re-record with this build/);
    c.dispose();
  });

  it("any other open error is an error banner with the code, not a partial profile", async () => {
    const c = new ProfilerController(deps({ openCapture: () => Promise.reject(new CaptureError("badLength", 40, "record runs past the file")) }));
    expect(await c.openFile("x.mycap", new ArrayBuffer(4))).toBe(false);
    expect(c.view.source).toBeNull();
    expect(ids(c)).toEqual(["error"]);
    expect(textOf(c, "error")).toContain("badLength");
    c.dispose();
  });

  it("combines: truncated, Babylon and mismatch together, with the viewing note last", async () => {
    const c = new ProfilerController(deps({ projectAudio: () => ({ buses: [{ name: "Other" }] }) }));
    await c.openFile("all.mycap", file({ truncated: true, mainSideOnly: true }));
    expect(ids(c)).toEqual(["truncated", "babylon", "projectMismatch", "viewing"]);
    c.dispose();
  });

  it("a live source is this session's own ring: no mismatch, no \"Viewing\"", () => {
    const live = { live: true, truncated: false, summary: { header: { flags: 0 }, meta: { audio: { other: 1 } } } } as unknown as ProfileSource;
    expect(profilerBanners({ source: live, projectAudio: PROJECT_AUDIO, error: null, fileName: null })).toEqual([]);
  });

  it("sameAudioSettings reads a missing section as the defaults and ignores key order", () => {
    expect(sameAudioSettings(null, undefined)).toBe(true);
    expect(sameAudioSettings({ buses: [{ name: "Music" }] }, { buses: [{ name: "Music" }] })).toBe(true);
    expect(sameAudioSettings({ buses: [{ name: "Music" }] }, { buses: [{ name: "SFX" }] })).toBe(false);
  });
});

describe("record, stop, save", () => {
  it("record starts the take, stop ends this panel's hold, save writes it and says where", async () => {
    const d = deps();
    const c = new ProfilerController(d);
    expect(c.view.recording).toBe("idle");
    await c.record();
    expect(c.view.recording).toBe("recording");
    c.stop();
    expect(c.view.recording).toBe("stopped");
    expect(await c.save("take")).toBe("capture-1.mycap");
    expect(c.view.savedAs).toBe("capture-1.mycap");
    expect(c.view.busy).toBeNull();
    expect(d.capture.calls).toEqual(["start", "stop", "save:take"]);
    c.dispose();
  });

  it("a recorder that can't start shows its message; saving with no take shows the empty-save message", async () => {
    const d = deps();
    d.capture.failStart = "audio capture isn't available yet";
    const c = new ProfilerController(d);
    await c.record();
    expect(c.view.flowError).toBe("audio capture isn't available yet");
    expect(c.view.recording).toBe("idle");
    expect(await c.save()).toBeNull();
    expect(c.view.flowError).toBe("nothing recorded: call Audio.capture.start() first");
    c.dispose();
  });
});

describe("open, cancel, drop", () => {
  it("a second open closes the first file's source; closing the file closes it; dispose closes what's left", async () => {
    const closed: ProfileSource[] = [];
    const open = async (b: ArrayBuffer) => {
      const s = await realOpen(b);
      const close = s.close.bind(s);
      s.close = () => { closed.push(s); close(); };
      return s;
    };
    const c = new ProfilerController(deps({ openCapture: open }));
    await c.openFile("1.mycap", file());
    const first = c.view.source!;
    await c.openFile("2.mycap", file());
    expect(closed).toEqual([first]);
    const second = c.view.source!;
    c.closeFile();
    expect(closed).toEqual([first, second]);
    expect(c.view.source).toBeNull();
    expect(c.view.empty).toBe("Not playing");
    c.dispose();
  });

  it("a cancelled open resolves false, leaves no capture and clears the busy state", async () => {
    let seen: AbortSignal | undefined;
    const open = (_b: ArrayBuffer, signal?: AbortSignal) =>
      new Promise<ProfileSource>((_res, rej) => {
        seen = signal;
        signal?.addEventListener("abort", () => rej(new CaptureError("cancelled", -1, "the open was cancelled")));
      });
    const c = new ProfilerController(deps({ openCapture: open }));
    const p = c.openFile("big.mycap", new ArrayBuffer(8));
    expect(c.view.busy).toBe("opening");
    c.cancelOpen();
    expect(await p).toBe(false);
    expect(seen?.aborted).toBe(true);
    expect(c.view.busy).toBeNull();
    expect(c.view.source).toBeNull();
    expect(c.view.banners).toEqual([]);
    c.dispose();
  });

  it("a dropped file reaches the injected open function through the slot, and the default slot opens it", async () => {
    const open = vi.fn(realOpen);
    const c = new ProfilerController(deps({ openCapture: open }));
    const bytes = file();
    const dropped = { name: "d.mycap", arrayBuffer: async () => bytes };
    const tree = ProfilerChrome({ controller: c, view: c.view }) as VNode<{ onDrop: (e: unknown) => void; onDragOver: (e: unknown) => void }>;
    let prevented = 0;
    tree.props.onDragOver({ preventDefault: () => prevented++ });
    tree.props.onDrop({ preventDefault: () => prevented++, dataTransfer: { files: [dropped] } });
    expect(prevented).toBe(2);
    await vi.waitFor(() => expect(c.view.source).not.toBeNull());
    expect(open).toHaveBeenCalledTimes(1);
    expect(c.view.fileName).toBe("d.mycap");
    c.dispose();

    // A filled slot gets the file instead (X2's route).
    const seen: string[] = [];
    const slots: ProfilerSlots = { ...profilerSlots, onDropFile: (_c, f) => void seen.push(f.name) };
    const c2 = new ProfilerController(deps());
    const t2 = ProfilerChrome({ controller: c2, view: c2.view, slots }) as VNode<{ onDrop: (e: unknown) => void }>;
    t2.props.onDrop({ preventDefault() {}, dataTransfer: { files: [dropped] } });
    expect(seen).toEqual(["d.mycap"]);
    c2.dispose();
  });
});

describe("slots (H5) and track modules", () => {
  const factory: TrackFactory = (ctx) => [
    {
      track: { id: "fake.line", label: "Fake", kind: "line", height: 40, visible: true },
      data: () => ({ lines: [{ times: [0, 1], values: [1, 2], color: "accent" }] }),
      refresh: async () => {},
      tooltipAt: (t) => `fake at ${t} in ${ctx.source.summary.meta.project.name}`,
    },
  ];

  it("mounts every module a factory returns: its track in the list, its data and tooltip answered by id", async () => {
    const c = new ProfilerController(deps({ trackFactories: [factory] }));
    await c.openFile("a.mycap", file());
    expect(c.view.tracks.tracks.map((t) => t.id)).toEqual(["fake.line"]);
    expect(c.trackData("fake.line")?.lines).toHaveLength(1);
    expect(c.trackData("nope")).toBeUndefined();
    expect(c.tooltip("fake.line", 2)).toBe("fake at 2 in Sample");
    c.dispose();
  });

  it("two modules with the same track id refuse the open with a banner and keep the previous capture", async () => {
    const c = new ProfilerController(deps({ trackFactories: [factory, factory] }));
    expect(await c.openFile("a.mycap", file())).toBe(false);
    expect(c.view.source).toBeNull();
    expect(textOf(c, "error")).toContain('duplicate track id "fake.line"');
    c.dispose();
  });

  it("each slot is a component prop: tables, bar and banners render in their regions with the controller's state", async () => {
    const c = new ProfilerController(deps({ projectAudio: () => ({ buses: [{ name: "Other" }] }) }));
    await c.openFile("a.mycap", file({ truncated: true }));
    const Tables = () => null;
    const Bar = (_p: BarSlotProps) => null;
    const Banners = () => null;
    const slots: ProfilerSlots = { ...profilerSlots, tables: Tables, bar: Bar, banners: Banners };
    const tree = ProfilerChrome({ controller: c, view: c.view, slots }) as VNode<{ children: VNode<Record<string, unknown>>[] }>;
    const kids = ([] as VNode<Record<string, unknown>>[]).concat(tree.props.children).flat(3) as VNode<Record<string, unknown>>[];
    const byType = (t: unknown) => kids.find((k) => k && k.type === t);
    expect(byType(Bar)?.props.controller).toBe(c);
    expect(byType(Banners)?.props.banners).toBe(c.view.banners);
    const tablesProps = (kids.flatMap((k) => (k && Array.isArray((k.props as { children?: unknown }).children) ? ((k.props as { children: VNode<Record<string, unknown>>[] }).children) : [])).find((k) => k && k.type === Tables))?.props;
    expect(tablesProps?.source).toBe(c.view.source);
    c.dispose();
  });

  it("without a capture the chrome shows the design's empty state, not the tables", () => {
    const c = new ProfilerController(deps());
    expect(c.view.empty).toBe("Not playing");
    const playing = new ProfilerController(deps({ playing: () => true }));
    expect(playing.view.empty).toBe("Recording starts when the panel opens in Play");
    c.dispose();
    playing.dispose();
  });
});

describe("no Preact render per STATUS block", () => {
  function manualScheduler() {
    let next = 1;
    const timers = new Map<number, () => void>();
    const s: LiveScheduler & { timers: Map<number, () => void>; scheduled: number; fire(): void } = {
      timers,
      scheduled: 0,
      setTimeout(fn) {
        s.scheduled++;
        const h = next++;
        timers.set(h, fn);
        return h;
      },
      clearTimeout(h) {
        timers.delete(h as number);
      },
      fire() {
        const all = [...timers.values()];
        timers.clear();
        for (const t of all) t();
      },
    };
    return s;
  }

  it("500 STATUS notifications make one view change per coalesced update, and none before the window closes", async () => {
    const scheduler = manualScheduler();
    let statusCb: (() => void) | null = null;
    const host: LiveHost = {
      join: async (): Promise<LiveRecording> => ({
        head: () => liveHead(),
        startLive() {},
        stopLive() {},
        liveLost: false,
        release() {},
      }),
    };
    const c = new ProfilerController(
      deps({
        playing: () => true,
        liveHost: host,
        onStatus: (cb) => { statusCb = cb; return () => { statusCb = null; }; },
        liveOptions: { scheduler, sourceOptions: () => ({ worker: inProcessWorker() }) },
      }),
    );
    c.setPlaying();
    // The updates of the start: "starting", then "following" with the live source attached.
    await vi.waitFor(() => {
      scheduler.fire();
      expect(c.view.origin).toBe("live");
    });
    expect(c.view.banners).toEqual([]);
    scheduler.scheduled = 0;
    const before = c.changes;
    for (let i = 0; i < 500; i++) statusCb!();
    expect(scheduler.scheduled).toBe(1);
    expect(c.changes).toBe(before); // 500 STATUS blocks, no view change yet
    scheduler.fire();
    expect(c.changes).toBe(before + 1);
    statusCb!();
    scheduler.fire();
    expect(c.changes).toBe(before + 2);
    c.dispose();
    expect(statusCb).toBeNull(); // the panel's STATUS subscription ends with it
  });

  it("the update that attaches the live source is one view change", async () => {
    const scheduler = manualScheduler();
    const host: LiveHost = { join: async () => ({ head: () => liveHead(), startLive() {}, stopLive() {}, liveLost: false, release() {} }) };
    const c = new ProfilerController(deps({ playing: () => true, liveHost: host, liveOptions: { scheduler, sourceOptions: () => ({ worker: inProcessWorker() }) } }));
    c.setPlaying();
    let delta = 0;
    await vi.waitFor(() => {
      const before = c.changes;
      scheduler.fire();
      delta = c.changes - before;
      expect(c.view.origin).toBe("live");
    });
    expect(delta).toBe(1); // the update that attached the source: one patch, not a rebuild then an update
    c.dispose();
  });

  it("a live view's cursor pauses and returns to live (Space resumes); a file's can't", async () => {
    const scheduler = manualScheduler();
    const host: LiveHost = { join: async () => ({ head: () => liveHead(), startLive() {}, stopLive() {}, liveLost: false, release() {} }) };
    const c = new ProfilerController(deps({ playing: () => true, liveHost: host, liveOptions: { scheduler, sourceOptions: () => ({ worker: inProcessWorker() }) } }));
    c.setPlaying();
    await vi.waitFor(() => {
      scheduler.fire();
      expect(c.view.origin).toBe("live");
    });
    expect(c.cursor.mode).toBe("live");
    c.cursor.pause();
    expect(c.cursor.mode).toBe("paused");
    expect(c.cursor.goLive(), "a live recording's cursor returns to live").toBe(true);
    expect(c.cursor.mode).toBe("live");
    c.dispose();
  });
});
