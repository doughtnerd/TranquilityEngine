import { describe, expect, it, vi } from "vitest";
import { MAGIC, writeStatus } from "../wire.generated";
import { CoreLink, type LinkPort } from "./context";
import { makeStatusBlock, MIRROR_EVENT_CAPACITY, StatusMirror } from "./mirror";
import { VoiceReason, VoiceState, VoiceTable } from "./voiceTable";

// A1.1 (lead): the STATUS mirror applied in `onmessage` (api-and-models §3 "Status mirror", §4.3).
const P = VoiceState.PLAYING;
const indexOf = (id: number) => id & 0xffff;

function setup() {
  const table = new VoiceTable(8);
  return { table, mirror: new StatusMirror(table) };
}

describe("StatusMirror (§3, §4.3)", () => {
  it("ended ids mark live voices ENDING and stale ids are ignored", () => {
    const { table, mirror } = setup();
    const a = table.allocate(0, 1, 0, P);
    table.free(a, VoiceReason.NONE);
    const b = table.allocate(0, 1, 0, P); // same slot, next generation
    mirror.apply(makeStatusBlock({ ended: [a] }));
    expect(table.state[indexOf(b)]).toBe(P);
    mirror.apply(makeStatusBlock({ ended: [b, b] }));
    expect(table.state[indexOf(b)]).toBe(VoiceState.ENDING);
    expect(table.isLive(b)).toBe(true); // freed by the frame, not by onmessage
    expect(table.freeEnded()).toBe(1);
    expect(table.isLive(b)).toBe(false);
  });

  it("a stolen voice's old id, reported once in STATUS after its slot was reused, leaves the new voice alone", () => {
    // A1.2's contract: a PLAY with a new generation replaces the slot's voice on the core, and the replaced voice's
    // old id still arrives once in `ended`. Every section must check the generation.
    const table = new VoiceTable(2);
    const mirror = new StatusMirror(table);
    const old = table.allocate(0, 1, 0, P);
    table.allocate(0, 1, 0, P);
    const stealer = table.allocate(0, 200, 0, P);
    expect(indexOf(stealer)).toBe(indexOf(old));
    mirror.apply(makeStatusBlock({ ended: [old], demoted: [old], starved: [old], playheads: [{ id: old, clipFrame: 999 }] }));
    const i = indexOf(stealer);
    expect(table.state[i]).toBe(P);
    expect(table.reason[i]).toBe(VoiceReason.NONE);
    expect(table.playhead[i]).toBe(0);
    expect(table.freeEnded()).toBe(0);
    expect(table.isLive(stealer)).toBe(true);
    expect(table.endedReason(old)).toBe(VoiceReason.STOLEN);
  });

  it("demoted, starved and playheads reach the table", () => {
    const { table, mirror } = setup();
    const a = table.allocate(0, 1, 0, P);
    const b = table.allocate(0, 1, 0, P);
    const locked = table.allocate(0, 1, 0, VoiceState.LOCKED);
    mirror.apply(makeStatusBlock({ demoted: [a, locked], starved: [b, locked], playheads: [{ id: b, clipFrame: 4410 }] }));
    expect(table.state[indexOf(a)]).toBe(VoiceState.VIRTUAL);
    expect(table.reason[indexOf(a)]).toBe(VoiceReason.VIRTUAL);
    expect(table.reason[indexOf(b)]).toBe(VoiceReason.WAITING_FOR_DATA);
    expect(table.state[indexOf(b)]).toBe(P);
    expect(table.state[indexOf(locked)]).toBe(VoiceState.LOCKED);
    expect(table.reason[indexOf(locked)]).toBe(VoiceReason.LOCKED);
    expect(table.playhead[indexOf(b)]).toBe(4410);
  });

  it("peaks and counters take the newest block; minSlackSinceFrame the minimum until beginFrame", () => {
    const { mirror } = setup();
    mirror.apply(makeStatusBlock({ currentFrame: 128, dateMs: 10, underruns: 1, minSlackFrames: 50, abiVersion: 0x100, mixedCap: 64, peaks: [{ l: 0.5, r: 0.25 }, { l: 1, r: 1 }] }));
    mirror.apply(makeStatusBlock({ currentFrame: 896, dateMs: 26, underruns: 2, minSlackFrames: 80, abiVersion: 0, mixedCap: 48, peaks: [{ l: 0.125, r: 0 }] }));
    expect(mirror.blocks).toBe(2);
    expect([mirror.currentFrame, mirror.dateMs, mirror.underruns, mirror.mixedCap]).toEqual([896, 26, 2, 48]);
    expect([mirror.frameAudio, mirror.frameDateMs]).toEqual([896, 26]);
    expect(mirror.abiVersion).toBe(0x100);
    expect(mirror.minSlackFrames).toBe(80);
    expect(mirror.peakCount).toBe(1);
    expect([mirror.peakL[0], mirror.peakR[0]]).toEqual([0.125, 0]);
    expect(mirror.beginFrame()).toBe(50);
    expect(mirror.beginFrame()).toBe(Number.POSITIVE_INFINITY);
  });

  it("ADR 0170: the ladder's steps given back count, a new core's first block doesn't, and the last underrun's frame is kept", () => {
    const { mirror } = setup();
    expect(mirror.underrunFrame).toBe(Number.NEGATIVE_INFINITY);
    mirror.apply(makeStatusBlock({ currentFrame: 128, underruns: 3, m3Shed: 3, abiVersion: 0x100 }));
    mirror.apply(makeStatusBlock({ currentFrame: 256, underruns: 3, m3Shed: 3 }));
    expect([mirror.underrunFrame, mirror.m3Recoveries]).toEqual([128, 0]);
    mirror.apply(makeStatusBlock({ currentFrame: 384, underruns: 3, m3Shed: 2 }));
    mirror.apply(makeStatusBlock({ currentFrame: 512, underruns: 5, m3Shed: 3 }));
    mirror.apply(makeStatusBlock({ currentFrame: 640, underruns: 5, m3Shed: 1 }));
    expect([mirror.underrunFrame, mirror.m3Recoveries]).toEqual([512, 3]);
    // A rebuilt core starts at 0 steps: not a recovery.
    mirror.apply(makeStatusBlock({ currentFrame: 128, underruns: 5, m3Shed: 0, abiVersion: 0x100 }));
    expect(mirror.m3Recoveries).toBe(3);
  });

  it("clip and stream events queue in order and drain once; overflow drops the oldest and counts", () => {
    const { mirror } = setup();
    mirror.apply(makeStatusBlock({ clipEvents: [{ clipId: 7, code: 1 }, { clipId: 8, code: 2 }], streamEvents: [{ id: 3, code: 2 }] }));
    const got: number[][] = [];
    const s = { event: (id: number, code: number) => void got.push([id, code]) };
    expect(mirror.drainClipEvents(s)).toBe(2);
    expect(got).toEqual([
      [7, 1],
      [8, 2],
    ]);
    expect(mirror.drainClipEvents(s)).toBe(0);
    expect(mirror.drainStreamEvents(s)).toBe(1);
    const many = Array.from({ length: 64 }, (_, i) => ({ clipId: i, code: 1 }));
    const blocks = MIRROR_EVENT_CAPACITY / 64 + 1;
    for (let k = 0; k < blocks; k++) mirror.apply(makeStatusBlock({ clipEvents: many.map((e) => ({ clipId: e.clipId + k * 64, code: 1 })) }));
    expect(mirror.pendingClipEvents).toBe(MIRROR_EVENT_CAPACITY);
    expect(mirror.droppedEvents).toBe(64);
    got.length = 0;
    mirror.drainClipEvents(s);
    expect(got[0]![0]).toBe(64);
    expect(got.at(-1)![0]).toBe(blocks * 64 - 1);
  });

  it("freeEndedInMessage frees ended slots in apply (tab hidden)", () => {
    const { table, mirror } = setup();
    const a = table.allocate(0, 1, 0, P);
    mirror.freeEndedInMessage = true;
    mirror.apply(makeStatusBlock({ ended: [a] }));
    expect(table.isLive(a)).toBe(false);
    expect(table.liveCount).toBe(0);
  });

  it("attach applies every STATUS a CoreLink receives in onmessage", () => {
    const { table, mirror } = setup();
    const port: LinkPort = { postMessage: vi.fn(), onmessage: null };
    const link = new CoreLink(port);
    const unsubscribe = mirror.attach(link);
    const a = table.allocate(0, 1, 0, P);
    const buffer = new ArrayBuffer(16384);
    writeStatus(new DataView(buffer), 0, makeStatusBlock({ ended: [a], currentFrame: 768 }), 1);
    expect(new DataView(buffer).getUint32(0, true)).toBe(MAGIC);
    port.onmessage!({ data: buffer });
    expect(table.state[indexOf(a)]).toBe(VoiceState.ENDING);
    expect(mirror.currentFrame).toBe(768);
    expect(port.postMessage).toHaveBeenCalledTimes(1); // the RECYCLE
    unsubscribe();
    const again = new ArrayBuffer(16384);
    writeStatus(new DataView(again), 0, makeStatusBlock({ currentFrame: 1024 }), 2);
    port.onmessage!({ data: again });
    expect(mirror.currentFrame).toBe(768);
  });
});
