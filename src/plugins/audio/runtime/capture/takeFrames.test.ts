// ADR 0348: a take's pictures. The grabber takes one about once a second, scaled to the width asked for (640 px by default), after the frame renders,
// skips (never queues) while one encodes, and gives up on an encoder that keeps failing; the recorder writes each as a
// FRAME record and says in META whether it has any. Headless (no canvas): no pictures and no errors.
import { describe, expect, it } from "vitest";
import { decodeTakeRecord, TakeRecordType } from "../../../../engine/audio/take/records";
import type { TakeFrame } from "../../../../engine/audio/take/types";
import { CAPTURE_RECORD_HEAD_BYTES } from "./format";
import { TakeFrameGrabber, type EncodeTakeFrame } from "./takeFrames";
import { TakeRecorder, type TakeRecorderRing } from "./takeRecorder";

const JPEG = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
const canvas = (width = 1280, height = 720) => ({ width, height });

/** An encoder that resolves when the test says, recording what it was asked. */
function manualEncoder() {
  const asked: { width: number; height: number; resolve(b: Uint8Array | null): void }[] = [];
  const encode: EncodeTakeFrame = (_source, width, height) => new Promise((resolve) => asked.push({ width, height, resolve }));
  return { encode, asked };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("TakeFrameGrabber (ADR 0348)", () => {
  it("takes a picture about once a second, 640 px wide with the view's aspect", async () => {
    const frames: TakeFrame[] = [];
    const g = new TakeFrameGrabber((f) => frames.push(f), { encode: async () => JPEG, defer: (fn) => fn() });
    for (const t of [0, 0.4, 0.99, 1, 1.5, 2.2]) {
      g.offer(canvas(), t);
      await flush();
    }
    expect(frames.map((f) => f.t)).toEqual([0, 1, 2.2]);
    expect(frames[0]).toEqual({ t: 0, width: 640, height: 360, jpeg: JPEG });
    expect(g.count).toBe(3);
  });

  it("takes a view narrower than the width asked for at that width, the aspect kept", async () => {
    const { encode, asked } = manualEncoder();
    new TakeFrameGrabber(() => {}, { encode, defer: (fn) => fn() }).offer(canvas(200, 100), 0);
    new TakeFrameGrabber(() => {}, { encode, defer: (fn) => fn(), width: 1280 }).offer(canvas(960, 540), 0);
    expect(asked.map(({ width, height }) => [width, height])).toEqual([[640, 320], [1280, 720]]);
  });

  it("snapshots after the frame renders (deferred), and skips offers while one encodes rather than queueing them", async () => {
    const { encode, asked } = manualEncoder();
    const deferred: (() => void)[] = [];
    const frames: TakeFrame[] = [];
    const g = new TakeFrameGrabber((f) => frames.push(f), { encode, defer: (fn) => deferred.push(fn) });
    g.offer(canvas(), 0);
    expect(asked).toHaveLength(0); // not during the audio frame
    deferred.shift()!();
    expect(asked).toHaveLength(1);
    g.offer(canvas(), 1.5);
    g.offer(canvas(), 3);
    expect(deferred).toHaveLength(0);
    asked[0]!.resolve(JPEG);
    await flush();
    expect(frames.map((f) => f.t)).toEqual([0]);
    g.offer(canvas(), 3.1);
    deferred.shift()!();
    expect(asked).toHaveLength(2);
  });

  it("does nothing without a canvas or with an empty one", () => {
    const { encode, asked } = manualEncoder();
    const g = new TakeFrameGrabber(() => {}, { encode, defer: (fn) => fn() });
    g.offer(null, 0);
    g.offer(canvas(0, 0), 1);
    expect(asked).toHaveLength(0);
  });

  it("takes pictures at the width asked for (clamped to the allowed range), whatever the view's width", async () => {
    const { encode, asked } = manualEncoder();
    new TakeFrameGrabber(() => {}, { encode, defer: (fn) => fn(), width: 1280 }).offer(canvas(1920, 1080), 0);
    new TakeFrameGrabber(() => {}, { encode, defer: (fn) => fn(), width: 1280 }).offer(canvas(800, 600), 0);
    new TakeFrameGrabber(() => {}, { encode, defer: (fn) => fn(), width: 10_000 }).offer(canvas(4000, 2000), 0);
    new TakeFrameGrabber(() => {}, { encode, defer: (fn) => fn(), width: 1 }).offer(canvas(), 0);
    new TakeFrameGrabber(() => {}, { encode, defer: (fn) => fn(), width: 1280 }).offer(canvas(100, 1000), 0); // too tall at 1280: the height caps
    expect(asked.map(({ width, height }) => [width, height])).toEqual([[1280, 720], [1280, 960], [1920, 960], [64, 36], [410, 4096]]);
  });

  it("drops a picture past the record cap and lowers the JPEG quality before the width", async () => {
    const asked: [number, number][] = [];
    const frames: TakeFrame[] = [];
    const g = new TakeFrameGrabber((f) => frames.push(f), {
      width: 1280,
      encode: async (_s, width, _h, quality) => {
        asked.push([width, quality]);
        return width * quality > 400 ? new Uint8Array(300 * 1024) : JPEG;
      },
      defer: (fn) => fn(),
    });
    for (let t = 0; t < 4; t++) {
      g.offer(canvas(), t);
      await flush();
    }
    expect(asked).toEqual([[1280, 0.6], [1280, 0.45], [1280, 0.3], [1280, 0.3]]);
    expect(frames.map((f) => [f.t, f.width, f.height])).toEqual([[2, 1280, 720], [3, 1280, 720]]);
  });

  it("takes the next pictures narrower only when the lowest quality is still past the cap", async () => {
    const asked: [number, number][] = [];
    const frames: TakeFrame[] = [];
    const g = new TakeFrameGrabber((f) => frames.push(f), {
      width: 1280,
      encode: async (_s, width, _h, quality) => {
        asked.push([width, quality]);
        return width > 800 ? new Uint8Array(300 * 1024) : JPEG;
      },
      defer: (fn) => fn(),
    });
    for (let t = 0; t < 6; t++) {
      g.offer(canvas(), t);
      await flush();
    }
    expect(asked).toEqual([[1280, 0.6], [1280, 0.45], [1280, 0.3], [960, 0.3], [720, 0.3], [720, 0.3]]);
    expect(frames.map((f) => [f.t, f.width, f.height])).toEqual([[4, 720, 405], [5, 720, 405]]);
  });

  it("steps back up to the width and quality asked for once pictures fit again (a busy moment doesn't shrink the rest of the take)", async () => {
    let busyScene = true;
    const frames: TakeFrame[] = [];
    const qualities: number[] = [];
    const g = new TakeFrameGrabber((f) => frames.push(f), {
      width: 1280,
      encode: async (_s, width, _h, quality) => {
        qualities.push(quality);
        return busyScene && width > 800 ? new Uint8Array(300 * 1024) : new Uint8Array(20 * 1024);
      },
      defer: (fn) => fn(),
    });
    for (let t = 0; t < 6; t++) {
      g.offer(canvas(), t);
      await flush();
    }
    expect(frames.at(-1)!.width).toBe(720);
    busyScene = false;
    for (let t = 6; t < 40; t++) {
      g.offer(canvas(), t);
      await flush();
    }
    expect(frames.at(-1)!.width).toBe(1280);
    expect(qualities.at(-1)).toBe(0.6);
  });

  it("stops asking an encoder that keeps failing; a picture past the record cap is dropped", async () => {
    let calls = 0;
    const frames: TakeFrame[] = [];
    const g = new TakeFrameGrabber((f) => frames.push(f), {
      encode: async () => {
        calls++;
        if (calls === 1) return new Uint8Array(300 * 1024);
        if (calls === 2) throw new Error("no encoder");
        return null;
      },
      defer: (fn) => fn(),
    });
    for (let t = 0; t < 10; t++) {
      g.offer(canvas(), t);
      await flush();
    }
    expect(calls).toBe(4); // the oversized picture only narrowed the next ones; three failures in a row stop it
    expect(frames).toEqual([]);
  });
});

class FakeRing implements TakeRecorderRing {
  seq = 1;
  readonly ringBytes = 1024 * 1024;
  stamp() {
    return { seq: this.seq++, epoch: 0, frame: 0 };
  }
  marker(): void {}
}

/** The FRAME records in a finished take's request log. */
function framesOf(bytes: Uint8Array): TakeFrame[] {
  const out: TakeFrame[] = [];
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let off = 0; off < bytes.byteLength; off += CAPTURE_RECORD_HEAD_BYTES + v.getUint32(off + 4, true)) {
    if (v.getUint8(off) !== TakeRecordType.FRAME) continue;
    const r = decodeTakeRecord(TakeRecordType.FRAME, v, off + CAPTURE_RECORD_HEAD_BYTES, v.getUint32(off + 4, true));
    if (r.type === "frame") out.push(r.frame);
  }
  return out;
}

