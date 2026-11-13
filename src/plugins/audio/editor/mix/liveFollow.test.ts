// ADR 0171/0172 (Pf7; api-and-models §7, architecture §2.1, §3.7): live follow. Cases: updates coalesce (no render per
// STATUS block), segments forwarded in order through the real recorder and Worker handler, close with no take releases the
// ring, close with a take keeps recording, reopen resumes, a lost feed is a state, a close during the join, a refused
// join. The 66 ms is a UI cadence driven by a manual scheduler here; no case asserts on wall-clock time.
import { describe, expect, it, vi } from "vitest";
import { createCaptureWorkerHandler, type CaptureRequest, type CaptureResponse } from "../../runtime/capture/worker";
import { createRecorder, type EpochContext, type Recorder } from "../../runtime/capture/recorder";
import { SAMPLE_RATE, keyframeCodecForTests, liveHead, statusBytesWith } from "../../runtime/capture/testSupport";
import type { CaptureWorkerLike } from "./profilerSource";
import { LIVE_UPDATE_MS, LiveFollow, viewportAfterUpdate, type LiveFollowModel, type LiveHost, type LiveRecording, type LiveScheduler } from "./liveFollow";

const MiB = 1024 * 1024;
const BLOCK = 768;
const CONTEXT: EpochContext = { sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0 };

/** A scheduler that runs timers only when told: the cadence is counted, never waited for. */
function manualScheduler() {
  let next = 1;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const s: LiveScheduler & { timers: typeof timers; scheduled: number; fire(): void } = {
    timers,
    scheduled: 0,
    setTimeout(fn, ms) {
      s.scheduled++;
      const h = next++;
      timers.set(h, { fn, ms });
      return h;
    },
    clearTimeout(h) {
      timers.delete(h as number);
    },
    fire() {
      const all = [...timers.values()];
      timers.clear();
      for (const t of all) t.fn();
    },
  };
  return s;
}

/** The capture Worker's real handler behind a `CaptureWorkerLike`, answering on later macrotasks. */
function inProcessWorker(): CaptureWorkerLike & { requests: CaptureRequest[]; terminated: boolean } {
  const w: CaptureWorkerLike & { requests: CaptureRequest[]; terminated: boolean } = {
    onmessage: null,
    onerror: null,
    requests: [],
    terminated: false,
    postMessage(message, transfer) {
      const copy = structuredClone(message, { transfer: transfer as Transferable[] });
      w.requests.push(copy);
      setTimeout(() => { if (!w.terminated) void handler.handle(copy); }, 0);
    },
    terminate() {
      w.terminated = true;
    },
  };
  const handler = createCaptureWorkerHandler({
    post: (r: CaptureResponse, transfer) => {
      const copy = structuredClone(r, { transfer: transfer as Transferable[] });
      setTimeout(() => { if (!w.terminated) w.onmessage?.({ data: copy }); }, 0);
    },
  });
  return w;
}

function recorder(): Recorder {
  let t = 1000;
  return createRecorder({ ringBytes: 8 * MiB, codec: keyframeCodecForTests(), now: () => (t += 1) });
}

function feeder(r: Recorder) {
  const probe = statusBytesWith({ currentFrame: 0 });
  const data = probe.slice().buffer as ArrayBuffer;
  const view = new DataView(data);
  return (k: number): void => {
    view.setFloat64(16, k * BLOCK, true);
    r.tap(data, probe.byteLength, view);
  };
}
const blocksFor = (seconds: number): number => Math.floor((seconds * SAMPLE_RATE) / BLOCK);

/**
 * A host with Rc4's owner rule: the ring records while any owner holds it; the last release stops recording. `others` is
 * the count of owners besides the panel (a take, the export trigger).
 */
function fakeHost(r: Recorder, others = 0) {
  const h = {
    owners: others,
    joins: 0,
    releases: 0,
    stops: 0,
    live: false,
    failJoin: null as Error | null,
    gate: null as Promise<void> | null,
    get recording(): boolean {
      return h.owners > 0;
    },
    join: async (): Promise<LiveRecording> => {
      h.joins++;
      if (h.gate) await h.gate;
      if (h.failJoin) throw h.failJoin;
      h.owners++;
      let released = false;
      return {
        head: () => liveHead(),
        startLive: (o) => {
          h.live = true;
          r.startLive(o);
        },
        stopLive: () => {
          h.stops++;
          h.live = false;
          r.stopLive();
        },
        get liveLost() {
          return r.liveLost;
        },
        release: () => {
          if (released) return;
          released = true;
          h.releases++;
          h.owners--;
        },
      };
    },
  };
  return h satisfies LiveHost & Record<string, unknown>;
}

