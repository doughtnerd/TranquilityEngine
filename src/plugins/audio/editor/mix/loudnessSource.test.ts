// ADR 0171/0172 (M5b, Pf6): the loudness series in the capture Worker, through `LoudnessSource` on the Worker's handler run
// in process. Acceptance: a reopened capture reads the live meter's values. A scene's STATUS stream is fed to a real
// `LoudnessHub` while it is written, saved as a capture file and opened through the Worker; the Worker's `valuesAt` and
// series then equal the hub's readings at the same times (M, S, I, LRA, the maximum true peak and `incomplete`, bit for bit
// in a whole capture). Time is the audio clock's (frames), never a wall clock.
import { describe, expect, it } from "vitest";
import { LOUD_OUTPUT_TAP } from "../../runtime/wire.generated";
import { CaptureError, RecordType } from "../../runtime/capture/format";
import { createCaptureWorkerHandler, type CaptureRequest, type CaptureResponse } from "../../runtime/capture/worker";
import { LoudnessSource } from "./loudnessSource";
import { MUSIC_SLOT, buildScene, type Expected, type Scene } from "./loudnessSceneSupport";
import { CaptureSource, type CaptureWorkerLike } from "./profilerSource";

function inProcessWorker(): CaptureWorkerLike & { requests: CaptureRequest[] } {
  const w: CaptureWorkerLike & { requests: CaptureRequest[] } = {
    onmessage: null,
    onerror: null,
    requests: [],
    postMessage(message, transfer) {
      const copy = structuredClone(message, { transfer: transfer as Transferable[] });
      w.requests.push(copy);
      setTimeout(() => void handler.handle(copy), 0);
    },
    terminate() {},
  };
  const handler = createCaptureWorkerHandler({
    post: (r: CaptureResponse, transfer) => {
      const copy = structuredClone(r, { transfer: transfer as Transferable[] });
      setTimeout(() => w.onmessage?.({ data: copy }), 0);
    },
  });
  return w;
}

async function open(scene: Scene): Promise<{ source: CaptureSource; loud: LoudnessSource; worker: ReturnType<typeof inProcessWorker> }> {
  const worker = inProcessWorker();
  const source = await CaptureSource.openFile(scene.file.slice().buffer, { worker });
  return { source, loud: new LoudnessSource(source), worker };
}

/** Viewport time of an axis time. */
const rel = (source: CaptureSource, t: number): number => t - source.startSeconds;

