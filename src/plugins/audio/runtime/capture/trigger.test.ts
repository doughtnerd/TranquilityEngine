// ADR 0171 amended by 0172 (M5a, task X1; owner decision 7): the built-in capture trigger of an exported game. F9 starts a take
// and the next F9 stops and saves it; a one-second hold of exactly three fingers does the same; a toast says what happened; the
// web stops at 16 saves per page session with a message and a Tauri save rotates through Rc4's `rotateCaptures`; with no
// install there is no listener, and a game that installs it but never presses loads no recorder. Key and touch events are
// fakes, the hold is a manual scheduler (no wall clock) and recording runs on the STATUS frames a test feeds.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Audio } from "../Audio";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, type FakeBackend } from "../testing";
import { _setRecorderLoader, _setSaveEnv, releaseCapture, type RecorderModule } from "./capture";
import { CAPTURE_TRIGGER_MAX_FILES } from "./format";
import { _resetSaveState, deflateRawCompress, type SaveEnv } from "./save";
import { keyframeCodecForTests, statusBytes } from "./testSupport";
import { TOAST_RECORDING, TRIGGER_HOLD_MS, installCaptureTrigger, savedName, toastCap, toastSaved, type TriggerEnv } from "./trigger";

const RATE = 48_000;
const BLOCK = 768;
const MiB = 1024 * 1024;

/** A target that records its listeners and delivers fake events to them. */
function fakeTarget() {
  const listeners = new Map<string, Set<(e: Event) => void>>();
  return {
    listeners,
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn as (e: Event) => void),
    removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => void listeners.get(type)?.delete(fn as (e: Event) => void),
    fire(type: string, event: object): void {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event as Event);
    },
  };
}

/** A manual scheduler: nothing runs until `run()`, which fires what hasn't been cancelled and reports the delay it was asked for. */
function manualSchedule() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  return {
    schedule: ((fn: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return () => void pending.delete(id);
    }) as TriggerEnv["schedule"],
    pending: () => [...pending.values()].map((p) => p.ms),
    run(): void {
      for (const [id, p] of [...pending]) {
        pending.delete(id);
        p.fn();
      }
    },
  };
}

const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, preventDefault: vi.fn(), ...extra });
const touches = (n: number) => ({ touches: { length: n } });

/** A fake `Audio.capture` with the real states, so the trigger's decisions can be read from the calls it makes. */
function fakeCapture() {
  const calls: string[] = [];
  const cap = {
    state: "idle" as "idle" | "loading" | "recording" | "stopped",
    startError: null as Error | null,
    saveError: null as Error | null,
    saved: "capture-20261113-101500.mycap",
    async start() {
      calls.push("start");
      if (cap.startError) throw cap.startError;
      cap.state = "recording";
    },
    stop() {
      calls.push("stop");
      cap.state = "stopped";
    },
    async save(name?: string) {
      calls.push(name === undefined ? "save" : `save:${name}`);
      if (cap.saveError) throw cap.saveError;
      return cap.saved;
    },
  };
  return { cap, calls };
}

function rigFake(over: Partial<TriggerEnv> = {}) {
  const target = fakeTarget();
  const clock = manualSchedule();
  const { cap, calls } = fakeCapture();
  const toasts: string[] = [];
  const uninstall = installCaptureTrigger({ capture: cap, target, schedule: clock.schedule, toast: (t) => void toasts.push(t), tauri: false, webSaves: async () => ({ count: 0, max: CAPTURE_TRIGGER_MAX_FILES }), ...over });
  const press = async (k = "F9", extra: Record<string, unknown> = {}) => {
    const e = key(k, extra);
    target.fire("keydown", e);
    await new Promise((resolve) => setTimeout(resolve, 0)); // the press settles on microtasks; one macrotask later it is done
    return e;
  };
  return { target, clock, cap, calls, toasts, uninstall, press };
}

