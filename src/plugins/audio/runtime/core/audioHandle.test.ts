import { describe, it } from "vitest";

// A1.1-L3 fills these (api-and-models §1 `AudioHandle` and "Semantics", §3 voice table and "Handle encoding",
// architecture §2.2, §3.2, §4.2): the handle end to end on the real `VoiceTable` and `StatusMirror`. A voice is made
// with `table.allocate(...)` and `new AudioHandle(table, id)`; the core's reports arrive as
// `mirror.apply(makeStatusBlock({ ended: [id] }))`; a frame passing is `table.freeEnded()`.
describe("AudioHandle on the voice table (§1)", () => {
  describe("playing", () => {
    it.todo("reads true right after the voice is allocated (a script reading playing after playOneShot sees true)");
    it.todo("is true while LOCKED, VIRTUAL and WAITING_FOR_DATA (they exist and keep time)");
    it.todo("turns false as soon as STATUS reports the voice ended, before the frame frees the slot");
    it.todo("stays false after the frame frees the slot and after the slot is reused by another voice");
    it.todo("is false at once after stop(), and after stop(0.5) while the core is still fading");
    it.todo("is false for a voice stolen by a higher-priority play, whose slot the new voice takes");
    it.todo("is false for a voice freed as failed (table.free(id, VoiceReason.FAILED))");
  });
  describe("reason", () => {
    it.todo("is null while audible (PLAYING, reason NONE)");
    it.todo("reads virtual after STATUS demotes the voice");
    it.todo("reads waitingForData after STATUS reports the voice starved");
    it.todo("reads stolen after the voice is stolen, and still after the stealer's slot is freed and reused again");
    it.todo("reads failed after a failed load frees it");
    it.todo("is null after a natural end and after a normal stop");
  });
  describe("stop and fade", () => {
    it.todo("stop() queues one STOP with fade 0; drainCommands hands it to the sink with the voice's id");
    it.todo("a second stop() is a no-op: one STOP only");
    it.todo("stop on a LOCKED or WAITING_FOR_DATA voice frees it at once and queues nothing");
    it.todo("fade(to, seconds) sets fadeGain at once and queues one FADE; a second fade in the frame replaces it");
    it.todo("fade clamps to 0..4");
    it.todo("after the voice ends or its slot is reused, stop and fade do nothing to the new occupant");
  });
  describe("generations", () => {
    it.todo("a handle kept across 70,000 reuses of its slot (the generation wraps past 65535) never reads the new voice");
    it.todo("an ended id from an older generation arriving in STATUS doesn't end the slot's current voice");
    it.todo("an inert handle (refused play) reads playing false and never throws");
  });
});