describe("a reopened capture reads the live meter's values", () => {
  const scene = buildScene();

  it("valuesAt equals the hub's reading at every status and after every control EVENT (bit for bit)", async () => {
    const { source, loud } = await open(scene);
    expect(source.truncated).toBe(false);
    const info = await loud.info();
    expect(info.mode).toBe("replay");
    expect(info.buses.map((b) => b.slot).sort((a, b) => a - b)).toEqual([MUSIC_SLOT, LOUD_OUTPUT_TAP]);
    let checked = 0;
    for (const e of scene.expected) {
      const [{ values }] = await loud.valuesAt(rel(source, e.t), e.slot);
      expect(values, `slot ${e.slot} at ${e.t}`).not.toBeNull();
      const v = values!;
      expect(v.momentary).toBe(e.live.momentary);
      expect(v.shortTerm).toBe(e.live.shortTerm);
      expect(v.integrated).toBe(e.live.integrated);
      expect(v.lra).toBe(e.live.lra);
      expect(v.truePeak).toBe(e.live.maxTruePeak);
      expect(v.incomplete).toBe(e.live.incomplete);
      checked++;
    }
    // 80 statuses and 5 events, two buses each.
    expect(checked).toBe((80 + 5) * 2);
    // The scene exercises the meter: loud and quiet halves, a shed span (incomplete on resume), a script pause, a reset.
    const lateMaster = scene.expected.filter((e) => e.slot === LOUD_OUTPUT_TAP && e.status === 79 && !e.afterEvent)[0]!;
    expect(lateMaster.live.momentary).toBeCloseTo(-14, 1);
    expect(scene.expected.some((e) => e.live.incomplete)).toBe(true);
    expect(scene.expected.some((e) => e.live.integrated === Number.NEGATIVE_INFINITY && e.status > 10)).toBe(true); // right after the reset
    source.close();
  });

  it("the series arrays equal a model fed the records, and its samples at the status times are the hub's", async () => {
    const { source, loud } = await open(scene);
    for (const slot of [MUSIC_SLOT, LOUD_OUTPUT_TAP]) {
      const s = await loud.series(slot);
      const ref = scene.reference.series(slot)!;
      expect(Array.from(s.columns.time)).toEqual(ref.time.map((t) => t - source.startSeconds));
      expect(Array.from(s.columns.momentary)).toEqual([...ref.momentary]);
      expect(Array.from(s.columns.shortTerm)).toEqual([...ref.shortTerm]);
      expect(Array.from(s.columns.integrated)).toEqual([...ref.integrated]);
      expect(Array.from(s.columns.lra)).toEqual([...ref.lra]);
      expect(Array.from(s.columns.truePeak)).toEqual([...ref.truePeak]);
      expect(Array.from(s.columns.peak)).toEqual([...ref.peak]);
      expect(Array.from(s.columns.incomplete)).toEqual([...ref.incomplete]);
      expect(s.gaps.map((g) => g.kind)).toEqual(ref.gaps.map((g) => g.kind));
      // Every sample time is ascending and each status point of the hub is a sample's value.
      for (let i = 1; i < s.columns.time.length; i++) expect(s.columns.time[i]).toBeGreaterThanOrEqual(s.columns.time[i - 1]!);
      for (const e of scene.expected.filter((x) => x.slot === slot && !x.afterEvent)) {
        let at = -1;
        for (let i = 0; i < s.columns.time.length; i++) if (s.columns.time[i]! <= rel(source, e.t)) at = i;
        expect(s.columns.momentary[at]).toBe(e.live.momentary);
        expect(s.columns.integrated[at]).toBe(e.live.integrated);
      }
    }
    source.close();
  });

  it("a window of the series is the whole series' slice, and the buffers were transferred (detached in the Worker)", async () => {
    const { source, loud } = await open(scene);
    const whole = await loud.series(LOUD_OUTPUT_TAP);
    const part = await loud.series(LOUD_OUTPUT_TAP, 10, 20);
    const a = Array.from(whole.columns.time).findIndex((t) => t >= 10);
    let b = -1;
    whole.columns.time.forEach((t, i) => { if (t <= 20) b = i; });
    expect(Array.from(part.columns.time)).toEqual(Array.from(whole.columns.time.subarray(a, b + 1)));
    expect(Array.from(part.columns.integrated)).toEqual(Array.from(whole.columns.integrated.subarray(a, b + 1)));
    expect(part.columns.time.length).toBeGreaterThan(50);
    source.close();
  });

  it("valuesAt for every bus, before the first sample (null) and past the end (the newest)", async () => {
    const { source, loud } = await open(scene);
    const before = await loud.valuesAt(-5);
    expect(before.map((b) => b.values)).toEqual([null, null]);
    const end = await loud.valuesAt(source.duration + 100);
    expect(end.map((b) => b.slot).sort((x, y) => x - y)).toEqual([MUSIC_SLOT, LOUD_OUTPUT_TAP]);
    const master = end.find((b) => b.slot === LOUD_OUTPUT_TAP)!.values!;
    const ref = scene.reference.series(LOUD_OUTPUT_TAP)!;
    expect(master.integrated).toBe(ref.integrated[ref.integrated.length - 1]);
    source.close();
  });

  it("builds once: later requests answer from the same model (no second walk of the records)", async () => {
    const { source, loud, worker } = await open(scene);
    await loud.info();
    await loud.series(MUSIC_SLOT);
    await loud.valuesAt(5);
    const kinds = worker.requests.map((r) => r.type);
    expect(kinds).toEqual(["open", "loudnessInfo", "loudnessSeries", "loudnessAt"]);
    source.close();
  });

  it("an unknown slot answers an empty series, a bad window or time is refused as badValue", async () => {
    const { source, loud } = await open(scene);
    expect((await loud.series(5)).columns.time.length).toBe(0);
    const err = await loud.series(MUSIC_SLOT, 10, 5).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureError);
    expect((err as CaptureError).code).toBe("badValue");
    const err2 = await loud.valuesAt(Number.NaN).catch((e: unknown) => e);
    expect((err2 as CaptureError).code).toBe("badValue");
    source.close();
  });

  it("a capture with no loudness has no buses", async () => {
    const { sampleCapture } = await import("../../runtime/capture/testSupport");
    const worker = inProcessWorker();
    const source = await CaptureSource.openFile(sampleCapture().slice().buffer, { worker });
    const loud = new LoudnessSource(source);
    expect((await loud.info()).buses).toEqual([]);
    expect(await loud.valuesAt(0.1)).toEqual([]);
    source.close();
  });
});

describe("a ring-truncated capture holds I at the keyframes (seek mode)", () => {
  const cut = buildScene({ cutFromStatus: 44 });

  it("M and S are the hub's once 4 and 30 sub-blocks have arrived; I is the newest keyframe's reading", async () => {
    const { source, loud } = await open(cut);
    expect(source.truncated).toBe(true);
    expect((await loud.info()).mode).toBe("seek");
    let m = 0;
    let s = 0;
    let held = 0;
    for (const e of cut.expected) {
      if (e.status < 44) continue;
      const [{ values }] = await loud.valuesAt(rel(source, e.t), e.slot);
      const v = values!;
      // After a first status's 5 sub-blocks M is defined (4 needed); after 7 statuses (35 sub-blocks) S is.
      if (e.status >= 45 && !(e.slot === LOUD_OUTPUT_TAP && e.status >= 60 && e.status <= 61)) {
        expect(v.momentary).toBe(e.live.momentary);
        m++;
      }
      if (e.status >= 51 && !(e.status >= 60 && e.status < 66)) {
        expect(v.shortTerm).toBe(e.live.shortTerm);
        s++;
      }
      if (!e.afterEvent) {
        expect(v.integrated).toBe(e.keyframeIntegrated);
        held++;
      }
    }
    expect([m > 40, s > 40, held]).toEqual([true, true, (80 - 44) * 2]);
    source.close();
  });
});