describe("F9", () => {
  it("starts a take, then stops it and saves it, with a toast for each", async () => {
    const r = rigFake();
    const first = await r.press();
    expect(first.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(r.calls).toEqual(["start"]));
    expect(r.toasts).toEqual([TOAST_RECORDING]);
    await r.press();
    await vi.waitFor(() => expect(r.calls).toEqual(["start", "stop", "save"]));
    expect(r.toasts).toEqual([TOAST_RECORDING, toastSaved("capture-20261113-101500.mycap")]);
    expect(r.cap.state).toBe("stopped");
    await r.press(); // a stopped take: F9 begins the next one
    await vi.waitFor(() => expect(r.calls).toEqual(["start", "stop", "save", "start"]));
  });

  it("saves unnamed (the auto name, the one that rotates)", async () => {
    const r = rigFake();
    await r.press();
    await r.press();
    await vi.waitFor(() => expect(r.calls).toContain("save"));
    expect(r.calls.some((c) => c.startsWith("save:"))).toBe(false);
  });

  it("ignores other keys, a held key's repeats and any modifier", async () => {
    const r = rigFake();
    await r.press("F8");
    await r.press("f9x");
    await r.press("F9", { repeat: true });
    await r.press("F9", { ctrlKey: true });
    await r.press("F9", { altKey: true });
    await r.press("F9", { metaKey: true });
    await r.press("F9", { shiftKey: true });
    expect(r.calls).toEqual([]);
    expect(r.toasts).toEqual([]);
  });

  it("says why a start or a save failed, in the failure's own words", async () => {
    const r = rigFake();
    r.cap.startError = new Error("the audio core isn't available");
    await r.press();
    await vi.waitFor(() => expect(r.toasts).toEqual([TOAST_RECORDING, "the audio core isn't available"]));
    r.cap.startError = null;
    r.cap.state = "recording";
    r.cap.saveError = new Error("disk full");
    await r.press();
    await vi.waitFor(() => expect(r.toasts.at(-1)).toBe("disk full"));
  });

  it("a second press while the first is still working does nothing", async () => {
    let release: () => void = () => {};
    const r = rigFake();
    r.cap.start = async () => {
      r.calls.push("start");
      await new Promise<void>((resolve) => (release = resolve));
      r.cap.state = "recording";
    };
    r.target.fire("keydown", key("F9"));
    r.target.fire("keydown", key("F9"));
    await vi.waitFor(() => expect(r.calls).toEqual(["start"]));
    release();
    await vi.waitFor(() => expect(r.cap.state).toBe("recording"));
    expect(r.calls).toEqual(["start"]);
  });
});

describe("the three-finger hold", () => {
  it("starts and then stops and saves, after exactly TRIGGER_HOLD_MS with three fingers down", async () => {
    const r = rigFake();
    r.target.fire("touchstart", touches(1));
    r.target.fire("touchstart", touches(2));
    expect(r.clock.pending(), "two fingers arm nothing").toEqual([]);
    r.target.fire("touchstart", touches(3));
    expect(r.clock.pending()).toEqual([TRIGGER_HOLD_MS]);
    expect(TRIGGER_HOLD_MS).toBe(1000);
    expect(r.calls).toEqual([]);
    r.clock.run();
    await vi.waitFor(() => expect(r.calls).toEqual(["start"]));
    expect(r.toasts).toEqual([TOAST_RECORDING]);
    r.target.fire("touchend", touches(0));
    r.target.fire("touchstart", touches(3));
    r.clock.run();
    await vi.waitFor(() => expect(r.calls).toEqual(["start", "stop", "save"]));
    expect(r.toasts.at(-1)).toBe(toastSaved("capture-20261113-101500.mycap"));
  });

  it("a two-finger hold does nothing, however long", () => {
    const r = rigFake();
    r.target.fire("touchstart", touches(1));
    r.target.fire("touchstart", touches(2));
    r.clock.run();
    expect(r.calls).toEqual([]);
    expect(r.toasts).toEqual([]);
  });

  it("a short hold does nothing: a finger lifted (or a fourth added) before the second is up cancels it", () => {
    const r = rigFake();
    r.target.fire("touchstart", touches(3));
    r.target.fire("touchend", touches(2));
    expect(r.clock.pending()).toEqual([]);
    r.clock.run();
    r.target.fire("touchstart", touches(3));
    r.target.fire("touchstart", touches(4));
    expect(r.clock.pending()).toEqual([]);
    r.target.fire("touchstart", touches(3));
    r.target.fire("touchcancel", touches(0));
    expect(r.clock.pending()).toEqual([]);
    r.clock.run();
    expect(r.calls).toEqual([]);
  });

  it("one hold fires once: it can't fire again until the fingers drop below three", async () => {
    const r = rigFake();
    r.target.fire("touchstart", touches(3));
    r.clock.run();
    await vi.waitFor(() => expect(r.calls).toEqual(["start"]));
    r.target.fire("touchstart", touches(4));
    r.target.fire("touchend", touches(3)); // back to three, still the same hold
    expect(r.clock.pending()).toEqual([]);
    r.target.fire("touchend", touches(2));
    r.target.fire("touchstart", touches(3));
    expect(r.clock.pending()).toEqual([TRIGGER_HOLD_MS]);
  });
});

