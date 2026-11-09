import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { AudioHandle, MAX_FADE_GAIN, REASON_NAMES, _resetHandleWarningsForTests, warnOnce } from "./handle";
import { VoiceReason, VoiceState, type VoiceReasonCode, type VoiceTableHandleApi } from "./voiceTable";

// A1.1-L2 fills these (api-and-models §1 `AudioHandle`, §3 "Handle encoding"): `AudioHandle` against a small fake
// `VoiceTableHandleApi` built in this file (typed arrays for gen, state and reason; `requestStop`, `requestFade` and
// `endedReason` as `vi.fn`s), so the handle's own rules are proven without the real table.

/** §3 `id = (gen << 16 | index) >>> 0`, written out here because `ids.ts` is another leaf's stub. */
function idOf(index: number, gen: number): number {
  return ((gen << 16) | index) >>> 0;
}

/** A fake table of `slots` slots, all FREE at generation 1. `requestStop` marks the slot STOPPING, as the real table does. */
function makeTable(slots = 4) {
  const gen = new Uint16Array(slots).fill(1);
  const state = new Uint8Array(slots);
  const reason = new Uint8Array(slots);
  const endedReason = vi.fn((_id: number): VoiceReasonCode => VoiceReason.NONE);
  const requestStop = vi.fn((id: number, _fadeSeconds: number) => {
    state[id & 0xffff] = VoiceState.STOPPING;
  });
  const requestFade = vi.fn((_id: number, _to: number, _seconds: number) => {});
  const table: VoiceTableHandleApi = { gen, state, reason, endedReason, requestStop, requestFade };
  return { table, gen, state, reason, endedReason, requestStop, requestFade };
}

/** Makes slot `index` a live voice at generation `gen` in `state` with `reason`, and returns its id. */
function setSlot(t: ReturnType<typeof makeTable>, index: number, state: number, reason: number = VoiceReason.NONE, gen = 1): number {
  t.gen[index] = gen;
  t.state[index] = state;
  t.reason[index] = reason;
  return idOf(index, 1);
}

