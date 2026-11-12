import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAudioSettings, type AudioSettings, type BusSettings } from "../../../../engine/audio/settings";
import { MAX_BUSES } from "../../../../engine/audio/settings";
import { AudioHost, CoreLink, presetFromSettings } from "./context";
import { makeStatusBlock, StatusMirror } from "./mirror";
import { Unlock, type UnlockContext } from "./unlock";
import { connectVoiceTable, MAX_STEM_PENDING, VoiceFlag,VoiceReason, VoiceState, VoiceTable, WORLD_RELEASE_FADE_SECONDS, type VoiceCommandSink } from "./voiceTable";

// A1.1 (lead): the voice table's slots, free list, generations, stealing, command queue and lifecycle hooks
// (api-and-models §3; architecture §3.9; A0.8's host listener). Ids are decoded inline here (`ids.ts` is a leaf's).
const indexOf = (id: number) => id & 0xffff;
const genOf = (id: number) => id >>> 16;

const P = VoiceState.PLAYING;

function sink() {
  const s = { stop: vi.fn<(id: number, fade: number) => void>(), fade: vi.fn<(id: number, to: number, seconds: number) => void>() };
  return s satisfies VoiceCommandSink;
}

describe("VoiceTable (§3)", () => {
  it("allocates every array once, sized to capacity, and hands out slot 0 first", () => {
    const t = new VoiceTable(16);
    expect(t.gen.length).toBe(16);
    expect(t.startFrame.length).toBe(16);
    expect(t.busLive.length).toBe(MAX_BUSES);
    const a = t.allocate(0, 128, 0, P);
    const b = t.allocate(0, 128, 0, P);
    expect(indexOf(a)).toBe(0);
    expect(indexOf(b)).toBe(1);
    expect(genOf(a)).toBe(1);
    expect(t.liveCount).toBe(2);
    // Defaults (§3): volume, pitch and fadeGain 1, minDist 1, maxDist 100, owner -1.
    expect([t.volume[0], t.pitch[0], t.fadeGain[0], t.minDist[0], t.maxDist[0], t.owner[0]]).toEqual([1, 1, 1, 1, 100, -1]);
    expect(t.reason[0]).toBe(VoiceReason.NONE);
    expect(() => new VoiceTable(0)).toThrow(RangeError);
  });

  it("allocate's reason matches the starting state", () => {
    const t = new VoiceTable(8);
    expect(t.reason[indexOf(t.allocate(0, 1, 0, VoiceState.LOCKED))]).toBe(VoiceReason.LOCKED);
    expect(t.reason[indexOf(t.allocate(0, 1, 0, VoiceState.VIRTUAL))]).toBe(VoiceReason.VIRTUAL);
    expect(t.reason[indexOf(t.allocate(0, 1, 0, VoiceState.WAITING_FOR_DATA))]).toBe(VoiceReason.WAITING_FOR_DATA);
  });

  it("free bumps the generation, skipping 0, and pushes the slot back on the free list", () => {
    const t = new VoiceTable(4);
    const a = t.allocate(0, 128, 0, P);
    expect(t.free(a, VoiceReason.NONE)).toBe(true);
    expect(t.gen[0]).toBe(2);
    expect(t.freeTop).toBe(4);
    const b = t.allocate(0, 128, 0, P);
    expect(indexOf(b)).toBe(0);
    expect(genOf(b)).toBe(2);
    // Wrap: 65535 goes to 1, never 0.
    t.gen[0] = 0xffff;
    const c = ((0xffff << 16) | 0) >>> 0;
    expect(t.isLive(c)).toBe(true);
    t.free(c, VoiceReason.NONE);
    expect(t.gen[0]).toBe(1);
  });

  it("a stale id is not live and free/markEnded/requestStop on it do nothing", () => {
    const t = new VoiceTable(4);
    const a = t.allocate(0, 128, 0, P);
    t.free(a, VoiceReason.NONE);
    const b = t.allocate(0, 128, 0, P);
    expect(indexOf(b)).toBe(indexOf(a));
    expect(t.isLive(a)).toBe(false);
    expect(t.free(a, VoiceReason.NONE)).toBe(false);
    expect(t.markEnded(a)).toBe(false);
    t.requestStop(a, 0);
    t.requestFade(a, 0.5, 1);
    expect(t.state[indexOf(b)]).toBe(P);
    expect(t.pendingCommands).toBe(0);
    for (const bad of [0, -1, 1.5, NaN, 2 ** 32, 5]) expect(t.isLive(bad)).toBe(false); // 5: gen 0
  });

  it("a full table steals the lowest priority, then the lowest audibility, voice and the new voice takes its slot", () => {
    const t = new VoiceTable(4);
    const ids = [t.allocate(0, 100, 0, P), t.allocate(0, 50, 0, P), t.allocate(0, 50, 0, P), t.allocate(0, 200, 0, P)];
    t.audibility[1] = 0.5;
    t.audibility[2] = 0.1;
    const n = t.allocate(0, 120, 0, P);
    expect(indexOf(n)).toBe(2);
    expect(t.isLive(ids[2]!)).toBe(false);
    expect(t.endedReason(ids[2]!)).toBe(VoiceReason.STOLEN);
    expect(t.stolenCount).toBe(1);
    expect(t.liveCount).toBe(4);
  });

  it("a full table refuses a play when every voice's priority is at or above the new one's", () => {
    const t = new VoiceTable(2);
    t.allocate(0, 100, 0, P);
    t.allocate(0, 100, 0, P);
    expect(t.allocate(0, 100, 0, P)).toBe(0);
    expect(t.refusedCount).toBe(1);
    expect(t.liveCount).toBe(2);
  });

  it("a bus at maxVoices steals from that bus before the global limit applies", () => {
    const t = new VoiceTable(8);
    t.setBusLimits([0, 2]);
    const low0 = t.allocate(0, 1, 0, P); // lowest priority overall, but on another bus
    const a = t.allocate(1, 50, 0, P);
    const b = t.allocate(1, 60, 0, P);
    const c = t.allocate(1, 70, 0, P);
    expect(t.isLive(a)).toBe(false);
    expect(indexOf(c)).toBe(indexOf(a));
    expect(t.isLive(low0) && t.isLive(b)).toBe(true);
    expect(t.busLive[1]).toBe(2);
    // The bus's own voices all outrank it: refused even though the table has room.
    expect(t.allocate(1, 10, 0, P)).toBe(0);
  });

  it("STOPPING and ENDING voices are stolen first", () => {
    const t = new VoiceTable(3);
    t.allocate(0, 1, 0, P);
    const loud = t.allocate(0, 255, 0, P);
    t.allocate(0, 1, 0, P);
    t.requestStop(loud, 0.5);
    const n = t.allocate(0, 2, 0, P);
    expect(indexOf(n)).toBe(indexOf(loud));
  });

  it("onFree runs once per free with the id and bus, for end, stop, steal, failure and World release", () => {
    const t = new VoiceTable(2);
    const freed: Array<[number, number]> = [];
    t.onFree = (id, bus) => freed.push([id, bus]);
    const ended = t.allocate(3, 10, 0, P);
    t.markEnded(ended);
    t.freeEnded();
    const locked = t.allocate(4, 10, 0, VoiceState.LOCKED);
    t.requestStop(locked, 0); // never sent: freed at once
    const failed = t.allocate(5, 10, 0, VoiceState.WAITING_FOR_DATA);
    t.free(failed, VoiceReason.FAILED);
    expect(t.endedReason(failed)).toBe(VoiceReason.FAILED);
    const victim = t.allocate(6, 10, 0, P);
    t.allocate(6, 10, 0, P);
    t.allocate(7, 20, 0, P); // steals victim
    const unsent = t.allocate(8, 30, 9, VoiceState.LOCKED); // steals the other bus-6 voice
    t.releaseWorld(9);
    expect(freed.map(([, bus]) => bus)).toEqual([3, 4, 5, 6, 6, 8]);
    expect(freed[0]![0]).toBe(ended);
    expect(freed[3]![0]).toBe(victim);
    expect(freed[5]![0]).toBe(unsent);
    // Its slot was reused twice since: the one-generation memory reads NONE (the handle caches what it read first).
    expect(t.endedReason(failed)).toBe(VoiceReason.NONE);
  });

  it("drainCommands emits each queued stop and fade once, skips freed slots, and empties the queue", () => {
    const t = new VoiceTable(4);
    const a = t.allocate(0, 1, 0, P);
    const b = t.allocate(0, 1, 0, P);
    const c = t.allocate(0, 1, 0, P);
    t.requestFade(a, 0.2, 1);
    t.requestFade(a, 0.7, 2); // replaces
    expect(t.fadeGain[indexOf(a)]).toBeCloseTo(0.7);
    t.requestStop(a, 0.25);
    t.requestStop(b, 0);
    t.requestFade(c, 0.5, 0);
    t.markEnded(c);
    t.freeEnded(); // c freed before the drain
    expect(t.pendingCommands).toBe(3);
    const s = sink();
    t.drainCommands(s);
    expect(s.fade.mock.calls).toEqual([[a, Math.fround(0.7), 2]]);
    expect(s.stop.mock.calls).toEqual([
      [a, 0.25],
      [b, 0],
    ]);
    expect(t.flags[indexOf(a)]! & VoiceFlag.STOP_ON_FADE_END).toBeTruthy();
    expect(t.pendingCommands).toBe(0);
    const s2 = sink();
    t.drainCommands(s2);
    expect(s2.stop).not.toHaveBeenCalled();
  });

  it("a slot freed and reused within a frame is listed once and only carries the new voice's commands", () => {
    const t = new VoiceTable(1);
    const a = t.allocate(0, 1, 0, P);
    t.requestStop(a, 0.1);
    t.free(a, VoiceReason.NONE);
    const b = t.allocate(0, 1, 0, P);
    t.requestFade(b, 2, 0.5);
    expect(t.pendingCommands).toBe(1);
    const s = sink();
    t.drainCommands(s);
    expect(s.stop).not.toHaveBeenCalled();
    expect(s.fade.mock.calls).toEqual([[b, 2, 0.5]]);
  });

  it("remapBuses applies bus[i] = map[bus[i]] to live voices and recounts busLive", () => {
    const t = new VoiceTable(4);
    t.allocate(0, 1, 0, P);
    t.allocate(1, 1, 0, P);
    t.allocate(2, 1, 0, P);
    t.remapBuses(Uint8Array.of(0, 2)); // bus 2 is past the map: the root
    expect(Array.from(t.bus.subarray(0, 3))).toEqual([0, 2, 0]);
    expect(t.busLive[0]).toBe(2);
    expect(t.busLive[1]).toBe(0);
    expect(t.busLive[2]).toBe(1);
  });

  it("releaseWorld stops that World's voices with 10 ms fades and frees its unsent ones, leaving other Worlds alone", () => {
    const t = new VoiceTable(8);
    const mine = t.allocate(0, 1, 3, P);
    const mineVirtual = t.allocate(0, 1, 3, VoiceState.VIRTUAL);
    const mineLocked = t.allocate(0, 1, 3, VoiceState.LOCKED);
    const other = t.allocate(0, 1, 4, P);
    const none = t.allocate(0, 1, 0, P);
    expect(t.releaseWorld(3)).toBe(3);
    expect(t.state[indexOf(mine)]).toBe(VoiceState.STOPPING);
    expect(t.state[indexOf(mineVirtual)]).toBe(VoiceState.STOPPING);
    expect(t.world[indexOf(mine)]).toBe(0);
    expect(t.isLive(mineLocked)).toBe(false);
    expect(t.state[indexOf(other)]).toBe(P);
    expect(t.state[indexOf(none)]).toBe(P);
    expect(t.releaseWorld(0)).toBe(0);
    const s = sink();
    t.drainCommands(s);
    expect(s.stop.mock.calls).toEqual([
      [mine, Math.fround(WORLD_RELEASE_FADE_SECONDS)],
      [mineVirtual, Math.fround(WORLD_RELEASE_FADE_SECONDS)],
    ]);
  });

  it("connectVoiceTable follows a real host's reconfigure and releaseWorld", async () => {
    const host = fakeHost();
    const t = new VoiceTable(8);
    const remove = connectVoiceTable(t, host);
    host.reconfigure(settingsWith(["Master", "Music", "SFX"]));
    const world = {};
    const key = host.attachWorld(world).key;
    const sfx = t.allocate(2, 1, key, P);
    const music = t.allocate(1, 1, 0, P);
    host.reconfigure(settingsWith(["Master", "SFX"])); // SFX moves to 1, Music is gone (root)
    expect(t.bus[indexOf(sfx)]).toBe(1);
    expect(t.bus[indexOf(music)]).toBe(0);
    host.releaseWorld(key);
    expect(t.state[indexOf(sfx)]).toBe(VoiceState.STOPPING);
    expect(t.state[indexOf(music)]).toBe(P);
    remove();
    host.reconfigure(settingsWith(["Master", "Other"]));
    expect(t.bus[indexOf(sfx)]).toBe(1);
    await host.close();
  });

  it("no per-frame allocation: a steady-state play, report, free and drain loop keeps every array and its length", () => {
    const t = new VoiceTable(64);
    const mirror = new StatusMirror(t);
    let freedCount = 0;
    t.onFree = () => void freedCount++;
    const arrays = new Map<string, { ref: ArrayBufferView; bytes: number }>();
    const snapshot = (owner: object, prefix: string) => {
      for (const [k, v] of Object.entries(owner)) if (ArrayBuffer.isView(v)) arrays.set(prefix + k, { ref: v, bytes: v.byteLength });
    };
    snapshot(t, "table.");
    snapshot(mirror, "mirror.");
    expect(arrays.size).toBeGreaterThan(40);
    const keysBefore = [Object.keys(t).length, Object.keys(mirror).length];
    // One block object reused, its sections refilled in place (in the engine, the link builds it).
    const ended: number[] = new Array(8).fill(0);
    const block = makeStatusBlock({ ended, peaks: [{ l: 0.5, r: 0.25 }], clipEvents: [{ clipId: 1, code: 1 }], playheads: [{ id: 0, clipFrame: 0 }] });
    const commandSink: VoiceCommandSink = { stop() {}, fade() {} };
    const eventSink = { event() {} };
    const live = new Uint32Array(64);
    let liveTop = 0;
    for (let frame = 0; frame < 20_000; frame++) {
      // Main: a few plays (the table is often full, so steals and refusals run too), a stop, a fade.
      for (let k = 0; k < 4; k++) {
        const id = t.allocate(frame & 3, (frame * 7 + k) & 255, 1, P);
        if (id !== 0 && liveTop < live.length) live[liveTop++] = id;
      }
      if (liveTop > 0) {
        t.requestFade(live[0]!, 0.5, 0.1);
        t.requestStop(live[liveTop - 1]!, 0.01);
      }
      t.drainCommands(commandSink);
      // Status: the core ends the oldest eight.
      const n = Math.min(8, liveTop);
      ended.length = n;
      for (let k = 0; k < n; k++) ended[k] = live[k]!;
      block.playheads[0]!.id = live[0] ?? 0;
      block.playheads[0]!.clipFrame = frame;
      block.minSlackFrames = 100 - (frame % 50);
      mirror.apply(block);
      live.copyWithin(0, n, liveTop);
      liveTop -= n;
      // Frame: apply the queues.
      mirror.beginFrame();
      t.freeEnded();
      mirror.drainClipEvents(eventSink);
    }
    expect(freedCount).toBeGreaterThan(10_000);
    for (const [name, { ref, bytes }] of arrays) {
      const owner = name.startsWith("table.") ? t : mirror;
      expect((owner as unknown as Record<string, unknown>)[name.slice(name.indexOf(".") + 1)], name).toBe(ref);
      expect(ref.byteLength, name).toBe(bytes);
    }
    expect([Object.keys(t).length, Object.keys(mirror).length]).toEqual(keysBefore);
    expect(t.liveCount + t.freeTop).toBe(t.capacity);
  });
});

