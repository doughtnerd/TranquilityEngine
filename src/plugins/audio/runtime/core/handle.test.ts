import { describe, it } from "vitest";

// A1.1-L2 fills these (api-and-models §1 `AudioHandle`, §3 "Handle encoding"): `AudioHandle` against a small fake
// `VoiceTableHandleApi` built in this file (typed arrays for gen, state and reason; `requestStop`, `requestFade` and
// `endedReason` as `vi.fn`s), so the handle's own rules are proven without the real table.
describe("AudioHandle against a fake table (§1)", () => {
  it.todo("an inert handle (id 0) reads playing false and reason null, and stop/fade are no-ops that never touch the table");
  it.todo("AudioHandle.inert(reason) reads that reason and playing false");
  it.todo("playing is true for LOCKED, PLAYING, VIRTUAL and WAITING_FOR_DATA with reason NONE, VIRTUAL, BUS_MUTED, LOCKED or WAITING_FOR_DATA");
  it.todo("playing is false for STOPPING, ENDING and FREE, and for reason STOLEN or FAILED");
  it.todo("playing is false once the slot's generation differs from the id's");
  it.todo("reason maps each code through REASON_NAMES while current; NONE reads null");
  it.todo("reason while STOPPING or ENDING is null unless the slot's reason is STOLEN or FAILED");
  it.todo("reason after the id is stale is endedReason's STOLEN or FAILED, else null, and is cached after the first read");
  it.todo("stop() calls requestStop(id, 0) once; a second call (state now STOPPING) is a no-op");
  it.todo("stop(fade) passes the fade; NaN, Infinity and negative fades become 0 and warn once");
  it.todo("stop and fade on a stale id never call the table");
  it.todo("fade clamps `to` to 0..4 (warning once), ignores a non-finite `to` (warning once), and turns a bad `seconds` into 0");
  it.todo("no method throws, whatever it is given");
  it.todo("warnOnce warns once per key with the [myco] prefix until _resetHandleWarningsForTests");
});
