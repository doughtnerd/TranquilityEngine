import { describe, it } from "vitest";

// A1.1 (lead): the STATUS mirror applied in `onmessage` (api-and-models §3 "Status mirror", §4.3).
describe("StatusMirror (§3, §4.3)", () => {
  it.todo("ended ids mark live voices ENDING and stale ids are ignored");
  it.todo("demoted, starved and playheads reach the table");
  it.todo("peaks and counters take the newest block; minSlackSinceFrame the minimum until beginFrame");
  it.todo("clip and stream events queue in order and drain once; overflow drops the oldest and counts");
  it.todo("freeEndedInMessage frees ended slots in apply (tab hidden)");
  it.todo("attach applies every STATUS a CoreLink receives in onmessage");
});