describe("the web's cap of 16", () => {
  it("refuses to start at the cap, with its message, and starts one below it", async () => {
    let count = CAPTURE_TRIGGER_MAX_FILES - 1;
    const r = rigFake({ webSaves: async () => ({ count, max: CAPTURE_TRIGGER_MAX_FILES }) });
    await r.press();
    await vi.waitFor(() => expect(r.calls).toEqual(["start"]));
    r.cap.state = "stopped";
    count = CAPTURE_TRIGGER_MAX_FILES;
    r.toasts.length = 0;
    await r.press();
    await vi.waitFor(() => expect(r.toasts).toEqual([toastCap(CAPTURE_TRIGGER_MAX_FILES)]));
    expect(r.calls).toEqual(["start"]);
    expect(toastCap(16)).toMatch(/16 captures/);
    expect(toastCap(16)).toMatch(/Reload/);
  });

  it("a Tauri trigger has no cap: files rotate instead", async () => {
    const r = rigFake({ tauri: true, webSaves: async () => ({ count: 99, max: CAPTURE_TRIGGER_MAX_FILES }) });
    await r.press();
    await vi.waitFor(() => expect(r.calls).toEqual(["start"]));
  });

  it("the toast shows a Tauri path as the capture's own file name", () => {
    expect(savedName("capture-20261113-101500.mycap")).toBe("capture-20261113-101500.mycap");
    expect(savedName("/data/app/cache/capture-20261113-101500.mycap.bin")).toBe("capture-20261113-101500.mycap");
    expect(savedName("C:\\Users\\a\\AppData\\cache\\capture-20261113-101500-2.mycap.bin")).toBe("capture-20261113-101500-2.mycap");
  });
});

