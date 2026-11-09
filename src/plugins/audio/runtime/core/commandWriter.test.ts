// A1.4 (lead): the command writer (api-and-models §4.2).
import { describe, it } from "vitest";

describe("CommandWriter (§4.2)", () => {
  it.todo("records round-trip through the generated readers, asap records keep the 0xFFFFFFFF sentinel");
  it.todo("a stamped record's frameOffset is its frame minus firstFrame; the header's firstFrame is the earliest stamp");
  it.todo("records are stable-sorted by frame");
  it.todo("a full batch carries the excess into the next batch with absolute frames preserved");
  it.todo("a batch never exceeds 64 KB");
  it.todo("an empty pool posts nothing and keeps everything staged");
  it.todo("a full staging area drops the newest and the next batch carries the overflow flag");
  it.todo("drainCommands writes STOP and FADE with seconds converted to frames");
  it.todo("posting allocates nothing in steady state");
});