function follow(host: LiveHost, scheduler = manualScheduler()) {
  const updates: LiveFollowModel[] = [];
  const f = new LiveFollow({ host, scheduler, sourceOptions: () => ({ worker: inProcessWorker() }), onUpdate: (m) => void updates.push(m) });
  return { f, scheduler, updates };
}

const settle = (cond: () => boolean) => vi.waitFor(() => expect(cond()).toBe(true));

describe("updates coalesce (no render per STATUS block)", () => {
  it("100 notifications inside one window give one update, and one timer is pending at a time", async () => {
    const r = recorder();
    r.begin(0, CONTEXT);
    const { f, scheduler, updates } = follow(fakeHost(r));
    await f.start();
    scheduler.fire(); // the start's own update
    updates.length = 0;
    scheduler.scheduled = 0;
    for (let i = 0; i < 100; i++) f.notify();
    expect(scheduler.scheduled).toBe(1);
    expect(scheduler.timers.size).toBe(1);
    expect([...scheduler.timers.values()][0]!.ms).toBe(LIVE_UPDATE_MS);
    expect(updates.length).toBe(0); // nothing rendered until the window closes
    scheduler.fire();
    expect(updates.length).toBe(1);
    // The next change opens the next window.
    f.notify();
    scheduler.fire();
    expect(updates.length).toBe(2);
    f.stop();
  });

  it("STATUS blocks fed through the recorder tap, with a notify per block, still make one update per window", async () => {
    const r = recorder();
    r.begin(0, CONTEXT);
    const { f, scheduler, updates } = follow(fakeHost(r));
    await f.start();
    scheduler.fire();
    updates.length = 0;
    const feed = feeder(r);
    for (let k = 1; k <= 100; k++) {
      feed(k);
      f.notify();
    }
    scheduler.fire();
    expect(updates.length).toBe(1);
    f.stop();
  });

  it("notify while idle does nothing", () => {
    const { f, scheduler, updates } = follow(fakeHost(recorder()));
    f.notify();
    expect(scheduler.timers.size).toBe(0);
    expect(updates).toEqual([]);
  });
});

describe("segments reach the Worker in order", () => {
  it("each sealed segment is appended once, the view grows with them, and catch-up segments go first", async () => {
    const r = recorder();
    r.begin(0, CONTEXT);
    const feed = feeder(r);
    for (let k = 1; k <= blocksFor(2.2); k++) feed(k); // two sealed before the panel opens
    const { f, scheduler, updates } = follow(fakeHost(r));
    await f.start();
    await settle(() => f.current.segments === 2);
    for (let k = blocksFor(2.2) + 1; k <= blocksFor(5.2); k++) feed(k); // three more seal
    await settle(() => f.current.segments === 5);
    expect(r.liveSegments).toBe(5);
    expect(f.current.state).toBe("following");
    scheduler.fire();
    const last = updates.at(-1)!;
    expect(last.segments).toBe(5);
    expect(last.duration).toBeGreaterThan(4.9);
    expect(last.source!.live).toBe(true);
    // The Worker checks seq continuity, so five appends accepted means they arrived in order and whole.
    expect(last.source!.summary.recordCount).toBeGreaterThan(5);
    f.stop();
  });
});

describe("close releases this owner's hold", () => {
  it("with no take: stopLive, then release, and the host stops recording", async () => {
    const r = recorder();
    r.begin(0, CONTEXT);
    const host = fakeHost(r);
    const { f, updates } = follow(host);
    await f.start();
    expect(host.recording).toBe(true);
    expect(host.live).toBe(true);
    f.stop();
    expect(host.stops).toBe(1);
    expect(host.releases).toBe(1);
    expect(host.recording).toBe(false);
    expect(host.live).toBe(false);
    expect(f.current.state).toBe("idle");
    expect(f.current.source).toBeNull();
    expect(updates.at(-1)!.state).toBe("idle");
  });

  it("with a take running: the live feed ends but the take keeps the ring recording", async () => {
    const r = recorder();
    r.begin(0, CONTEXT);
    const host = fakeHost(r, 1); // a take (Audio.capture.start) is the other owner
    const { f } = follow(host);
    await f.start();
    expect(host.owners).toBe(2);
    f.stop();
    expect(host.releases).toBe(1);
    expect(host.recording).toBe(true);
    expect(host.live).toBe(false);
    // Frames still tap into the ring; nothing is posted after stopLive.
    const feed = feeder(r);
    const before = r.liveSegments;
    for (let k = 1; k <= blocksFor(1.5); k++) feed(k);
    expect(r.liveSegments).toBe(before);
    expect(r.ring.seconds).toBeGreaterThan(1);
  });

  it("stop twice releases once", async () => {
    const r = recorder();
    r.begin(0, CONTEXT);
    const host = fakeHost(r);
    const { f } = follow(host);
    await f.start();
    f.stop();
    f.stop();
    expect(host.releases).toBe(1);
  });

  it("closing while the recorder is still loading: the late join is released at once and no view opens", async () => {
    const r = recorder();
    r.begin(0, CONTEXT);
    const host = fakeHost(r);
    let open!: () => void;
    host.gate = new Promise<void>((res) => (open = res));
    const { f } = follow(host);
    const started = f.start();
    expect(f.current.state).toBe("starting");
    f.stop();
    open();
    await started;
    expect(host.joins).toBe(1);
    expect(host.releases).toBe(1);
    expect(host.recording).toBe(false);
    expect(host.live).toBe(false);
    expect(f.current.state).toBe("idle");
  });
});

