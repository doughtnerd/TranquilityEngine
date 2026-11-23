// ADR 0351 A3 end to end: `npm run export` of a small project with encoding profiles and packages, through the real
// encoder (worker_threads) and decoder, into a temp folder; the build read back: the manifest's media table, each
// `.mycopak`'s TOC, the converted loose files, streamed media, the report, the notices and the cache.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAudioPack } from "../engine/audio/packaging/format";
import { encodeWavFloat32 } from "../engine/audio/sample/wavEncode";
import type { AudioReport } from "./audio";
import type { GameManifest } from "./format";
import { exportProject } from "./node";

const temps: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "myco-export-audio-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakePlayer(): string {
  const dir = temp();
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "files.json"), JSON.stringify({ files: ["assets/player-x.js", "myco.js", "player.html"] }));
  writeFileSync(join(dir, "assets", "player-x.js"), "// player");
  writeFileSync(join(dir, "myco.js"), "export {};");
  writeFileSync(join(dir, "player.html"), "<!DOCTYPE html><title>player</title>");
  return dir;
}

function tone(seconds: number, rate = 44100, channels = 2): Uint8Array {
  const frames = Math.round(seconds * rate);
  const pcm = new Float32Array(frames * channels);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) pcm[i * channels + c] = 0.3 * Math.sin((2 * Math.PI * (330 + 110 * c) * i) / rate);
  return encodeWavFloat32(pcm, channels, rate);
}

function project(): string {
  const dir = temp();
  const write = (path: string, data: string | Uint8Array) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), data);
  };
  write("project.json", JSON.stringify({ name: "Tiny" }));
  write("scenes/main.scene.json", "{}");
  write("audio.json", JSON.stringify({
    format: "myco.audio@1",
    encoding: {
      default: "Default",
      profiles: { Default: { codec: "auto", quality: 0.4 }, UI: { codec: "adpcm", load: "compressed" }, Music: { codec: "vorbis", load: "stream", prefetchMs: 200, sampleRate: 22050 } },
      rules: [{ path: "audio/ui/**", profile: "UI" }, { path: "audio/music/**", profile: "Music" }],
    },
    packages: [{ name: "Core", preload: true, include: ["audio/ui/**"] }, { name: "Level", include: ["audio/music/**", "audio/amb/bird.wav"] }],
  }));
  write("audio/step.wav", tone(0.5));
  write("audio/ui/click.wav", tone(0.2, 44100, 1));
  write("audio/amb/bird.wav", tone(0.4));
  write("audio/music/theme.wav", tone(1.5));
  return dir;
}

const magic = (bytes: Uint8Array) => new TextDecoder().decode(bytes.subarray(0, 4));

describe("export with audio (ADR 0351 A3)", () => {
  it("converts, packages and reports a project's audio, and the second export comes from the cache", async () => {
    const dir = project();
    const out = join(temp(), "web");
    await exportProject({ projectDir: dir, out, playerDir: fakePlayer(), platform: "android", audioWorkers: 2 });
    const manifest = JSON.parse(readFileSync(join(out, "game.json"), "utf8")) as GameManifest;
    const audio = manifest.audio!;
    expect(audio.platform).toBe("android");
    expect(audio.packages.map((p) => [p.name, p.url, p.preload])).toEqual([["Core", "audio/packages/Core.mycopak", true], ["Level", "audio/packages/Level.mycopak", false]]);

    // Loose: converted in place, Ogg Vorbis bytes behind the .wav name.
    const step = new Uint8Array(readFileSync(join(out, "project/audio/step.wav")));
    expect(magic(step)).toBe("OggS");
    expect(audio.media["audio/step.wav"]).toEqual({ codec: "vorbis", load: "decode", rate: 44100, channels: 2, frames: 22050 });

    // Packages: their TOCs, and the packaged files aren't written loose.
    const core = readAudioPack(new Uint8Array(readFileSync(join(out, "audio/packages/Core.mycopak"))));
    if ("error" in core) throw new Error(core.error);
    expect(core.pack.toc).toMatchObject({ name: "Core", platform: "android" });
    expect(core.pack.toc.entries.map((e) => [e.path, e.codec, e.load, e.channels, e.frames])).toEqual([["audio/ui/click.wav", "adpcm", "compressed", 1, 8820]]);
    const level = readAudioPack(new Uint8Array(readFileSync(join(out, "audio/packages/Level.mycopak"))));
    if ("error" in level) throw new Error(level.error);
    const [bird, theme] = level.pack.toc.entries;
    expect([bird.path, bird.codec, bird.load]).toEqual(["audio/amb/bird.wav", "vorbis", "decode"]);
    expect(magic(level.pack.data("audio/amb/bird.wav")!)).toBe("OggS");
    expect([theme.path, theme.codec, theme.load, theme.rate]).toEqual(["audio/music/theme.wav", "pcm", "stream", 22050]);
    expect(theme.prefetch).toEqual({ frames: 4410 });
    expect(magic(level.pack.data("audio/music/theme.wav")!)).toBe("RIFF");
    for (const p of ["audio/ui/click.wav", "audio/amb/bird.wav", "audio/music/theme.wav"]) {
      expect(existsSync(join(out, "project", p)), p).toBe(false);
      expect(manifest.files).toContain(p);
    }
    // The streamed sound's media is loose under audio/stream/.
    const media = audio.media["audio/music/theme.wav"];
    expect(media).toMatchObject({ package: "Level", codec: "vorbis", load: "stream", rate: 22050, channels: 2, frames: 33075 });
    expect(magic(new Uint8Array(readFileSync(join(out, media.url!))))).toBe("OggS");

    // The report, the notices, the cache.
    const report = JSON.parse(readFileSync(join(out, "audio-report.json"), "utf8")) as AudioReport;
    expect(report.platform).toBe("android");
    expect(report.sounds.map((s) => s.path)).toEqual(["audio/amb/bird.wav", "audio/music/theme.wav", "audio/step.wav", "audio/ui/click.wav"]);
    expect(report.sounds.find((s) => s.path === "audio/ui/click.wav")!.from.codec).toBe("UI profile (rule audio/ui/**)");
    expect(report.sounds.every((s) => !s.cached)).toBe(true);
    expect(report.totals.shippedBytes).toBeLessThan(report.totals.sourceBytes);
    expect(readFileSync(join(out, "THIRD_PARTY_NOTICES.md"), "utf8")).toMatch(/^# Third-party notices/);
    expect(readdirSync(join(dir, ".myco/cache/audio")).length).toBeGreaterThan(0);

    const again = join(temp(), "web");
    await exportProject({ projectDir: dir, out: again, playerDir: fakePlayer(), platform: "android", audioWorkers: 1 });
    const second = JSON.parse(readFileSync(join(again, "audio-report.json"), "utf8")) as AudioReport;
    expect(second.sounds.every((s) => s.cached)).toBe(true);
    expect(readFileSync(join(again, "project/audio/step.wav"))).toEqual(readFileSync(join(out, "project/audio/step.wav")));
  }, 120_000);
});
