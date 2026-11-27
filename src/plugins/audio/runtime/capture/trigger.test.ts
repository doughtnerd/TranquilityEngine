// ADR 0171 amended by 0172 (M5a, task X1; owner decision 7): the built-in capture trigger of an exported game. F9 starts a take
// and the next F9 stops and saves it; a one-second hold of exactly three fingers does the same; a toast says what happened; the
// web stops at 16 saves per page session with a message and a Tauri save rotates through Rc4's `rotateCaptures`; with no
// install there is no listener, and a game that installs it but never presses loads no recorder. Key and touch events are
// fakes, the hold is a manual scheduler (no wall clock) and recording runs on the STATUS frames a test feeds.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Audio } from "../Audio";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, type FakeBackend } from "../testing";
import { releaseCapture } from "./capture";
import { CAPTURE_TRIGGER_MAX_FILES } from "./format";
import { defaultSaveEnv, webSaveCount, type SaveEnv } from "./save";
import { keyframeCodecForTests, statusBytes, type CaptureChunkControl } from "./testSupport";
import { createTakeOwnership } from "./takeOwnership";
import { installCaptureTrigger, installTakeTrigger, type TriggerEnv } from "./trigger";
import { takeStateSubscription } from "../debugLink/takeState";
import { decodeTakeState } from "../debugLink/schema";
import { RecordWriter, readRecords } from "../../../../engine/debugLink/records";
import type { DebugSubscription, DebugTopicHost } from "../../../../engine/debugLink/topics";
import { audioTopic } from "../debugLink/topic";

/** The recorder and save chunks are the real ones, wrapped: a 4 MiB ring, each save through the rig's fakes. */
const chunk = vi.hoisted((): CaptureChunkControl => ({ options: {}, recorders: [], saveEnv: null }));
vi.mock("./recorder", async (real) => (await import("./testSupport")).captureRecorderModule(await real(), chunk));
vi.mock("./save", async (real) => (await import("./testSupport")).captureSaveModule(await real(), chunk));

/** The trigger's toasts and hold, as a player sees them. */
const TOAST_RECORDING = "Recording audio…";
const toastSaved = (name: string): string => `Saved ${name}`;
const TOAST_CAP = "Capture limit reached: this page has saved 16 captures, and a browser can't delete downloads. Reload the page to record more.";
const TRIGGER_HOLD_MS = 1000;

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
    saved: "capture-20261113-101500.sporesample",
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
    expect(r.toasts).toEqual([TOAST_RECORDING, toastSaved("capture-20261113-101500.sporesample")]);
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