describe("nothing is installed without the option", () => {
  it("installs listeners only when asked, and uninstall removes every one", () => {
    const target = fakeTarget();
    expect(target.count()).toBe(0); // the player never calls install when game.json has no audioCapture
    const off = installCaptureTrigger({ target, toast: () => {}, tauri: false });
    expect([...target.listeners.keys()].sort()).toEqual(["keydown", "touchcancel", "touchend", "touchstart"]);
    off();
    expect(target.count()).toBe(0);
  });

  it("uninstalling cancels a hold under way", () => {
    const target = fakeTarget();
    const clock = manualSchedule();
    const off = installCaptureTrigger({ target, schedule: clock.schedule, toast: () => {}, tauri: false });
    target.fire("touchstart", touches(3));
    expect(clock.pending()).toEqual([TRIGGER_HOLD_MS]);
    off();
    expect(clock.pending()).toEqual([]);
  });

  it("the player imports the trigger only under the manifest's flag, and the trigger reaches the chunk only by import()", () => {
    const player = readFileSync(join(__dirname, "../../../../player/main.ts"), "utf8");
    expect(player).toMatch(/if \(manifest\.audioCapture\) \(await import\("\.\.\/plugins\/audio\/runtime\/capture\/trigger"\)\)\.installCaptureTrigger\(\)/);
    expect(player).not.toMatch(/^import[^;]*capture\/trigger/m);
    const trigger = readFileSync(join(__dirname, "trigger.ts"), "utf8");
    const staticValueImports = trigger.split("\n").filter((l) => /^\s*(import|export)\b(?!\s+type\b)/.test(l) && /from\s+["']\.\/(recorder|events|save|ring|format|reader|worker)["']/.test(l));
    expect(staticValueImports).toEqual([]);
    expect(trigger).toMatch(/import\("\.\/save"\)/);
    expect(trigger).not.toMatch(/from\s+["'][^"']*\/editor\//); // the editor has the Profiler panel
  });
});

// --- against the real Audio.capture: the recorder chunk, the save and the rotation ------------------------------------------------

function realRig(opts: { tauri?: boolean; existing?: string[] } = {}) {
  const fb = makeFakeBackend() as FakeBackend & { frame: number };
  fb.frame = 0;
  const baseDebug = fb.debug.bind(fb);
  fb.debug = () => {
    const d = baseDebug();
    return { ...d, time: fb.frame / RATE, sampleRate: RATE, core: { ...d.core, currentFrame: fb.frame } };
  };
  setAudioBackend(fb);
  const loads = vi.fn(async (): Promise<RecorderModule> => {
    const m = await import("./recorder");
    return { ...m, createRecorder: (o) => m.createRecorder({ ringBytes: 4 * MiB, codec: keyframeCodecForTests(), ...o }) };
  });
  _setRecorderLoader(loads);
  const downloads: string[] = [];
  const stored = new Set(opts.existing ?? []);
  const deleted: string[] = [];
  const env: SaveEnv = {
    tauri: opts.tauri ?? false,
    storage: {
      save: async (key) => void stored.add(key),
      list: async () => [...stored],
      delete: async (key) => {
        stored.delete(key);
        deleted.push(key);
      },
    },
    appDataDir: async () => "/data/app",
    download: (_bytes, fileName) => void downloads.push(fileName),
    compress: deflateRawCompress,
    now: () => new Date(2026, 10, 13, 10, 15, 0),
  };
  _setSaveEnv(env);
  const feed = (n: number): void => {
    for (let k = 0; k < n; k++) {
      fb.frame += BLOCK;
      const block = statusBytes(fb.frame);
      const data = block.slice().buffer as ArrayBuffer;
      fb.recorderTap?.(data, block.byteLength, new DataView(data));
    }
  };
  return { fb, loads, downloads, stored, deleted, feed };
}

describe("against the real Audio.capture", () => {
  let loader: (() => Promise<RecorderModule>) | null = null;
  beforeEach(() => _resetSaveState());
  afterEach(() => {
    releaseCapture();
    if (loader) _setRecorderLoader(loader);
    _setSaveEnv(null);
    setAudioBackend(null);
    vi.restoreAllMocks();
  });

  it("a game that installs the trigger but never presses loads no recorder", () => {
    const r = realRig();
    loader = r.loads;
    const target = fakeTarget();
    const off = installCaptureTrigger({ target, toast: () => {} });
    expect(r.loads).not.toHaveBeenCalled();
    expect(Audio.capture.state).toBe("idle");
    expect(r.fb.recorderTap).toBeNull();
    off();
  });

  it("F9, a second of audio, F9: one download, named and toasted", async () => {
    const r = realRig();
    loader = r.loads;
    const target = fakeTarget();
    const toasts: string[] = [];
    const off = installCaptureTrigger({ target, toast: (t) => void toasts.push(t) });
    target.fire("keydown", key("F9"));
    await vi.waitFor(() => expect(Audio.capture.state).toBe("recording"));
    expect(r.loads).toHaveBeenCalledTimes(1);
    r.feed(Math.ceil(RATE / BLOCK));
    target.fire("keydown", key("F9"));
    await vi.waitFor(() => expect(r.downloads).toEqual(["capture-20261113-101500.mycap"]));
    await vi.waitFor(() => expect(toasts).toEqual([TOAST_RECORDING, "Saved capture-20261113-101500.mycap"]));
    off();
  });

  it("the web stops at 16 downloads a page session, then says so and records nothing more", async () => {
    const r = realRig();
    loader = r.loads;
    const target = fakeTarget();
    const toasts: string[] = [];
    const off = installCaptureTrigger({ target, toast: (t) => void toasts.push(t) });
    for (let n = 1; n <= CAPTURE_TRIGGER_MAX_FILES; n++) {
      target.fire("keydown", key("F9"));
      await vi.waitFor(() => expect(Audio.capture.state).toBe("recording"));
      r.feed(4);
      target.fire("keydown", key("F9"));
      await vi.waitFor(() => expect(r.downloads.length).toBe(n));
      await vi.waitFor(() => expect(Audio.capture.state).toBe("stopped"));
      await vi.waitFor(() => expect(toasts.at(-1)).toMatch(/^Saved /));
    }
    expect(new Set(r.downloads).size, "no download overwrites another").toBe(16);
    toasts.length = 0;
    target.fire("keydown", key("F9"));
    await vi.waitFor(() => expect(toasts).toEqual([toastCap(CAPTURE_TRIGGER_MAX_FILES)]));
    expect(Audio.capture.state).toBe("stopped");
    expect(r.downloads.length).toBe(16);
    off();
  });

  it("on Tauri a save keeps the newest 16 auto-named files, through Rc4's rotateCaptures", async () => {
    const old = Array.from({ length: 17 }, (_, i) => `capture-20261101-1000${String(i).padStart(2, "0")}.mycap`);
    const r = realRig({ tauri: true, existing: old });
    loader = r.loads;
    const target = fakeTarget();
    const toasts: string[] = [];
    const off = installCaptureTrigger({ target, toast: (t) => void toasts.push(t), tauri: true });
    target.fire("keydown", key("F9"));
    await vi.waitFor(() => expect(Audio.capture.state).toBe("recording"));
    r.feed(4);
    target.fire("keydown", key("F9"));
    await vi.waitFor(() => expect(toasts.at(-1)).toBe("Saved capture-20261113-101500.mycap"));
    expect(r.stored.size).toBe(CAPTURE_TRIGGER_MAX_FILES);
    expect(r.deleted, "the two oldest, oldest first").toEqual([old[0], old[1]]);
    expect(r.stored.has("capture-20261113-101500.mycap")).toBe(true);
    off();
  });
});