describe("reopen resumes", () => {
  it("a new start joins again, reopens the view and takes the segments sealed meanwhile", async () => {
    const r = recorder();
    r.begin(0, CONTEXT);
    const host = fakeHost(r, 1); // a take keeps the ring alive across the close
    const { f } = follow(host);
    const feed = feeder(r);
    await f.start();
    for (let k = 1; k <= blocksFor(2.2); k++) feed(k);
    await settle(() => f.current.segments === 2);
    f.stop();
    for (let k = blocksFor(2.2) + 1; k <= blocksFor(4.2); k++) feed(k); // two more seal while closed
    await f.start();
    expect(host.joins).toBe(2);
    expect(host.owners).toBe(2);
    await settle(() => f.current.segments === 4); // the new view starts at the take's start: all four
    expect(f.current.state).toBe("following");
    f.stop();
    expect(host.owners).toBe(1);
  });
});

describe("failures are states", () => {
  it("a segment the ring evicted before it was posted: state lost, the recording goes on", async () => {
    const r = recorder();
    r.begin(0, CONTEXT);
    const host = fakeHost(r);
    const { f, scheduler, updates } = follow(host);
    const feed = feeder(r);
    await f.start();
    for (let k = 1; k <= 70; k++) feed(k);
    await settle(() => f.current.segments === 1);
    r.ring.firstSegment = r.ring.nextSegment - 1;
    r.ring.nextSegment += 1;
    for (let k = 71; k <= 140; k++) feed(k);
    expect(r.liveLost).toBe(true);
    f.notify();
    scheduler.fire();
    expect(updates.at(-1)!.state).toBe("lost");
    expect(host.recording).toBe(true); // the ring is still held until the panel closes
    f.stop();
    expect(host.recording).toBe(false);
  });

  it("a join that rejects is an error state with its message and no hold; start can try again", async () => {
    const r = recorder();
    const host = fakeHost(r);
    host.failJoin = new Error("audio capture isn't available yet");
    const { f, scheduler, updates } = follow(host);
    await f.start();
    scheduler.fire();
    expect(updates.at(-1)).toMatchObject({ state: "error", error: "audio capture isn't available yet", source: null });
    expect(host.owners).toBe(0);
    host.failJoin = null;
    r.begin(0, CONTEXT);
    await f.start();
    expect(f.current.state).toBe("following");
    f.stop();
  });

  it("a Worker that refuses a segment ends the view and the hold", async () => {
    const r = recorder();
    r.begin(0, CONTEXT);
    const host = fakeHost(r);
    const { f } = follow(host);
    await f.start();
    // A segment whose seq doesn't continue: post a duplicate of the first through the live feed's own post.
    const feed = feeder(r);
    for (let k = 1; k <= 70; k++) feed(k);
    await settle(() => f.current.segments === 1);
    const dup = r.ring.copySegment(r.ring.firstSegment);
    (f as unknown as { forward(run: number, s: unknown, q: unknown, t: unknown[]): void }).forward(
      (f as unknown as { run: number }).run,
      f.current.source,
      { type: "appendSegment", id: 0, bytes: dup.slice().buffer },
      [],
    );
    await settle(() => f.current.state === "error");
    expect(host.recording).toBe(false);
    expect(f.current.error).toMatch(/badSeq|seq/i);
  });
});

describe("viewportAfterUpdate", () => {
  it("keeps a following viewport on the live edge and leaves a free one alone", () => {
    const model = { state: "following", source: null, duration: 12, segments: 12, error: null } as LiveFollowModel;
    expect(viewportAfterUpdate({ start: 0, end: 4, followLive: true }, model)).toMatchObject({ start: 8, end: 12, followLive: true });
    const free = { start: 1, end: 3, followLive: false };
    expect(viewportAfterUpdate(free, model)).toBe(free);
  });
});
