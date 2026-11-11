// ADR 0162 B4: the main side of an ambisonic (wide) stream, on a fake decoder client: the open carries the sidecar's
// convention, `streamOpened` checks the channel count against the sidecar as the registry checks a clip, a FuMa stream's
// import gain reaches the backend, and a wide stream's starves count in `wideStarved` (C24).
import { describe, expect, it } from "vitest";
import type { AmbisonicImport } from "../../../../engine/scene/importSettings";
import type { StreamOpenOptions, StreamReply } from "../decoder/decoderClient";
import type { ClipInfo } from "../decoder/protocol";
import { StreamEvent } from "../wire.generated";
import { StreamManager, type StreamDecoderLike } from "./streams";
import { VoiceState, VoiceTable } from "./voiceTable";

function rig(sidecar: AmbisonicImport | null) {
  const table = new VoiceTable(8);
  const opens: StreamOpenOptions[] = [];
  let listener: ((r: StreamReply) => void) | null = null;
  const decoder: StreamDecoderLike = {
    generation: 1,
    connectWorklet: () => {},
    openStream: (o) => void opens.push(o),
    closeStream: () => {},
    onStream: (l) => {
      listener = l;
      return () => {};
    },
  };
  const errors: string[] = [];
  const gains: [number, number][] = [];
  const streams = new StreamManager({
    table,
    decoder: () => decoder,
    connectWorklet: () => {},
    channel: () => ({ worker: { onmessage: null, postMessage: () => {} }, worklet: { onmessage: null, postMessage: () => {} } }),
    fetchBytes: async () => new ArrayBuffer(8),
    onError: (_id, _asset, message) => void errors.push(message),
    ambisonic: () => sidecar,
    onImportGain: (voice, gain) => void gains.push([voice, gain]),
  });
  const voice = table.allocate(0, 128, 0 as never, VoiceState.PLAYING);
  const id = streams.allocate();
  return {
    streams,
    voice,
    id,
    opens,
    errors,
    gains,
    async open(asset: string) {
      streams.register(id, voice, asset, false);
      streams.open(id);
      await new Promise((r) => setTimeout(r, 0));
    },
    opened(info: Partial<ClipInfo>) {
      listener?.({ type: "streamOpened", streamId: id, epoch: 1, info: { rate: 48_000, channels: 16, frames: 480_000, framesEstimate: 480_000, codec: 1, lengthKnown: true, ...info } });
    },
  };
}

describe("wide streams on main (ADR 0162 B4)", () => {
  it("opens with the sidecar's convention; a FuMa stream's import gain goes to the backend", async () => {
    const r = rig({ order: 3, convention: "fuma" });
    await r.open("amb/forest.wav");
    expect(r.opens[0]).toMatchObject({ streamId: r.id, convention: "fuma" });
    r.opened({ channels: 16, importGain: Math.SQRT2 });
    expect(r.gains).toEqual([[r.voice, Math.SQRT2]]);
    expect(r.errors).toEqual([]);
  });

  it("a stream without a sidecar opens without a convention", async () => {
    const r = rig(null);
    await r.open("music/town.ogg");
    expect(r.opens[0]!.convention).toBeUndefined();
    r.opened({ channels: 2 });
    expect(r.errors).toEqual([]);
    expect(r.gains).toEqual([]);
  });

  it("a channel count the sidecar disagrees with fails the stream, as a clip's load fails", async () => {
    const r = rig({ order: 1, convention: "ambix" });
    await r.open("amb/forest.wav");
    r.opened({ channels: 16 });
    expect(r.errors).toEqual(["audio decoder: ambisonic order 1 needs 4 channels, but the file has 16"]);
    const mp3 = rig({ order: null, convention: "ambix" });
    await mp3.open("amb/forest.mp3");
    mp3.opened({ channels: 9 });
    expect(mp3.errors[0]).toMatch(/order 2 \(9 channels\) needs a WAV file/);
  });

  it("counts a wide stream's starves in wideStarved, and every stream's in starves", async () => {
    const r = rig({ order: null, convention: "ambix" });
    await r.open("amb/forest.wav");
    r.opened({ channels: 4 });
    r.streams.streamEvent(r.id, StreamEvent.Starved);
    r.streams.streamEvent(r.id, StreamEvent.Starved);
    const stereo = rig(null);
    await stereo.open("music/a.wav");
    stereo.opened({ channels: 2 });
    stereo.streams.streamEvent(stereo.id, StreamEvent.Starved);
    expect([r.streams.stats.starves, r.streams.stats.wideStarved]).toEqual([2, 2]);
    expect([stereo.streams.stats.starves, stereo.streams.stats.wideStarved]).toEqual([1, 0]);
  });
});
