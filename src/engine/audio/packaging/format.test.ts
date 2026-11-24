// ADR 0351 §7: the .mycopak container — round trip, alignment, and refusals of malformed files.
import { describe, expect, it } from "vitest";
import { PACK_ALIGN, readAudioPack, writeAudioPack, type PackInput } from "./format";

const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);
const inputs: PackInput[] = [
  { entry: { path: "audio/amb/birds.wav", codec: "vorbis", rate: 32000, channels: 2, frames: 961000, load: "decode", hash: "ab12", prefetch: null }, data: bytes(18211, 1) },
  { entry: { path: "audio/ui/click.wav", codec: "adpcm", rate: 22050, channels: 1, frames: 2048, load: "compressed", hash: "cd34", prefetch: null }, data: bytes(1032, 2) },
  { entry: { path: "audio/music/theme.ogg", codec: "source", rate: 44100, channels: 2, frames: 4410, load: "stream", hash: "ef56", prefetch: { frames: 4410 } }, data: bytes(7, 3) },
];

describe(".mycopak", () => {
  it("round-trips entries on a 16-byte grid", () => {
    const file = writeAudioPack("Forest", "web", inputs);
    expect(new TextDecoder().decode(file.subarray(0, 8))).toBe("MYCOPAK1");
    const r = readAudioPack(file);
    if (!("pack" in r)) throw new Error(r.error);
    expect(r.pack.toc).toMatchObject({ format: "myco.audiopack@1", name: "Forest", platform: "web" });
    expect(r.pack.toc.entries.map((e) => e.path)).toEqual(inputs.map((i) => i.entry.path));
    for (const [k, e] of r.pack.toc.entries.entries()) {
      expect(e.offset % PACK_ALIGN).toBe(0);
      expect(e).toMatchObject({ ...inputs[k].entry, bytes: inputs[k].data.length });
      expect(r.pack.data(e.path)).toEqual(inputs[k].data);
    }
    expect(r.pack.data("nope.wav")).toBeNull();
    expect(file.length).toBe(r.pack.toc.entries[2].offset + 7);
  });

  it("reads from a view at any offset, and writes an empty package", () => {
    const file = writeAudioPack("Core", "android", inputs.slice(0, 1));
    const shifted = new Uint8Array(file.length + 3);
    shifted.set(file, 3);
    const r = readAudioPack(shifted.subarray(3));
    expect("pack" in r && r.pack.data("audio/amb/birds.wav")).toEqual(inputs[0].data);
    const empty = readAudioPack(writeAudioPack("Empty", "desktop", []));
    expect("pack" in empty && empty.pack.toc.entries).toEqual([]);
  });

  it("refuses what isn't a readable package, without throwing", () => {
    expect(readAudioPack(new Uint8Array(4))).toEqual({ error: "not a .mycopak file (no MYCOPAK1 header)" });
    const file = writeAudioPack("Forest", "web", inputs);
    expect(readAudioPack(file.subarray(0, 20))).toHaveProperty("error");
    const toc = (t: unknown) => {
      const j = new TextEncoder().encode(JSON.stringify(t));
      const out = new Uint8Array(12 + j.length + 64);
      out.set(new TextEncoder().encode("MYCOPAK1"));
      new DataView(out.buffer).setUint32(8, j.length, true);
      out.set(j, 12);
      return out;
    };
    expect(readAudioPack(toc({ format: "other" }))).toEqual({ error: "the table of contents isn't myco.audiopack@1" });
    // ADR 0386: a package from a newer build says so, naming both versions.
    expect(readAudioPack(toc({ format: "myco.audiopack@2" }))).toEqual({ error: "incompatible version: file is myco.audiopack@2, this build reads myco.audiopack@1: update Myco to open it" });
    const v2 = toc({ format: "myco.audiopack@1" });
    v2.set(new TextEncoder().encode("MYCOPAK2"));
    expect(readAudioPack(v2)).toEqual({ error: "incompatible version: file is MYCOPAK2, this build reads MYCOPAK1: update Myco to open it" });
    expect(readAudioPack(toc({ format: "myco.audiopack@1", name: "x", platform: "ios", entries: [] }))).toHaveProperty("error");
    const bad = readAudioPack(toc({ format: "myco.audiopack@1", name: "x", platform: "web", entries: [{ path: "a", offset: 1_000_000, bytes: 1, codec: "pcm", rate: 1, channels: 1, frames: 1, load: "decode", hash: "", prefetch: null }] }));
    expect(bad).toEqual({ error: 'entry 0: "a" lies outside the file or off the 16-byte grid' });
  });

  it("refuses a path written twice (a caller bug)", () => {
    expect(() => writeAudioPack("X", "web", [inputs[0], inputs[0]])).toThrow(/twice/);
  });
});
