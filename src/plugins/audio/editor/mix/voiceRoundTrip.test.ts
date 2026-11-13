// ADR 0171/0172 (Rc3g; api-and-models §5.6, §6.3): the voice table end to end. Voices start, stop, are stolen, go virtual and
// real through the real `EventSink` (a busRef, `gen << 8 | slot`, and a clip name per call) into a recorder's ring; the ring's
// span is opened as a live capture through `CaptureSource` and the Worker handler; `reconstructVoices` then gives the rows
// with their clip and bus names. A clip is named through the NAMES records the sink wrote, a bus by its slot through META.
import { describe, expect, it } from "vitest";
import { assembleCapture } from "../../runtime/capture/format";
import { createEventSink } from "../../runtime/capture/events";
import { createRecorder, type EpochContext } from "../../runtime/capture/recorder";
import { SAMPLE_HEADER, SAMPLE_META, SAMPLE_RATE, keyframeCodecForTests, statusBytes } from "../../runtime/capture/testSupport";
import { CaptureSource } from "./profilerSource";
import { inProcessWorker } from "./voiceSceneSupport";
import { nameLookup, reconstructVoices, voiceTable } from "./voiceTableModel";

const CONTEXT: EpochContext = { sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0 };
const MUSIC = 1;
const SFX = 2;
/** The slot table's `busRef(slot)` at generation 3: nothing may read the generation as a slot. */
const ref = (slot: number): number => (3 << 8) | slot;

/** A recorder and its sink, a STATUS feed and the capture they make, opened through the Worker handler as a live view. */
async function record(script: (sink: ReturnType<typeof createEventSink>, feed: (frame: number) => void) => void, buses: Record<number, string>) {
  let t = 1000;
  const now = () => (t += 1);
  const r = createRecorder({ ringBytes: 4 * 1024 * 1024, codec: keyframeCodecForTests(), now });
  r.begin(0, CONTEXT);
  const sink = createEventSink(r, { now });
  const feed = (frame: number) => {
    const block = statusBytes(frame);
    const data = block.buffer.slice(block.byteOffset, block.byteOffset + block.byteLength) as ArrayBuffer;
    r.tap(data, block.byteLength, new DataView(data));
  };
  feed(768);
  script(sink, feed);
  const meta = { ...SAMPLE_META, names: { ...SAMPLE_META.names, clips: {}, buses } };
  const source = await CaptureSource.openLive(assembleCapture(SAMPLE_HEADER, meta, []).slice().buffer, { worker: inProcessWorker() });
  await source.appendSegment(r.takeSpan().bytes.slice().buffer);
  return source;
}

describe("voices through the real EventSink, a recorder ring and the reader", () => {
  it("rows carry the clip and bus names; stopped voices are gone; steals, virtual and real states and the thief read back", async () => {
    const source = await record((s, feed) => {
      s.voiceStart(1, "jump.ogg", ref(MUSIC), 0, 0, 0.5);
      s.voiceStart(2, "land.ogg", ref(SFX), 0, 0, 0.75);
      s.voiceStart(3, "step.ogg", ref(SFX), 0, 0, 1);
      s.voiceStart(4, "boom.ogg", ref(SFX), 0, 0, 0.25);
      feed(1536);
      s.voiceStop(2, "stopped"); // a real stop: the row goes
      s.voiceVirtual(3, "belowAudibility");
      s.voiceStart(5, "jump.ogg", ref(MUSIC), 0, 0, 1);
      s.voiceSteal(5, 4, "busMaxVoices"); // stolen, thief 4
      s.voiceStart(6, "hit.ogg", ref(SFX), 0, 0, 0.125);
      s.voiceVirtual(6, "capDemoted");
      s.voiceReal(6, "promoted"); // back to playing
      s.voiceRefused("nope.ogg", ref(SFX), "busFull"); // never a row
      s.voiceQueued("later.ogg", ref(MUSIC), "clipLoading"); // never a row
      feed(2304);
    }, { [MUSIC]: "Music", [SFX]: "SFX" });
    const state = await source.seek(2304 / SAMPLE_RATE);
    const replay = reconstructVoices(state, nameLookup(source.summary.names));
    const rows = replay.rows.map((r) => ({ id: r.id, clip: r.clipName, bus: r.busName, slot: r.slot, state: r.stateName, reason: r.reasonText, thief: r.thief, gain: r.gain }));
    expect(rows.sort((a, b) => a.id - b.id)).toEqual([
      { id: 1, clip: "jump.ogg", bus: "Music", slot: MUSIC, state: "playing", reason: "", thief: null, gain: 0.5 },
      { id: 3, clip: "step.ogg", bus: "SFX", slot: SFX, state: "virtual", reason: "below audibility", thief: null, gain: 1 },
      { id: 4, clip: "boom.ogg", bus: "SFX", slot: SFX, state: "playing", reason: "", thief: null, gain: 0.25 },
      { id: 5, clip: "jump.ogg", bus: "Music", slot: MUSIC, state: "stolen", reason: "bus max voices", thief: 4, gain: 1 },
      { id: 6, clip: "hit.ogg", bus: "SFX", slot: SFX, state: "playing", reason: "promoted", thief: null, gain: 0.125 },
    ]);
    // One NAMES record per clip name, none for a bus: a bus is named by its slot from META.
    expect(source.summary.names.buses).toEqual([[MUSIC, "Music"], [SFX, "SFX"]]);
    expect(source.summary.names.clips.map(([, n]) => n).sort()).toEqual(["boom.ogg", "hit.ogg", "jump.ogg", "land.ogg", "nope.ogg", "later.ogg", "step.ogg"].sort());
    source.close();
  });

  it("a bus filter finds the voices on it by name", async () => {
    const source = await record((s, feed) => {
      s.voiceStart(1, "a.ogg", ref(MUSIC), 0, 0, 1);
      s.voiceStart(2, "b.ogg", ref(SFX), 0, 0, 1);
      feed(1536);
    }, { [MUSIC]: "Music", [SFX]: "SFX" });
    const replay = reconstructVoices(await source.seek(1536 / SAMPLE_RATE), nameLookup(source.summary.names));
    expect(voiceTable(replay, "music").rows.map((r) => r.id)).toEqual([1]);
    expect(voiceTable(replay, "sfx").rows.map((r) => r.id)).toEqual([2]);
    source.close();
  });

  it("a slot the capture doesn't name reads as its number, not as another bus", async () => {
    const source = await record((s, feed) => {
      s.voiceStart(1, "a.ogg", ref(7), 0, 0, 1);
      feed(1536);
    }, { [MUSIC]: "Music" });
    const replay = reconstructVoices(await source.seek(1536 / SAMPLE_RATE), nameLookup(source.summary.names));
    expect(replay.rows.map((r) => r.busName)).toEqual(["bus 7"]);
    source.close();
  });
});