describe("target marks come from the Worker's model and change nothing", () => {
  const scene = buildScene();
  const target = { name: "console", integrated: -24, tolerance: 2, truePeak: -1 };

  it("equal the model's marks for the same series, on the viewport axis", async () => {
    const { source, loud } = await open(scene);
    const got = await loud.marks(target, { metrics: ["momentary"] });
    const want = scene.reference.targetMarks(target, { metrics: ["momentary"] });
    expect(got).toEqual(want.map((m) => ({ ...m, from: m.from - source.startSeconds, to: m.to - source.startSeconds })));
    // Music reads -30 (under -26) then -20 (over -22); the output -23 (inside) then -14 (over); one status peaks at +1.6 dBTP.
    expect(got.some((m) => m.bus === MUSIC_SLOT && m.kind === "under" && m.metric === "momentary")).toBe(true);
    expect(got.some((m) => m.bus === MUSIC_SLOT && m.kind === "over" && m.metric === "momentary")).toBe(true);
    expect(got.some((m) => m.bus === LOUD_OUTPUT_TAP && m.kind === "under")).toBe(false);
    expect(got.filter((m) => m.metric === "truePeak").length).toBeGreaterThan(0);
    source.close();
  });

  it("asking for marks leaves the series as it was (warn, never adjust)", async () => {
    const { source, loud } = await open(scene);
    const before = await loud.series(LOUD_OUTPUT_TAP);
    await loud.marks(target);
    await loud.marks({ ...target, integrated: -10 });
    const after = await loud.series(LOUD_OUTPUT_TAP);
    expect(Array.from(after.columns.integrated)).toEqual(Array.from(before.columns.integrated));
    expect(Array.from(after.columns.time)).toEqual(Array.from(before.columns.time));
    source.close();
  });

  it("a non-finite target is refused", async () => {
    const { source, loud } = await open(scene);
    const err = await loud.marks({ integrated: Number.NaN, tolerance: 2, truePeak: -1 }).catch((e: unknown) => e);
    expect((err as CaptureError).code).toBe("badValue");
    source.close();
  });
});

describe("the live view extends the series as segments arrive", () => {
  it("a model built after two segments is extended by the third, and equals the file's", async () => {
    const scene = buildScene();
    const { encodeRecords, assembleCapture } = await import("../../runtime/capture/format");
    const { SAMPLE_HEADER, SAMPLE_META } = await import("../../runtime/capture/testSupport");
    const meta = { ...SAMPLE_META, names: { ...SAMPLE_META.names, parameters: { 7: "Music", 8: "Master" } } };
    const head = assembleCapture(SAMPLE_HEADER, meta, []);
    // Segments start at a KEYFRAME (R17): cut the records at keyframes 0, 20 and 60.
    const kfs = scene.records.map((r, i) => (r.type === RecordType.KEYFRAME ? i : -1)).filter((i) => i >= 0);
    expect(kfs.length).toBeGreaterThan(3);
    const worker = inProcessWorker();
    const source = await CaptureSource.openLive(head.slice().buffer, { worker });
    const loud = new LoudnessSource(source);
    const cuts = [0, kfs[10]!, kfs[30]!, scene.records.length];
    await source.appendSegment(encodeRecords(scene.records.slice(cuts[0], cuts[1])).slice().buffer);
    const half = await loud.info();
    await source.appendSegment(encodeRecords(scene.records.slice(cuts[1], cuts[2])).slice().buffer);
    const mid = await loud.info();
    await source.appendSegment(encodeRecords(scene.records.slice(cuts[2], cuts[3])).slice().buffer);
    const full = await loud.series(LOUD_OUTPUT_TAP);
    const ref = scene.reference.series(LOUD_OUTPUT_TAP)!;
    const samples = (i: { buses: readonly { slot: number; samples: number }[] }) => i.buses.find((b) => b.slot === LOUD_OUTPUT_TAP)!.samples;
    expect(samples(half)).toBeLessThan(samples(mid));
    expect(samples(mid)).toBeLessThan(ref.time.length);
    expect(Array.from(full.columns.integrated)).toEqual([...ref.integrated]);
    expect(Array.from(full.columns.momentary)).toEqual([...ref.momentary]);
    source.close();
  });
});
