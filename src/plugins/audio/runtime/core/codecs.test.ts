// B4: AAC opt-in and the unknown-codec warning on the core (codecs.ts), end to end on the loopback rig (the real
// decoder handler and wasm in process):
// - with `audio.codecs.aac` off, an `.m4a` / `.mp4` / `.aac` asset doesn't load (not even fetched), its voices read
//   `reason` "failed", and there is one warning per asset naming the setting, however often it is played or reloaded;
// - a file the decoder can't open (Ogg Opus, garbage) fails with one warning per asset naming its format and the
//   supported list, and its voices read "failed", as a clip and as a stream.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aacRefusal, createWarnOnce, DECODE_ERR_CODEC, DECODE_ERR_FORMAT, isAacPath, unsupportedFormat } from "./codecs";
import { rig } from "../../testing/streamRig";

const FIXTURES = new URL("../../../../../native/audio/crates/audio-decode/tests/fixtures/", import.meta.url);
const read = (name: string): ArrayBuffer => {
  const b = readFileSync(fileURLToPath(new URL(name, FIXTURES)));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

afterEach(() => vi.restoreAllMocks());

describe("codecs.ts", () => {
  it("knows AAC by its extension and refuses it only while the setting is off", () => {
    expect(["a.m4a", "b/c.MP4", "d.aac", "e.mp3", "f.m4a.ogg", "aac", ".m4a"].map(isAacPath)).toEqual([true, true, true, false, false, false, false]);
    expect(aacRefusal("music/x.m4a", true)).toBeNull();
    expect(aacRefusal("music/x.ogg", false)).toBeNull();
    expect(aacRefusal("music/x.m4a", false)).toContain("audio.codecs.aac");
  });

  it("names the format and the supported list for the decoder's format and codec errors only", () => {
    const m = unsupportedFormat("sfx/a.opus", false, DECODE_ERR_CODEC, "unsupported codec opus")!;
    expect(m).toContain('"sfx/a.opus"');
    expect(m).toContain("(.opus)");
    expect(m).toContain("Supported: WAV, FLAC, MP3 and Ogg Vorbis (AAC with audio.codecs.aac on)");
    expect(unsupportedFormat("sfx/blob", true, DECODE_ERR_FORMAT, "x")).toContain("a file without an extension");
    expect(unsupportedFormat("sfx/blob", true, DECODE_ERR_FORMAT, "x")).toContain("and AAC (.m4a, .mp4, .aac)");
    expect(unsupportedFormat("sfx/a.wav", false, -5, "truncated")).toBeNull();
    expect(unsupportedFormat("sfx/a.wav", false, undefined, "worker died")).toBeNull();
  });

  it("createWarnOnce warns once per key", () => {
    const seen: string[] = [];
    const once = createWarnOnce((m) => seen.push(m));
    once("a", "1");
    once("a", "2");
    once("b", "3");
    expect(seen).toEqual(["1", "3"]);
  });
});

/** Plays `path` (clip or stream) and steps until the voice has ended; returns its handle. */
async function playToFailure(r: NonNullable<Awaited<ReturnType<typeof rig>>>, path: string, stream: boolean) {
  const voice = r.backend.play({ path, url: "", loop: true, stream, bus: "Music" })!;
  await vi.waitFor(
    async () => {
      await r.step(1);
      await r.settle();
      expect(voice.playing).toBe(false);
    },
    { timeout: 5_000, interval: 1 },
  );
  // A few more frames: a clip with no references unloads, so the next play loads it again.
  await r.step(4);
  await r.settle();
  return voice;
}

const warnings = (spy: { mock: { calls: unknown[][] } }, needle: string) => spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(needle));

