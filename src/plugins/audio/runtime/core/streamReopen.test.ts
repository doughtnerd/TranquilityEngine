// FU2: where a stream reopens after a hard rebuild is frame-driven: a stamp `STREAM_REOPEN_LEAD_SECONDS` ahead of
// F_now, and the stream's own position there (its last STATUS playhead while it played, run on at its rate), not an
// estimate anchored at its first PLAY, which counts the frames it waited for its first chunks. (The end-to-end case is
// `streamRebuild.test.ts`.)
import { describe, expect, it } from "vitest";
import type { StatusBlock } from "../wire.generated";
import { makeStatusBlock } from "./mirror";
import { reopenStamp, STREAM_REOPEN_LEAD_SECONDS, StreamManager, type StreamDecoderLike } from "./streams";
import { VoiceFlag, VoiceReason, VoiceState, VoiceTable } from "./voiceTable";

const RATE = 48_000;

function rig() {
  const table = new VoiceTable(8);
  const decoder: StreamDecoderLike = { generation: 1, connectWorklet: () => {}, openStream: () => {}, closeStream: () => {}, onStream: () => () => {} };
  // The backend's estimate: anchored at the PLAY (context frame 0, stream frame 0), one stream frame per context frame.
  const streams = new StreamManager({
    table,
    decoder: () => decoder,
    connectWorklet: () => {},
    channel: () => ({ worker: { onmessage: null, postMessage: () => {} }, worklet: { onmessage: null, postMessage: () => {} } }),
    fetchBytes: async () => new ArrayBuffer(8),
    onError: () => {},
    positionAt: (_voice, frame) => frame,
    rateOf: () => 1,
  });
  let listener: ((s: StatusBlock) => void) | null = null;
  streams.attach({
    onStatus: (l) => {
      listener = l;
      return () => {};
    },
  });
  const voice = table.allocate(0, 128, 0 as never, VoiceState.PLAYING);
  const i = voice & 0xffff;
  table.flags[i] = table.flags[i]! | VoiceFlag.STREAM;
  const id = streams.allocate();
  streams.register(id, voice, "music/long.wav", false);
  streams.open(id, 0);
  const status = (currentFrame: number, clipFrame: number, starved = false) =>
    listener!(makeStatusBlock({ currentFrame, playheads: [{ id: voice, clipFrame }], starved: starved ? [voice] : [] }));
  return { streams, table, voice, id, status };
}

describe("a stream's reopen after a hard rebuild (FU2)", () => {
  it("is stamped the lead ahead of F_now, and asap before the clock has an estimate", () => {
    expect(STREAM_REOPEN_LEAD_SECONDS).toBeGreaterThan(0);
    expect(reopenStamp(40_960, RATE)).toBe(40_960 + STREAM_REOPEN_LEAD_SECONDS * RATE);
    expect(reopenStamp(1_000.4, RATE)).toBe(Math.round(1_000.4 + STREAM_REOPEN_LEAD_SECONDS * RATE));
    expect(reopenStamp(0, RATE)).toBe(0);
  });

  it("resumes from the stream's own position, not counting the frames it waited for its first chunks", () => {
    const { streams, table, voice, id, status } = rig();
    expect(table.reason[voice & 0xffff]).toBe(VoiceReason.WAITING_FOR_DATA);
    // Before any STATUS shows it playing: the backend's estimate.
    expect(streams.resumeFrame(id, voice, 2_000)).toBe(2_000);
    // Its first chunks landed late: held at 0 until context frame 3,072, then playing.
    status(2_048, 0);
    status(4_096, 1_024);
    expect(table.reason[voice & 0xffff]).toBe(VoiceReason.NONE);
    status(4_224, 1_152);
    // 3,072 frames behind the estimate anchored at its PLAY, wherever it is asked for.
    expect(streams.resumeFrame(id, voice, 10_000)).toBe(10_000 - 3_072);
    expect(streams.resumeFrame(id, voice, 40_960 + 4_800)).toBe(40_960 + 4_800 - 3_072);
  });

  it("does not count the frames it starved either", () => {
    const { streams, voice, id, status } = rig();
    status(4_096, 1_024);
    status(8_192, 5_120);
    // Starved at 5,120 for 2,048 frames, then playing again.
    status(9_216, 5_120, true);
    status(10_240, 5_120, true);
    status(12_288, 7_168);
    status(12_416, 7_296);
    expect(streams.resumeFrame(id, voice, 20_000)).toBe(7_296 + (20_000 - 12_416));
  });
});
