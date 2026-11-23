// ADR 0351 §5 step 5 (A3/A5): a converted loose sound plays. A tone encoded to Ogg Vorbis by the real encoder ships under
// its `.wav` name (as the export places it), the build's media table lists it, the game's decoder reads it whatever the
// extension says (symphonia probes the content), and the real core on the loopback renders it, through `Audio.playOneShot`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { createAudioDecoder, DECODER_WASM_URL } from "../../../../export/audioDecode";
import { createNodeAudioEncoder } from "../../../../export/audioEncoderNode";
import { closeLoopbackAudio, loopbackAudio, LOOPBACK_RATE } from "../testing";
import { installAudioMedia } from "./mediaTable";
import { readFile } from "node:fs/promises";

afterEach(async () => {
  await closeLoopbackAudio();
  installAudioMedia(null);
  Assets.clearSources();
  vi.restoreAllMocks();
});

describe("a converted loose sound", () => {
  it("plays Ogg Vorbis bytes behind a .wav name on the core", { timeout: 60_000 }, async (ctx) => {
    // 0.3 s of a 440 Hz tone, stereo, encoded as the export would (Vorbis, quality 0.5).
    const frames = Math.round(0.3 * LOOPBACK_RATE);
    const pcm = new Float32Array(frames * 2).map((_, i) => 0.25 * Math.sin((2 * Math.PI * 440 * (i >> 1)) / LOOPBACK_RATE));
    const encoder = createNodeAudioEncoder({ workers: 1 });
    let vorbis: Uint8Array;
    try {
      vorbis = (await encoder.encode({ pcm, channels: 2, sampleRate: LOOPBACK_RATE, codec: "vorbis", quality: 0.5, rateCeiling: null, mono: false })).bytes;
    } finally {
      encoder.close();
    }
    expect(new TextDecoder().decode(vorbis.subarray(0, 4))).toBe("OggS");
    // The game's decoder reads the bytes under the .wav name (the rig's frames turn only microtasks, so it runs first).
    const d = await createAudioDecoder(() => readFile(DECODER_WASM_URL))(vorbis, "audio/step.wav");
    expect([d.channels, d.sampleRate]).toEqual([2, LOOPBACK_RATE]);
    expect(d.pcm.length / 2).toBe(frames);
    const left = new Float32Array(frames), right = new Float32Array(frames);
    for (let i = 0; i < frames; i++) (left[i] = d.pcm[2 * i]!, right[i] = d.pcm[2 * i + 1]!);
    const decodedPaths: string[] = [];

    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "audio/step.wav": "blob:converted-step" }));
    installAudioMedia({ platform: "web", packages: [], media: { "audio/step.wav": { codec: "vorbis", load: "decode", rate: LOOPBACK_RATE, channels: 2, frames } } });
    const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }] } } });
    await SceneManager.load("s.json");
    engine.world.render = {} as never;
    const loop = await loopbackAudio({
      // The rig's registry asks for the path the clip resolver chose; the decoded Vorbis answers it.
      decode: (path) => {
        decodedPaths.push(path);
        return { channelData: [left, right], sampleRate: d.sampleRate };
      },
      recovery: { now: () => 0, warn: () => {} },
    });
    if (!loop) return ctx.skip();
    const h = loop.Audio.playOneShot("audio/step.wav");
    expect(h.playing).toBe(true);
    let heard = 0;
    for (let f = 0; f < 40; f++) {
      const { left, right } = await loop.step();
      for (let i = 0; i < left.length; i++) heard = Math.max(heard, Math.abs(left[i]!), Math.abs(right[i]!));
    }
    expect(decodedPaths).toEqual(["audio/step.wav"]);
    expect(heard, "the converted sound was heard").toBeGreaterThan(0.1);
    engine.dispose();
  });
});