describe("AudioHandle against a fake table (§1)", () => {
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    _resetHandleWarningsForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("an inert handle (id 0) reads playing false and reason null, and stop/fade are no-ops that never touch the table", () => {
    const t = makeTable();
    setSlot(t, 0, VoiceState.PLAYING);
    const inert = AudioHandle.inert();
    expect(inert.playing).toBe(false);
    expect(inert.reason).toBeNull();
    inert.stop(1);
    inert.fade(2, 1);
    const zeroIdWithTable = new AudioHandle(t.table, 0);
    expect(zeroIdWithTable.playing).toBe(false);
    expect(zeroIdWithTable.reason).toBeNull();
    zeroIdWithTable.stop();
    zeroIdWithTable.fade(2, 1);
    expect(t.requestStop).not.toHaveBeenCalled();
    expect(t.requestFade).not.toHaveBeenCalled();
    expect(t.endedReason).not.toHaveBeenCalled();
  });

  it("AudioHandle.inert(reason) reads that reason and playing false", () => {
    expect(AudioHandle.inert("stolen").reason).toBe("stolen");
    expect(AudioHandle.inert("failed").reason).toBe("failed");
    expect(AudioHandle.inert("busMuted").reason).toBe("busMuted");
    expect(AudioHandle.inert("stolen").playing).toBe(false);
    expect(AudioHandle.inert().reason).toBeNull();
  });

  it("playing is true for LOCKED, PLAYING, VIRTUAL and WAITING_FOR_DATA with reason NONE, VIRTUAL, BUS_MUTED, LOCKED or WAITING_FOR_DATA", () => {
    const t = makeTable();
    const states = [VoiceState.LOCKED, VoiceState.PLAYING, VoiceState.VIRTUAL, VoiceState.WAITING_FOR_DATA];
    const reasons = [VoiceReason.NONE, VoiceReason.VIRTUAL, VoiceReason.BUS_MUTED, VoiceReason.LOCKED, VoiceReason.WAITING_FOR_DATA];
    for (const s of states) {
      for (const r of reasons) {
        const id = setSlot(t, 0, s, r);
        expect(new AudioHandle(t.table, id).playing).toBe(true);
      }
    }
  });

  it("playing is false for STOPPING, ENDING and FREE, and for reason STOLEN or FAILED", () => {
    const t = makeTable();
    for (const s of [VoiceState.STOPPING, VoiceState.ENDING, VoiceState.FREE]) {
      const id = setSlot(t, 0, s, VoiceReason.NONE);
      expect(new AudioHandle(t.table, id).playing).toBe(false);
    }
    for (const s of [VoiceState.LOCKED, VoiceState.PLAYING, VoiceState.VIRTUAL, VoiceState.WAITING_FOR_DATA]) {
      for (const r of [VoiceReason.STOLEN, VoiceReason.FAILED]) {
        const id = setSlot(t, 0, s, r);
        expect(new AudioHandle(t.table, id).playing).toBe(false);
      }
    }
  });

  it("playing is false once the slot's generation differs from the id's", () => {
    const t = makeTable();
    const id = setSlot(t, 0, VoiceState.PLAYING);
    const handle = new AudioHandle(t.table, id);
    expect(handle.playing).toBe(true);
    t.gen[0] = 2;
    expect(handle.playing).toBe(false);
  });

  it("reason maps each code through REASON_NAMES while current; NONE reads null", () => {
    const t = makeTable();
    for (let code = 0; code <= 6; code++) {
      const id = setSlot(t, 0, VoiceState.PLAYING, code);
      expect(new AudioHandle(t.table, id).reason).toBe(REASON_NAMES[code]);
    }
    setSlot(t, 0, VoiceState.PLAYING, VoiceReason.NONE);
    expect(new AudioHandle(t.table, idOf(0, 1)).reason).toBeNull();
    expect(t.endedReason).not.toHaveBeenCalled();
  });

  it("reason while STOPPING or ENDING is null unless the slot's reason is STOLEN or FAILED", () => {
    const t = makeTable();
    for (const s of [VoiceState.STOPPING, VoiceState.ENDING]) {
      expect(new AudioHandle(t.table, setSlot(t, 0, s, VoiceReason.STOLEN)).reason).toBe("stolen");
      expect(new AudioHandle(t.table, setSlot(t, 0, s, VoiceReason.FAILED)).reason).toBe("failed");
      expect(new AudioHandle(t.table, setSlot(t, 0, s, VoiceReason.NONE)).reason).toBeNull();
      expect(new AudioHandle(t.table, setSlot(t, 0, s, VoiceReason.VIRTUAL)).reason).toBeNull();
      expect(new AudioHandle(t.table, setSlot(t, 0, s, VoiceReason.BUS_MUTED)).reason).toBeNull();
    }
  });

  it("reason after the id is stale is endedReason's STOLEN or FAILED, else null, and is cached after the first read", () => {
    const t = makeTable();
    const id = setSlot(t, 0, VoiceState.PLAYING);
    const handle = new AudioHandle(t.table, id);
    t.gen[0] = 2;
    t.state[0] = VoiceState.PLAYING;
    t.endedReason.mockReturnValueOnce(VoiceReason.STOLEN);
    expect(handle.reason).toBe("stolen");
    t.endedReason.mockReturnValue(VoiceReason.FAILED);
    expect(handle.reason).toBe("stolen");
    expect(t.endedReason).toHaveBeenCalledTimes(1);
    expect(t.endedReason).toHaveBeenCalledWith(id);

    const failedHandle = new AudioHandle(t.table, idOf(1, 1));
    t.endedReason.mockReturnValue(VoiceReason.FAILED);
    expect(failedHandle.reason).toBe("failed");

    for (const code of [VoiceReason.NONE, VoiceReason.VIRTUAL, VoiceReason.BUS_MUTED, VoiceReason.LOCKED, VoiceReason.WAITING_FOR_DATA]) {
      const h = new AudioHandle(t.table, idOf(2, 1));
      t.endedReason.mockReturnValue(code);
      expect(h.reason).toBeNull();
    }
  });

  it("stop() calls requestStop(id, 0) once; a second call (state now STOPPING) is a no-op", () => {
    const t = makeTable();
    const id = setSlot(t, 0, VoiceState.PLAYING);
    const handle = new AudioHandle(t.table, id);
    handle.stop();
    expect(t.requestStop).toHaveBeenCalledTimes(1);
    expect(t.requestStop).toHaveBeenCalledWith(id, 0);
    expect(handle.playing).toBe(false);
    handle.stop();
    handle.stop(2);
    expect(t.requestStop).toHaveBeenCalledTimes(1);
  });

  it("stop(fade) passes the fade; NaN, Infinity and negative fades become 0 and warn once", () => {
    const t = makeTable();
    const id = setSlot(t, 0, VoiceState.PLAYING);
    const handle = new AudioHandle(t.table, id);
    handle.stop(0.5);
    expect(t.requestStop).toHaveBeenLastCalledWith(id, 0.5);
    expect(warn).not.toHaveBeenCalled();

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      setSlot(t, 0, VoiceState.PLAYING);
      new AudioHandle(t.table, id).stop(bad);
      expect(t.requestStop).toHaveBeenLastCalledWith(id, 0);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/^\[myco\] /);
  });

  it("stop and fade on a stale id never call the table", () => {
    const t = makeTable();
    const id = setSlot(t, 0, VoiceState.PLAYING);
    const handle = new AudioHandle(t.table, id);
    t.gen[0] = 2;
    handle.stop(1);
    handle.fade(2, 1);
    t.gen[0] = 1;
    t.state[0] = VoiceState.FREE;
    handle.stop(1);
    handle.fade(2, 1);
    t.gen[0] = 1;
    t.state[0] = VoiceState.ENDING;
    handle.stop(1);
    handle.fade(2, 1);
    expect(t.requestStop).not.toHaveBeenCalled();
    expect(t.requestFade).not.toHaveBeenCalled();
  });

  it("fade clamps `to` to 0..4 (warning once), ignores a non-finite `to` (warning once), and turns a bad `seconds` into 0", () => {
    const t = makeTable();
    const id = setSlot(t, 0, VoiceState.PLAYING);
    const handle = new AudioHandle(t.table, id);

    handle.fade(9, 1);
    expect(t.requestFade).toHaveBeenLastCalledWith(id, MAX_FADE_GAIN, 1);
    handle.fade(-2, 1);
    expect(t.requestFade).toHaveBeenLastCalledWith(id, 0, 1);
    expect(warn).toHaveBeenCalledTimes(1);

    handle.fade(Number.NaN, 1);
    handle.fade(Number.POSITIVE_INFINITY, 1);
    expect(t.requestFade).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);

    handle.fade(1.5, -1);
    expect(t.requestFade).toHaveBeenLastCalledWith(id, 1.5, 0);
    handle.fade(1.5, Number.NaN);
    expect(t.requestFade).toHaveBeenLastCalledWith(id, 1.5, 0);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("no method throws, whatever it is given", () => {
    const t = makeTable();
    const id = setSlot(t, 0, VoiceState.PLAYING);
    const handle = new AudioHandle(t.table, id);
    const weird = [null, undefined, "x", {}, Symbol("s"), Number.NaN, Number.NEGATIVE_INFINITY, () => 1] as never[];
    for (const v of weird) {
      expect(() => handle.stop(v)).not.toThrow();
      expect(() => handle.fade(v, 1)).not.toThrow();
      expect(() => handle.fade(1, v)).not.toThrow();
      expect(() => AudioHandle.inert(v)).not.toThrow();
    }
    t.endedReason.mockReturnValue(undefined as never);
    const stale = new AudioHandle(t.table, idOf(1, 3));
    expect(() => stale.reason).not.toThrow();
    expect(() => stale.playing).not.toThrow();
  });

  it("warnOnce warns once per key with the [myco] prefix until _resetHandleWarningsForTests", () => {
    warnOnce("test.key", "first message");
    warnOnce("test.key", "second message");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenLastCalledWith("[myco] first message");
    warnOnce("test.other", "other");
    expect(warn).toHaveBeenCalledTimes(2);
    _resetHandleWarningsForTests();
    warnOnce("test.key", "again");
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenLastCalledWith("[myco] again");
  });
});