describe("F10: the take trigger (ADR 0348)", () => {
  it("F10 starts a take and the next F10 stops and saves it; F9 and touches do nothing to it", async () => {
    const target = fakeTarget();
    const { cap, calls } = fakeCapture();
    const toasts: string[] = [];
    const uninstall = installTakeTrigger({ capture: cap, target, toast: (t) => void toasts.push(t), tauri: true, schedule: manualSchedule().schedule });
    const press = async (k: string) => {
      target.fire("keydown", key(k));
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    expect(target.listeners.get("touchstart")?.size ?? 0).toBe(0);
    await press("F9");
    expect(calls).toEqual([]);
    await press("F10");
    await vi.waitFor(() => expect(calls).toEqual(["start"]));
    expect(toasts).toEqual(["Recording a take…"]);
    await press("F10");
    await vi.waitFor(() => expect(calls).toEqual(["start", "stop", "save"]));
    uninstall();
    expect(target.count()).toBe(0);
  });

  it("a take that stopped itself (the cap) is saved by the next F10, not thrown away by a new start", async () => {
    const target = fakeTarget();
    const { cap, calls } = fakeCapture();
    const toasts: string[] = [];
    const uninstall = installTakeTrigger({ capture: cap, target, toast: (t) => void toasts.push(t), tauri: true, schedule: manualSchedule().schedule });
    const press = async () => {
      target.fire("keydown", key("F10"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    await press();
    await vi.waitFor(() => expect(calls).toEqual(["start"]));
    cap.state = "stopped"; // the take reached its cap and stopped recording
    await press();
    await vi.waitFor(() => expect(calls).toEqual(["start", "save"]));
    expect(toasts.at(-1)).toBe(toastSaved("capture-20261113-101500.sporesample"));
    await press(); // saved: the next F10 begins a new take
    await vi.waitFor(() => expect(calls).toEqual(["start", "save", "start"]));
    uninstall();
  });
});

describe("F10 while the Audio Studio owns the takes (ADR 0408, 0417)", () => {
  /** An F10 trigger over a fake take, with take ownership over the same take; `backups` says whether this build keeps copies. */
  function rigOwned(opts: { tauri: boolean; backups: boolean }) {
    const target = fakeTarget();
    const { cap, calls } = fakeCapture();
    const toasts: string[] = [];
    const ownership = createTakeOwnership({ take: cap, backups: () => opts.backups, warn: () => {} });
    const uninstall = installTakeTrigger({ capture: cap, target, toast: (t) => void toasts.push(t), tauri: opts.tauri, webSaves: async () => ({ count: 99, max: 16 }), schedule: manualSchedule().schedule, ownership });
    const press = async () => {
      target.fire("keydown", key("F10"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const sub = takeStateSubscription(() => ({ state: cap.state, seconds: 0 }), ownership);
    const sample = () => sub.sample(new RecordWriter(), 1);
    return { cap, calls, toasts, press, sub, sample, uninstall };
  }

  it("only starts and stops while a take subscription is open, and saves again once it closes", async () => {
    const r = rigOwned({ tauri: false, backups: false });
    await r.press(); // the web's save cap doesn't apply: nothing is saved here
    await vi.waitFor(() => expect(r.calls).toEqual(["start"]));
    await r.press();
    await vi.waitFor(() => expect(r.calls).toEqual(["start", "stop"]));
    expect(r.toasts.at(-1)).toBe("Take stopped: the Audio Studio saves it");
    r.sub.close();
    r.cap.state = "idle";
    await r.press();
    expect(r.toasts.at(-1)).toMatch(/Capture limit reached/);
    r.uninstall();
  });

  it("the take subscription sends the state now and each change, not every sample", () => {
    let state: "idle" | "recording" | "stopped" = "idle";
    const ownership = createTakeOwnership({ take: fakeCapture().cap, backups: () => false, warn: () => {} });
    const sub = takeStateSubscription(() => ({ state, seconds: state === "stopped" ? 4.5 : 0 }), ownership);
    const sent: unknown[] = [];
    const sample = () => {
      const out = new RecordWriter();
      sub.sample(out, 1);
      for (const r of readRecords(out.take()).records) sent.push(decodeTakeState(r.payload));
    };
    sample();
    sample();
    state = "recording";
    sample();
    state = "stopped";
    sample();
    sample();
    expect(sent).toEqual([{ state: "idle", seconds: 0 }, { state: "recording", seconds: 0 }, { state: "stopped", seconds: 4.5 }]);
    sub.close();
  });

  it("on desktop and Android, F10 says a copy is kept only once it is written, and the take is saved once", async () => {
    const r = rigOwned({ tauri: true, backups: true });
    let finish: () => void = () => {};
    const save = r.cap.save;
    await r.press();
    await vi.waitFor(() => expect(r.calls).toEqual(["start"]));
    r.sample();
    r.cap.save = (name?: string) => new Promise<void>((resolve) => (finish = resolve)).then(() => save(name));
    await r.press();
    await vi.waitFor(() => expect(r.cap.state).toBe("stopped"));
    r.sample(); // the subscription sees the stop: the trigger's backup is under way, so it doesn't start another
    expect(r.toasts, "nothing promised while the copy is being written").toEqual(["Recording a take…"]);
    finish();
    await vi.waitFor(() => expect(r.toasts.at(-1)).toBe("Take sent to the Audio Studio (a copy is kept in app data)"));
    expect(r.calls).toEqual(["start", "stop", "save"]);
    r.sub.close();
    r.uninstall();
  });

  it("a copy that couldn't be written says so instead, in the failure's own words", async () => {
    const r = rigOwned({ tauri: true, backups: true });
    await r.press();
    await vi.waitFor(() => expect(r.calls).toEqual(["start"]));
    r.cap.saveError = new Error("the disk is full");
    await r.press();
    await vi.waitFor(() => expect(r.toasts.at(-1)).toBe("Take sent to the Audio Studio, but no copy could be kept in app data: the disk is full"));
    expect(r.toasts).not.toContain("Take sent to the Audio Studio (a copy is kept in app data)");
    r.sub.close();
    r.uninstall();
  });
});

describe("a take the Audio Studio starts and stops (ADR 0411 Record session)", () => {
  /** An F10 trigger on the build's own take ownership, the one the audio topic answers through; the topic's `take` subscription claims it. */
  function rigTopic(tauri: boolean) {
    const target = fakeTarget();
    const { cap, calls } = fakeCapture();
    const toasts: string[] = [];
    const uninstall = installTakeTrigger({ capture: cap, target, toast: (t) => void toasts.push(t), tauri, webSaves: async () => ({ count: 99, max: 16 }), schedule: manualSchedule().schedule });
    const topic = audioTopic({} as DebugTopicHost);
    const sub = topic.subscribe!({ kind: "take" }) as DebugSubscription; // the Studio owns the takes
    const dispose = () => {
      sub.close();
      uninstall();
      topic.dispose?.();
    };
    return { target, cap, calls, toasts, topic, dispose };
  }

  it("take.start and take.stop go through the F10 trigger: the same toasts, and F10 stops a take the Studio started", async () => {
    const r = rigTopic(true);
    await r.topic.request!("take.start", undefined); // the web's save cap never applies: the Studio saves
    expect(r.calls).toEqual(["start"]);
    expect(r.toasts).toEqual(["Recording a take…"]);
    r.target.fire("keydown", key("F10"));
    await vi.waitFor(() => expect(r.calls).toEqual(["start", "stop"]));
    await vi.waitFor(() => expect(r.toasts.at(-1)).toBe("Take stopped: the Audio Studio saves it"));
    await r.topic.request!("take.start", undefined);
    await r.topic.request!("take.stop", undefined);
    expect(r.calls, "nothing saved here: this build keeps no copies (not a Tauri webview)").toEqual(["start", "stop", "start", "stop"]);
    await vi.waitFor(() => expect(r.toasts.slice(-2)).toEqual(["Recording a take…", "Take stopped: the Audio Studio saves it"]));
    r.dispose();
  });

  it("a start that fails says why and answers the Studio the error", async () => {
    const r = rigTopic(false);
    r.cap.startError = new Error("the audio core isn't available");
    await expect(r.topic.request!("take.start", undefined)).rejects.toThrow("the audio core isn't available");
    expect(r.toasts).toEqual(["Recording a take…", "the audio core isn't available"]);
    r.dispose();
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
    expect(r.calls).toEqual([]);
    r.clock.run();
    await vi.waitFor(() => expect(r.calls).toEqual(["start"]));
    expect(r.toasts).toEqual([TOAST_RECORDING]);
    r.target.fire("touchend", touches(0));
    r.target.fire("touchstart", touches(3));
    r.clock.run();
    await vi.waitFor(() => expect(r.calls).toEqual(["start", "stop", "save"]));
    expect(r.toasts.at(-1)).toBe(toastSaved("capture-20261113-101500.sporesample"));
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
    await r.press(); // stops and saves the 16th
    await vi.waitFor(() => expect(r.calls).toEqual(["start", "stop", "save"]));
    count = CAPTURE_TRIGGER_MAX_FILES;
    r.toasts.length = 0;
    await r.press();
    await vi.waitFor(() => expect(r.toasts).toEqual([TOAST_CAP]));
    expect(r.calls).toEqual(["start", "stop", "save"]);
  });

  it("a Tauri trigger has no cap: files rotate instead", async () => {
    const r = rigFake({ tauri: true, webSaves: async () => ({ count: 99, max: CAPTURE_TRIGGER_MAX_FILES }) });
    await r.press();
    await vi.waitFor(() => expect(r.calls).toEqual(["start"]));
  });

  it("the toast shows a Tauri path as the capture's own file name", async () => {
    for (const [saved, shown] of [
      ["capture-20261113-101500.sporesample", "capture-20261113-101500.sporesample"],
      ["/data/app/captures/capture-20261113-101500.sporesample", "capture-20261113-101500.sporesample"],
      ["C:\\Users\\a\\AppData\\captures\\capture-20261113-101500-2.sporesample", "capture-20261113-101500-2.sporesample"],
    ]) {
      const r = rigFake({ tauri: true });
      r.cap.saved = saved;
      await r.press();
      await r.press();
      await vi.waitFor(() => expect(r.toasts.at(-1), saved).toBe(`Saved ${shown}`));
      r.uninstall();
    }
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
    expect(player).toMatch(/if \(launch\.audioCapture\) \(await import\("\.\.\/plugins\/audio\/runtime\/capture\/trigger"\)\)\.installCaptureTrigger\(\)/);
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
  chunk.options = { ringBytes: 4 * MiB, codec: keyframeCodecForTests() };
  chunk.recorders.length = 0;
  const downloads: string[] = [];
  const stored = new Set(opts.existing ?? []);
  const deleted: string[] = [];
  const env: SaveEnv = {
    tauri: opts.tauri ?? false,
    fs: {
      mkdir: async () => {},
      write: async (path) => void stored.add(path.slice(path.lastIndexOf("/") + 1)),
      list: async () => [...stored],
      remove: async (path) => {
        const key = path.slice(path.lastIndexOf("/") + 1);
        stored.delete(key);
        deleted.push(key);
      },
    },
    storageRoot: async () => "/data/app",
    download: (_bytes, fileName) => void downloads.push(fileName),
    compress: defaultSaveEnv().compress,
    now: () => new Date(2026, 10, 13, 10, 15, 0),
  };
  chunk.saveEnv = env;
  const feed = (n: number): void => {
    for (let k = 0; k < n; k++) {
      fb.frame += BLOCK;
      const block = statusBytes(fb.frame);
      const data = block.slice().buffer as ArrayBuffer;
      fb.recorderTap?.(data, block.byteLength, new DataView(data));
    }
  };
  return { fb, recorders: chunk.recorders, downloads, stored, deleted, feed };
}

describe("against the real Audio.capture", () => {

  afterEach(() => {
    releaseCapture();
    chunk.saveEnv = null;
    setAudioBackend(null);
    vi.restoreAllMocks();
  });

  it("a game that installs the trigger but never presses loads no recorder", () => {
    const r = realRig();
    const target = fakeTarget();
    const off = installCaptureTrigger({ target, toast: () => {} });
    expect(r.recorders.length).toBe(0);
    expect(Audio.capture.state).toBe("idle");
    expect(r.fb.recorderTap).toBeNull();
    off();
  });

  it("F9, a second of audio, F9: one download, named and toasted", async () => {
    const r = realRig();
    const target = fakeTarget();
    const toasts: string[] = [];
    const off = installCaptureTrigger({ target, toast: (t) => void toasts.push(t) });
    target.fire("keydown", key("F9"));
    await vi.waitFor(() => expect(Audio.capture.state).toBe("recording"));
    expect(r.recorders.length).toBe(1);
    r.feed(Math.ceil(RATE / BLOCK));
    target.fire("keydown", key("F9"));
    await vi.waitFor(() => expect(r.downloads).toEqual(["capture-20261113-101500.sporesample"]));
    await vi.waitFor(() => expect(toasts).toEqual([TOAST_RECORDING, "Saved capture-20261113-101500.sporesample"]));
    off();
  });

  it("the web stops at 16 downloads a page session, then says so and records nothing more", async () => {
    const r = realRig();
    const target = fakeTarget();
    const toasts: string[] = [];
    const off = installCaptureTrigger({ target, toast: (t) => void toasts.push(t) });
    const left = CAPTURE_TRIGGER_MAX_FILES - webSaveCount(); // earlier tests on this page downloaded too
    for (let n = 1; n <= left; n++) {
      target.fire("keydown", key("F9"));
      await vi.waitFor(() => expect(Audio.capture.state).toBe("recording"));
      r.feed(4);
      target.fire("keydown", key("F9"));
      await vi.waitFor(() => expect(r.downloads.length).toBe(n));
      await vi.waitFor(() => expect(Audio.capture.state).toBe("stopped"));
      await vi.waitFor(() => expect(toasts.at(-1)).toMatch(/^Saved /));
    }
    expect(new Set(r.downloads).size, "no download overwrites another").toBe(left);
    toasts.length = 0;
    target.fire("keydown", key("F9"));
    await vi.waitFor(() => expect(toasts).toEqual([TOAST_CAP]));
    expect(Audio.capture.state).toBe("stopped");
    expect(r.downloads.length).toBe(left);
    expect(webSaveCount()).toBe(CAPTURE_TRIGGER_MAX_FILES);
    off();
  });

  it("on Tauri a save keeps the newest 16 auto-named files, through Rc4's rotateCaptures", async () => {
    const old = Array.from({ length: 17 }, (_, i) => `capture-20261101-1000${String(i).padStart(2, "0")}.sporesample`);
    const r = realRig({ tauri: true, existing: old });
    const target = fakeTarget();
    const toasts: string[] = [];
    const off = installCaptureTrigger({ target, toast: (t) => void toasts.push(t), tauri: true });
    target.fire("keydown", key("F9"));
    await vi.waitFor(() => expect(Audio.capture.state).toBe("recording"));
    r.feed(4);
    target.fire("keydown", key("F9"));
    await vi.waitFor(() => expect(toasts.at(-1)).toMatch(/^Saved capture-20261113-101500(-\d+)?\.sporesample$/)); // -n after an earlier auto name in this second
    expect(r.stored.size).toBe(CAPTURE_TRIGGER_MAX_FILES);
    expect(r.deleted, "the two oldest, oldest first").toEqual([old[0], old[1]]);
    expect(r.stored.has(toasts.at(-1)!.slice("Saved ".length))).toBe(true);
    off();
  });
});
