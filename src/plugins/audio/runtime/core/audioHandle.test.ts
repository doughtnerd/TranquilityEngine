import { describe, it, expect, vi } from "vitest";
import { VoiceTable, VoiceState, VoiceReason } from "./voiceTable";
import { StatusMirror, makeStatusBlock } from "./mirror";
import { AudioHandle } from "./handle";
import { voiceIndex } from "./ids";

// A1.1-L3 fills these (api-and-models §1 `AudioHandle` and "Semantics", §3 voice table and "Handle encoding",
// architecture §2.2, §3.2, §4.2): the handle end to end on the real `VoiceTable` and `StatusMirror`. A voice is made
// with `table.allocate(...)` and `new AudioHandle(table, id)`; the core's reports arrive as
// `mirror.apply(makeStatusBlock({ ended: [id] }))`; a frame passing is `table.freeEnded()`.

const BUS = 0;
const WORLD = 1;

function commandSink() {
  return { stop: vi.fn(), fade: vi.fn() };
}

describe("AudioHandle on the voice table (§1)", () => {
  describe("playing", () => {
    it("reads true right after the voice is allocated (a script reading playing after playOneShot sees true)", () => {
      const table = new VoiceTable(8);
      const id = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      expect(new AudioHandle(table, id).playing).toBe(true);
    });

    it("is true while LOCKED, VIRTUAL and WAITING_FOR_DATA (they exist and keep time)", () => {
      const table = new VoiceTable(8);
      const handles = [VoiceState.LOCKED, VoiceState.VIRTUAL, VoiceState.WAITING_FOR_DATA].map(
        (state) => new AudioHandle(table, table.allocate(BUS, 10, WORLD, state)),
      );
      for (const handle of handles) expect(handle.playing).toBe(true);
    });

    it("turns false as soon as STATUS reports the voice ended, before the frame frees the slot", () => {
      const table = new VoiceTable(8);
      const mirror = new StatusMirror(table);
      const id = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      const handle = new AudioHandle(table, id);
      mirror.apply(makeStatusBlock({ ended: [id] }));
      expect(handle.playing).toBe(false);
      expect(table.isLive(id)).toBe(true);
    });

    it("stays false after the frame frees the slot and after the slot is reused by another voice", () => {
      const table = new VoiceTable(1);
      const mirror = new StatusMirror(table);
      const first = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      const handle = new AudioHandle(table, first);
      mirror.apply(makeStatusBlock({ ended: [first] }));
      expect(table.freeEnded()).toBe(1);
      expect(handle.playing).toBe(false);
      const second = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      expect(voiceIndex(second)).toBe(voiceIndex(first));
      expect(second).not.toBe(first);
      expect(handle.playing).toBe(false);
    });

    it("is false at once after stop(), and after stop(0.5) while the core is still fading", () => {
      const table = new VoiceTable(8);
      const a = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      const handleA = new AudioHandle(table, a);
      handleA.stop();
      expect(handleA.playing).toBe(false);

      const b = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      const handleB = new AudioHandle(table, b);
      handleB.stop(0.5);
      expect(handleB.playing).toBe(false);

      const sink = commandSink();
      table.drainCommands(sink);
      expect(sink.stop).toHaveBeenCalledWith(b, 0.5);
    });

    it("is false for a voice stolen by a higher-priority play, whose slot the new voice takes", () => {
      const table = new VoiceTable(1);
      const low = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      const handle = new AudioHandle(table, low);
      const high = table.allocate(BUS, 200, WORLD, VoiceState.PLAYING);
      expect(high).not.toBe(0);
      expect(voiceIndex(high)).toBe(voiceIndex(low));
      expect(handle.playing).toBe(false);
    });

    it("is false for a voice freed as failed (table.free(id, VoiceReason.FAILED))", () => {
      const table = new VoiceTable(8);
      const id = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      const handle = new AudioHandle(table, id);
      table.free(id, VoiceReason.FAILED);
      expect(handle.playing).toBe(false);
    });
  });

  describe("reason", () => {
    it("is null while audible (PLAYING, reason NONE)", () => {
      const table = new VoiceTable(8);
      const id = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      expect(new AudioHandle(table, id).reason).toBeNull();
    });

    it("reads virtual after STATUS demotes the voice", () => {
      const table = new VoiceTable(8);
      const mirror = new StatusMirror(table);
      const id = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      const handle = new AudioHandle(table, id);
      mirror.apply(makeStatusBlock({ demoted: [id] }));
      expect(handle.reason).toBe("virtual");
      expect(handle.playing).toBe(true);
    });

    it("reads waitingForData after STATUS reports the voice starved", () => {
      const table = new VoiceTable(8);
      const mirror = new StatusMirror(table);
      const id = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      const handle = new AudioHandle(table, id);
      mirror.apply(makeStatusBlock({ starved: [id] }));
      expect(handle.reason).toBe("waitingForData");
    });

    it("reads stolen after the voice is stolen, and still after the stealer's slot is freed and reused again", () => {
      const table = new VoiceTable(1);
      const low = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      const handle = new AudioHandle(table, low);
      const high = table.allocate(BUS, 200, WORLD, VoiceState.PLAYING);
      expect(handle.reason).toBe("stolen");

      table.free(high, VoiceReason.NONE);
      const third = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      expect(voiceIndex(third)).toBe(voiceIndex(low));
      expect(handle.reason).toBe("stolen");
    });

    it("reads failed after a failed load frees it", () => {
      const table = new VoiceTable(8);
      const id = table.allocate(BUS, 10, WORLD, VoiceState.LOCKED);
      const handle = new AudioHandle(table, id);
      table.free(id, VoiceReason.FAILED);
      expect(handle.reason).toBe("failed");
    });

    it("is null after a natural end and after a normal stop", () => {
      const table = new VoiceTable(8);
      const mirror = new StatusMirror(table);

      const a = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      const handleA = new AudioHandle(table, a);
      mirror.apply(makeStatusBlock({ ended: [a] }));
      expect(handleA.reason).toBeNull();
      table.freeEnded();
      expect(handleA.reason).toBeNull();

      const b = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      const handleB = new AudioHandle(table, b);
      handleB.stop();
      expect(handleB.reason).toBeNull();
      mirror.apply(makeStatusBlock({ ended: [b] }));
      table.freeEnded();
      expect(handleB.reason).toBeNull();
    });
  });

  describe("stop and fade", () => {
    it("stop() queues one STOP with fade 0; drainCommands hands it to the sink with the voice's id", () => {
      const table = new VoiceTable(8);
      const id = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      new AudioHandle(table, id).stop();
      const sink = commandSink();
      table.drainCommands(sink);
      expect(sink.stop).toHaveBeenCalledTimes(1);
      expect(sink.stop).toHaveBeenCalledWith(id, 0);
      expect(sink.fade).not.toHaveBeenCalled();
    });

    it("a second stop() is a no-op: one STOP only", () => {
      const table = new VoiceTable(8);
      const id = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      const handle = new AudioHandle(table, id);
      handle.stop();
      handle.stop(0.3);
      const sink = commandSink();
      table.drainCommands(sink);
      expect(sink.stop).toHaveBeenCalledTimes(1);
      expect(sink.stop).toHaveBeenCalledWith(id, 0);
    });

    it("stop on a LOCKED or WAITING_FOR_DATA voice frees it at once and queues nothing", () => {
      const table = new VoiceTable(8);
      const locked = table.allocate(BUS, 10, WORLD, VoiceState.LOCKED);
      const waiting = table.allocate(BUS, 10, WORLD, VoiceState.WAITING_FOR_DATA);
      const lockedHandle = new AudioHandle(table, locked);
      const waitingHandle = new AudioHandle(table, waiting);
      lockedHandle.stop();
      waitingHandle.stop();
      expect(lockedHandle.playing).toBe(false);
      expect(waitingHandle.playing).toBe(false);
      expect(table.isLive(locked)).toBe(false);
      expect(table.isLive(waiting)).toBe(false);
      expect(table.pendingCommands).toBe(0);
      const sink = commandSink();
      table.drainCommands(sink);
      expect(sink.stop).not.toHaveBeenCalled();
    });

    it("fade(to, seconds) sets fadeGain at once and queues one FADE; a second fade in the frame replaces it", () => {
      const table = new VoiceTable(8);
      const id = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      const handle = new AudioHandle(table, id);
      handle.fade(0.5, 1);
      expect(table.fadeGain[voiceIndex(id)]).toBeCloseTo(0.5);
      handle.fade(2, 0.25);
      expect(table.fadeGain[voiceIndex(id)]).toBeCloseTo(2);
      const sink = commandSink();
      table.drainCommands(sink);
      expect(sink.fade).toHaveBeenCalledTimes(1);
      expect(sink.fade).toHaveBeenCalledWith(id, 2, 0.25);
      expect(sink.stop).not.toHaveBeenCalled();
    });

    it("fade clamps to 0..4", () => {
      const table = new VoiceTable(8);
      const id = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      const handle = new AudioHandle(table, id);
      handle.fade(9, 0);
      expect(table.fadeGain[voiceIndex(id)]).toBeCloseTo(4);
      handle.fade(-1, 0);
      expect(table.fadeGain[voiceIndex(id)]).toBeCloseTo(0);
      const sink = commandSink();
      table.drainCommands(sink);
      expect(sink.fade).toHaveBeenCalledTimes(1);
      expect(sink.fade).toHaveBeenCalledWith(id, 0, 0);
    });

    it("after the voice ends or its slot is reused, stop and fade do nothing to the new occupant", () => {
      const table = new VoiceTable(1);
      const mirror = new StatusMirror(table);
      const old = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      const oldHandle = new AudioHandle(table, old);
      mirror.apply(makeStatusBlock({ ended: [old] }));
      table.freeEnded();
      oldHandle.stop();
      oldHandle.fade(0.1, 0);
      expect(table.pendingCommands).toBe(0);

      const fresh = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      const freshHandle = new AudioHandle(table, fresh);
      oldHandle.stop();
      oldHandle.fade(0.1, 0);
      expect(freshHandle.playing).toBe(true);
      expect(table.fadeGain[voiceIndex(fresh)]).toBeCloseTo(1);
      expect(table.pendingCommands).toBe(0);
      const sink = commandSink();
      table.drainCommands(sink);
      expect(sink.stop).not.toHaveBeenCalled();
      expect(sink.fade).not.toHaveBeenCalled();
    });
  });

  describe("generations", () => {
    it("a handle kept across 70,000 reuses of its slot (the generation wraps past 65535) never reads the new voice", () => {
      const table = new VoiceTable(1);
      const first = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      const kept = new AudioHandle(table, first);
      table.free(first, VoiceReason.NONE);
      for (let i = 0; i < 70_000; i++) {
        const id = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
        table.free(id, VoiceReason.NONE);
      }
      const fresh = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      expect(voiceIndex(fresh)).toBe(voiceIndex(first));
      expect(fresh).not.toBe(first);
      expect(new AudioHandle(table, fresh).playing).toBe(true);

      expect(kept.playing).toBe(false);
      expect(kept.reason).toBeNull();
      const sink = commandSink();
      kept.stop();
      kept.fade(0.5, 0);
      table.drainCommands(sink);
      expect(sink.stop).not.toHaveBeenCalled();
      expect(sink.fade).not.toHaveBeenCalled();
    });

    it("an ended id from an older generation arriving in STATUS doesn't end the slot's current voice", () => {
      const table = new VoiceTable(1);
      const mirror = new StatusMirror(table);
      const old = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      table.free(old, VoiceReason.NONE);
      const current = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      const handle = new AudioHandle(table, current);
      mirror.apply(makeStatusBlock({ ended: [old] }));
      expect(handle.playing).toBe(true);
      expect(table.freeEnded()).toBe(0);
      expect(table.isLive(current)).toBe(true);
    });

    it("an inert handle (refused play) reads playing false and never throws", () => {
      const table = new VoiceTable(1);
      const high = table.allocate(BUS, 200, WORLD, VoiceState.PLAYING);
      const refused = table.allocate(BUS, 10, WORLD, VoiceState.PLAYING);
      expect(refused).toBe(0);
      expect(table.isLive(high)).toBe(true);
      const handle = new AudioHandle(table, refused);
      expect(handle.playing).toBe(false);
      expect(() => {
        handle.stop();
        handle.stop(0.5);
        handle.fade(1, 0);
        handle.fade(Number.NaN, 0);
        handle.fade(1, -1);
      }).not.toThrow();
      expect(handle.playing).toBe(false);
    });
  });
});