function settingsWith(names: string[]): AudioSettings {
  const base = defaultAudioSettings();
  const buses: BusSettings[] = names.map((name, i) => ({ name, parent: i === 0 ? undefined : names[0], volume: 1, mute: false, effects: [] }));
  return { ...base, buses };
}

/** A host from fakes (as `audioLifecycle.test.ts` builds them). */
function fakeHost(): AudioHost {
  const context = {
    state: "suspended",
    destination: {},
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    addEventListener() {},
    removeEventListener() {},
  };
  const node = { port: { postMessage: vi.fn(), onmessage: null }, connect: vi.fn(), disconnect: vi.fn() };
  const link = new CoreLink(node.port);
  const unlock = new Unlock({ target: new EventTarget(), context: context as unknown as UnlockContext });
  return AudioHost._create({
    context: context as unknown as AudioContext,
    node: node as unknown as AudioWorkletNode,
    link,
    unlock,
    preset: presetFromSettings(defaultAudioSettings()),
  });
}

afterEach(() => vi.restoreAllMocks());

// F-9b: a music stem's level (`stemDry` for dry-gain writes, `stemGain` for audibility; `musicOps.paramsShaped` sets it).
describe("VoiceTable stem level (F-9b)", () => {
  it("is 1 by default and again for the slot's next voice", () => {
    const t = new VoiceTable(8);
    const id = t.allocate(0, 128, 0, P);
    const i = indexOf(id);
    expect(t.stemGain[i]).toBe(1);
    expect(t.stemDry[i]).toBe(1);
    t.setStemLevel(i, 0.25, undefined, 100);
    t.setStemLevel(i, 0.5, 1000, 100);
    t.free(id, VoiceReason.NONE);
    expect(t.stemPendingTotal).toBe(0);
    const next = t.allocate(0, 128, 0, P);
    expect(indexOf(next)).toBe(i);
    expect(t.stemGain[i]).toBe(1);
    expect(t.stemDry[i]).toBe(1);
    expect(t.stemCount[i]).toBe(0);
  });

  it("an asap level applies at once; a stamp not after now is asap", () => {
    const t = new VoiceTable(8);
    const i = indexOf(t.allocate(0, 128, 0, P));
    t.setStemLevel(i, 0.5, undefined, 100);
    expect(t.stemDry[i]).toBe(0.5);
    expect(t.stemGain[i]).toBe(0.5);
    t.setStemLevel(i, 0.25, 100, 100);
    expect(t.stemDry[i]).toBe(0.25);
    expect(t.stemCount[i]).toBe(0);
  });

  it("a stamped rise counts for audibility at once and for the dry gain at its stamp", () => {
    const t = new VoiceTable(8);
    const i = indexOf(t.allocate(0, 128, 0, P));
    t.setStemLevel(i, 0, undefined, 0);
    t.setStemLevel(i, 1, 1000, 100, 960, 1);
    expect(t.stemGain[i]).toBe(1);
    expect(t.stemDry[i]).toBe(0);
    expect(t.stemRamp[i * MAX_STEM_PENDING]).toBe(960);
    expect(t.stemShape[i * MAX_STEM_PENDING]).toBe(1);
    t.resolveStems(999);
    expect(t.stemDry[i]).toBe(0);
    t.resolveStems(1000);
    expect(t.stemDry[i]).toBe(1);
    expect(t.stemGain[i]).toBe(1);
    expect(t.stemPendingTotal).toBe(0);
  });

  it("a stamped fall keeps audibility and the dry gain up until its stamp (R3a)", () => {
    const t = new VoiceTable(8);
    const i = indexOf(t.allocate(0, 128, 0, P));
    t.setStemLevel(i, 0.5, 1000, 100);
    expect(t.stemGain[i]).toBe(1);
    expect(t.stemDry[i]).toBe(1);
    t.resolveStems(1500);
    expect(t.stemGain[i]).toBe(0.5);
    expect(t.stemDry[i]).toBe(0.5);
  });

  it("pending changes land in frame order (equal frames: the latest wins); a fifth applies the earliest", () => {
    const t = new VoiceTable(8);
    const i = indexOf(t.allocate(0, 128, 0, P));
    t.setStemLevel(i, 0.2, 3000, 0);
    t.setStemLevel(i, 0.4, 2000, 0);
    t.setStemLevel(i, 0.6, 2000, 0);
    expect(t.stemGain[i]).toBe(1);
    t.resolveStems(2000);
    expect(t.stemDry[i]).toBeCloseTo(0.6, 6);
    expect(t.stemGain[i]).toBeCloseTo(0.6, 6); // max(0.6, the 0.2 still to come)
    t.setStemLevel(i, 0.1, 4000, 2000);
    t.setStemLevel(i, 0.3, 5000, 2000);
    t.setStemLevel(i, 0.7, 6000, 2000);
    t.setStemLevel(i, 0.9, 7000, 2000); // a fifth: the earliest (0.2 at 3000) applies now
    expect(t.stemCount[i]).toBe(MAX_STEM_PENDING);
    expect(t.stemDry[i]).toBeCloseTo(0.2, 6);
    t.resolveStems(10_000);
    expect(t.stemDry[i]).toBeCloseTo(0.9, 6);
    expect(t.stemPendingTotal).toBe(0);
  });

  it("a context swap carries pending frames through seconds, landing nothing meanwhile", () => {
    const t = new VoiceTable(8);
    const i = indexOf(t.allocate(0, 128, 0, P));
    t.setStemLevel(i, 0.5, 48_000, 0);
    t.stampedToTimeline(48_000, 10); // frame 48,000 is Audio.time 11
    t.resolveStems(1e9);
    expect(t.stemDry[i]).toBe(1);
    t.stampedFromTimeline(44_100, 5); // the new context: Audio.time 11 is its frame 264,600
    expect(t.stemAt[i * MAX_STEM_PENDING]).toBeCloseTo(264_600, 6);
    t.resolveStems(264_599);
    expect(t.stemDry[i]).toBe(1);
    t.resolveStems(264_600);
    expect(t.stemDry[i]).toBe(0.5);
  });
});
