// The audio topic's live take feed (`takeLive`) through its interface: a subscription sampled into a RecordWriter, over
// a real take recorder (its log, keyframes and pictures), read back by the tool side's reassembler (`TakeLiveStream`). A
// take starting, logging requests and pictures, stopping and a new one starting over; every sample within the topic's
// message size, a picture spanning several pieces.
import { describe, expect, it } from "vitest";
import { readRecords, RecordWriter, type LinkRecord } from "../../../../engine/debugLink/records";
import type { DebugSubscription } from "../../../../engine/debugLink/topics";
import type { TakeLiveFacts, TakeLiveView } from "../../runtime/capture/take";
import { TakeRecorder, type TakeRecorderRing } from "../../runtime/capture/takeRecorder";
import { AUDIO_SAMPLE_BYTES, AudioLinkRecord, decodeTakeLiveLog, decodeTakeLiveStart, readAudioSubscription } from "../../runtime/debugLink/schema";
import { takeLiveSubscription } from "../../runtime/debugLink/takeLive";
import { TakeLiveStream } from "./takeLiveStream";

class FakeRing implements TakeRecorderRing {
  seq = 1;
  readonly ringBytes = 1024 * 1024;
  stamp() {
    return { seq: this.seq++, epoch: 0, frame: 0 };
  }
  marker(): void {}
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
/** A picture bigger than three log pieces, its bytes counting up. */
const JPEG = Uint8Array.from({ length: 150 * 1024 }, (_, i) => i & 0xff);
const FACTS: TakeLiveFacts = { project: "Canyon", engine: "myco", device: "test", started: Date.UTC(2026, 10, 24, 9), audioHash: "0badf00d", seed: 7, seeded: true, pictures: true, pictureWidth: 640 };

function rig() {
  let ms = 0;
  let view: TakeLiveView | null = null;
  const sub: DebugSubscription = takeLiveSubscription(() => view);
  const stream = new TakeLiveStream();
  const sampled: LinkRecord[] = [];
  /** Samples until a sample writes nothing (as the reliable channel does), each within the message size; feeds the reassembler. */
  const drain = (): LinkRecord[] => {
    const got: LinkRecord[] = [];
    for (let i = 0; i < 100; i++) {
      const w = new RecordWriter();
      sub.sample(w, i);
      if (w.count === 0) break;
      expect(w.bytes).toBeLessThanOrEqual(AUDIO_SAMPLE_BYTES);
      const { records, stopped } = readRecords(w.take());
      expect(stopped).toBeNull();
      got.push(...records);
    }
    for (const r of got) stream.push(r);
    sampled.push(...got);
    return got;
  };
  const recorder = () => new TakeRecorder(new FakeRing(), { now: () => ms, frames: { encode: async () => JPEG, defer: (fn) => fn(), width: 640 } });
  const live = (id: number, rec: TakeRecorder, end: ReturnType<TakeRecorder["finish"]> | null = null): TakeLiveView => ({
    id, facts: FACTS, recording: end === null, get seconds() { return rec.seconds; }, log: rec, section: end?.section ?? null, message: null,
  });
  return {
    sub, stream, sampled, drain, recorder, live,
    set view(v: TakeLiveView | null) { view = v; },
    advance(toMs: number) { ms = toMs; },
  };
}

const car = { key: {}, name: "Car", position: () => ({ x: 1, y: 0, z: 0 }) };

describe("the live take feed (takeLive)", () => {
  it("is a subscription the audio topic knows", () => {
    expect(readAudioSubscription({ kind: "takeLive" })).toEqual({ kind: "takeLive" });
  });

  it("sends nothing while there is no take", () => {
    const r = rig();
    expect(r.drain()).toEqual([]);
    expect(r.stream.state).toBe("idle");
    expect(r.stream.take()).toBeNull();
  });

  it("sends a take's facts, then its requests, keyframes and pictures as they are logged, then its end; a new take starts over", async () => {
    const r = rig();
    const a = r.recorder();
    r.view = r.live(1, a);
    const first = r.drain();
    expect(first[0]!.type).toBe(AudioLinkRecord.takeLiveStart);
    expect(decodeTakeLiveStart(first[0]!.payload)).toEqual({ take: 1, ...FACTS });
    expect(r.stream.state).toBe("recording");
    expect(r.stream.take()!.keyframes.map((k) => k.t)).toEqual([0]); // the recorder's first keyframe
    expect(r.stream.take()!.meta).toMatchObject({ project: "Canyon", audioHash: "0badf00d", seed: 7, started: "2026-11-24T09:00:00.000Z" });

    const sound = { playing: true };
    a.play(sound, "sfx/engine.playlist.json", car, { volume: 0.5 });
    r.advance(200);
    a.parameter("speed", 3, null);
    a.mark("jump");
    a.frame(null, { width: 1280, height: 720 });
    await flush(); // the picture encodes
    const second = r.drain();
    expect(second.some((x) => x.type === AudioLinkRecord.takeLiveEmitters)).toBe(true);
    expect(second.filter((x) => x.type === AudioLinkRecord.takeLiveLog).length).toBeGreaterThan(2); // the picture spans pieces
    let take = r.stream.take()!;
    expect(take.requests.map((q) => q.kind)).toEqual(["play", "param", "mark", "pose"]); // the car's position at the frame
    expect(take.requests[0]).toMatchObject({ kind: "play", path: "sfx/engine.playlist.json", emitter: 1, options: { volume: 0.5 } });
    expect(take.meta.emitters).toEqual({ 0: "Listener", 1: "Car" });
    expect(take.frames).toHaveLength(1);
    expect(take.frames[0]).toMatchObject({ t: 0.2, width: 640, height: 360 });
    expect(take.frames[0]!.jpeg).toEqual(JPEG);
    expect(take.meta.frames).toBe(true);

    // Nothing logged: the clock still moves, a few times a second.
    r.advance(700);
    const clock = r.drain();
    expect(clock.map((x) => x.type)).toEqual([AudioLinkRecord.takeLiveLog]);
    expect(decodeTakeLiveLog(clock[0]!.payload)).toMatchObject({ seconds: 0.7, bytes: new Uint8Array(0) });
    expect(r.stream.take()!.duration).toBeCloseTo(0.7);
    r.advance(750);
    expect(r.drain()).toEqual([]); // not again within a quarter second

    r.advance(1500);
    a.mark("land");
    const end = a.finish({ seed: 7, seeded: true, audioHash: "0badf00d" });
    r.view = r.live(1, a, end);
    const last = r.drain();
    expect(last.at(-1)!.type).toBe(AudioLinkRecord.takeLiveEnd);
    expect(r.stream.state).toBe("stopped");
    take = r.stream.take()!;
    expect(take.marks().map((m) => m.text)).toEqual(["jump", "land"]);
    expect(take.meta.duration).toBe(1.5);
    expect(r.drain()).toEqual([]); // ended: nothing more

    // A new take: a new start, and the picture starts over.
    r.advance(0);
    const b = r.recorder();
    r.view = r.live(2, b);
    b.mark("again");
    const next = r.drain();
    expect(next[0]!.type).toBe(AudioLinkRecord.takeLiveStart);
    expect(r.stream.state).toBe("recording");
    take = r.stream.take()!;
    expect(take.requests.map((q) => q.kind)).toEqual(["mark"]);
    expect(take.meta.emitters).toEqual({ 0: "Listener" });
    expect(take.frames).toHaveLength(0);
  });

  it("sends a stopped take whole to a tool that subscribes after it stopped", () => {
    const r = rig();
    const a = r.recorder();
    a.mark("before");
    const end = a.finish({ seed: 0, seeded: false, audioHash: "" });
    r.view = r.live(4, a, end);
    const types = r.drain().map((x) => x.type);
    expect(types[0]).toBe(AudioLinkRecord.takeLiveStart);
    expect(types.at(-1)).toBe(AudioLinkRecord.takeLiveEnd);
    expect(r.stream.state).toBe("stopped");
    expect(r.stream.take()!.marks().map((m) => m.text)).toEqual(["before"]);
    expect(r.stream.take()!.meta.seeded).toBe(false);
  });

  it("the reassembler breaks on a hole in the log and reads again from the next take", () => {
    const r = rig();
    const a = r.recorder();
    r.view = r.live(1, a);
    const start = r.drain()[0]!;
    const fresh = new TakeLiveStream();
    fresh.push(start);
    a.mark("x");
    const log = r.drain().find((x) => x.type === AudioLinkRecord.takeLiveLog)!;
    expect(fresh.push(log)).toBe(true);
    expect(fresh.error).toMatch(/skipped from byte 0/);
    fresh.push(start);
    expect(fresh.error).toBeNull();
  });
});