describe("the take recorder's pictures (ADR 0348)", () => {
  it("writes each picture as a FRAME record and says so in META", async () => {
    let ms = 0;
    const rec = new TakeRecorder(new FakeRing(), { now: () => ms, frames: { encode: async () => JPEG, defer: (fn) => fn() } });
    for (ms = 0; ms <= 2500; ms += 100) {
      rec.frame(null, canvas());
      await flush();
    }
    const { requests, section } = rec.finish({ seed: 0, seeded: false, audioHash: "" });
    expect(framesOf(requests.bytes).map((f) => [f.t, f.width, f.height])).toEqual([[0, 640, 360], [1, 640, 360], [2, 640, 360]]);
    expect(section.frames).toBe(true);
  });

  it("takes none when pictures are off, or headless; META says so", async () => {
    let ms = 0;
    const off = new TakeRecorder(new FakeRing(), { now: () => ms });
    const headless = new TakeRecorder(new FakeRing(), { now: () => ms, frames: { encode: async () => JPEG, defer: (fn) => fn() } });
    for (ms = 0; ms <= 1500; ms += 100) {
      off.frame(null, canvas());
      headless.frame(null, null);
      await flush();
    }
    for (const r of [off, headless]) {
      const { requests, section } = r.finish({ seed: 0, seeded: false, audioHash: "" });
      expect(framesOf(requests.bytes)).toEqual([]);
      expect(section.frames).toBe(false);
    }
  });
});