describe("AAC opt-in and unknown formats on the core (B4)", () => {
  it("with audio.codecs.aac off, AAC doesn't load: voices read failed, one warning per asset naming the setting, nothing fetched", async (ctx) => {
    const m4a = read("tone-48000-stereo.m4a");
    const r = await rig({ "music/s.m4a": m4a, "music/t.aac": m4a }, { clipFiles: { "music/c.m4a": m4a } });
    if (!r) return ctx.skip();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let pass = 0; pass < 2; pass++) {
      for (const [path, stream] of [["music/c.m4a", false], ["music/s.m4a", true], ["music/t.aac", true]] as const) {
        const v = await playToFailure(r, path, stream);
        expect(v.reason, `${path} pass ${pass}`).toBe("failed");
      }
    }
    expect(warnings(warn, "audio.codecs.aac")).toHaveLength(3);
    for (const path of ["music/c.m4a", "music/s.m4a", "music/t.aac"]) expect(warnings(warn, `"${path}"`), path).toHaveLength(1);
    // Refused before any fetch or stream open.
    expect(r.backend.streams.stats.opened).toBe(0);
    expect(r.spawned()).toBe(0); // no decoder worker was ever needed
    r.backend.dispose();
  });

  it("with audio.codecs.aac on (the AAC build), the same files play", async (ctx) => {
    const aacWasm = readFileSync(fileURLToPath(new URL("../wasm/myco_audio_decode_aac.wasm", import.meta.url)));
    const m4a = read("tone-48000-stereo.m4a");
    const r = await rig({ "music/s.m4a": m4a }, { aac: true, clipFiles: { "music/c.m4a": m4a }, decoderWasm: aacWasm.buffer.slice(aacWasm.byteOffset, aacWasm.byteOffset + aacWasm.byteLength) as ArrayBuffer });
    if (!r) return ctx.skip();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const clip = r.backend.play({ path: "music/c.m4a", url: "", loop: true, stream: false, bus: "Music" })!;
    const stream = r.backend.play({ path: "music/s.m4a", url: "", loop: true, stream: true, bus: "Music" })!;
    await r.step(2);
    await r.waitOpen(1);
    await vi.waitFor(
      async () => {
        await r.step(1);
        await r.settle();
        expect(clip.reason).toBeNull();
        expect(stream.reason).toBeNull();
      },
      { timeout: 5_000, interval: 1 },
    );
    expect(clip.playing && stream.playing).toBe(true);
    expect(r.left.some((s) => s !== 0)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    r.backend.dispose();
  });

  it("a format the decoder can't open warns once per asset with its format and the supported list; voices read failed", async (ctx) => {
    const opus = read("tone-48000-stereo.opus");
    const garbage = new Uint8Array(4096).fill(0x5a).buffer;
    const r = await rig({ "sfx/s.opus": opus, "sfx/s.aiff": garbage }, { clipFiles: { "sfx/c.opus": opus, "sfx/c.aiff": garbage } });
    if (!r) return ctx.skip();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cases = [
      ["sfx/c.opus", false],
      ["sfx/s.opus", true],
      ["sfx/c.aiff", false],
      ["sfx/s.aiff", true],
    ] as const;
    for (let pass = 0; pass < 2; pass++) {
      for (const [path, stream] of cases) {
        if (stream) {
          r.backend.play({ path, url: "", loop: true, stream, bus: "Music" });
          await r.step(2);
          // Opened on the worker, refused there (the wasm compiles in real time first).
          await vi.waitFor(() => expect(r.backend.streams.stats.errors).toBeGreaterThan(pass * 2 + (path.endsWith(".aiff") ? 1 : 0)), { timeout: 5_000, interval: 5 });
        }
        const v = stream ? null : await playToFailure(r, path, false);
        if (v) expect(v.reason, `${path} pass ${pass}`).toBe("failed");
      }
    }
    // The stream voices too: replay one and watch it end failed.
    const v = await playToFailure(r, "sfx/s.opus", true);
    expect(v.reason).toBe("failed");
    const unsupported = warnings(warn, "can't be decoded");
    expect(unsupported).toHaveLength(4);
    for (const [path] of cases) {
      const mine = warnings(warn, `"${path}"`);
      expect(mine, path).toHaveLength(1);
      expect(mine[0]).toContain(`(.${path.slice(path.lastIndexOf(".") + 1)})`);
      expect(mine[0]).toContain("Supported: WAV, FLAC, MP3 and Ogg Vorbis");
    }
    r.backend.dispose();
  });
});
