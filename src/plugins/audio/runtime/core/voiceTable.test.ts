import { describe, it } from "vitest";

// A1.1 (lead): the voice table's slots, free list, generations, stealing, command queue and lifecycle hooks
// (api-and-models §3; architecture §3.9; A0.8's host listener).
describe("VoiceTable (§3)", () => {
  it.todo("allocates every array once, sized to capacity, and hands out slot 0 first");
  it.todo("free bumps the generation, skipping 0, and pushes the slot back on the free list");
  it.todo("a stale id is not live and free/markEnded/requestStop on it do nothing");
  it.todo("a full table steals the lowest priority, then the lowest audibility, voice and the new voice takes its slot");
  it.todo("a full table refuses a play when every voice's priority is at or above the new one's");
  it.todo("a bus at maxVoices steals from that bus before the global limit applies");
  it.todo("STOPPING and ENDING voices are stolen first");
  it.todo("onFree runs once per free with the id and bus, for end, stop, steal, failure and World release");
  it.todo("drainCommands emits each queued stop and fade once, skips freed slots, and empties the queue");
  it.todo("remapBuses applies bus[i] = map[bus[i]] to live voices and recounts busLive");
  it.todo("releaseWorld stops that World's voices with 10 ms fades and frees its unsent ones, leaving other Worlds alone");
  it.todo("connectVoiceTable follows a real host's reconfigure and releaseWorld");
  it.todo("no per-frame allocation: a steady-state play, report, free and drain loop keeps every array and its length");
});
