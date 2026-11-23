// The Sound Lab's loudness material ships unconverted in a game build. `audio/loudness-reference.wav` is the EBU Tech 3341
// case 1 tone the M5b pages meter (-22.99 LUFS) and `audio/loudness-hot.wav` the hot signal whose true peak they check; both
// are calibration signals, and a lossy codec doesn't hold a level to the meter's precision: the build's default (Vorbis,
// quality 0.5) raised the reference's 1 kHz tone by 0.063 dB and the exported page read -22.93 LUFS. Their sidecars set
// `encoding.codec` to "source"; this plans the real project on every platform and checks that's what ships.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEncodingConfig } from "../engine/audio/encoding/format";
import { audioDependencies } from "../engine/audio/packaging/definitions";
import { parseImportSettings, sidecarPath, type ImportPlatform } from "../engine/scene/importSettings";
import { planAudio, type AudioSidecarFacts } from "./audio";

const ROOT = "samples/sound-lab";
const CALIBRATION = ["audio/loudness-reference.wav", "audio/loudness-hot.wav"];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [relative(ROOT, full).split("\\").join("/")];
  });
}
const readJson = (path: string): unknown => {
  const full = join(ROOT, path);
  return existsSync(full) ? JSON.parse(readFileSync(full, "utf8")) : undefined;
};
const sidecar = (path: string): AudioSidecarFacts | null => {
  const raw = readJson(sidecarPath(path));
  if (raw === undefined) return null;
  const s = parseImportSettings(raw, sidecarPath(path)).settings;
  return { encoding: s.encoding, legacyStream: s.stream, ambisonic: s.ambisonic !== null };
};

describe("the Sound Lab's loudness material in a game build", () => {
  const files = walk(ROOT).filter((p) => !p.startsWith(".myco/"));
  const audio = readJson("audio.json") as { encoding?: unknown } | undefined;
  const problems: string[] = [];
  const config = parseEncodingConfig(audio?.encoding, problems);

  it.each<ImportPlatform>(["web", "desktop", "android"])("ships unconverted on %s (the sidecar's codec \"source\")", (platform) => {
    expect(problems).toEqual([]);
    for (const path of CALIBRATION) expect(files, path).toContain(path);
    const plan = planAudio({ platform, files, config, packages: [], sidecar, renderOwner: () => null, dependencies: audioDependencies(readJson), convert: true });
    for (const path of CALIBRATION) {
      const sound = plan.sounds.find((s) => s.path === path);
      expect(sound, path).toBeDefined();
      expect(sound!.codec, path).toBe("source");
      expect(sound!.resolution.settings.codec, path).toBe("source");
    }
    // The rest of the project still converts as before (the sidecars are the only change): a WAV loop goes to Vorbis.
    expect(plan.sounds.find((s) => s.path === "audio/music-loop.wav")?.codec).toBe("vorbis");
  });
});
