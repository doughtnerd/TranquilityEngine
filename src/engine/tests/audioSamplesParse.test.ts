// ADR 0171 M5-0 (Sa1): every sample project's mix (`audio.json` since ADR 0344) parses with no problem and plays on the
// runtime with nothing left out, each ducking rule survives, and the samples' `fadeTo` and `mute` calls give the audible
// levels they gave before `Bus.volume` became a multiplier.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Mixer } from "../audio/mixer";
import { parseAudioSettings } from "../audio/settings";
import { projectWithAudio } from "../audio/project/load";
import { parseAudioProject } from "../audio/project/format";
import { registerPluginEffects } from "../audio/effects/catalogue";
import { parsePluginAudio } from "../audio/effects/pluginEffects";

const root = "samples";
const readJson = (path: string): unknown => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined);
// ADR 0352: a sample's own plugins with an `audio` section (fx-tremolo's tremolo) are enabled, as the plugin set enables
// them before the project loads, so their effects are known to the mix.
for (const dir of readdirSync(root)) {
  const plugins = `${root}/${dir}/plugins`;
  if (!existsSync(plugins)) continue;
  for (const p of readdirSync(plugins)) {
    const m = readJson(`${plugins}/${p}/plugin.json`) as { name: string; version: string; title?: string; audio?: unknown } | undefined;
    if (!m?.audio) continue;
    const problems: string[] = [];
    const audio = parsePluginAudio(m.audio, { name: m.name, version: m.version, ...(m.title !== undefined && { title: m.title }) }, problems);
    if (problems.length === 0) registerPluginEffects({ plugin: m.name, version: m.version, enabled: true, effects: audio.effects });
  }
}
const projects = readdirSync(root)
  .filter((dir) => existsSync(`${root}/${dir}/project.json`))
  .map((dir) => ({ dir, project: readJson(`${root}/${dir}/project.json`), audio: readJson(`${root}/${dir}/audio.json`) }))
  .map((p) => ({ ...p, read: projectWithAudio(p.project, p.audio) }));

const mixerOf = (dir: string): Mixer => {
  const project = projects.find((p) => p.dir === dir)!;
  return new Mixer(parseAudioSettings(project.read.project.audio).settings);
};

/** Fades `name` to `v` over `seconds` and runs the mixer clock past the fade. */
function settle(m: Mixer, name: string, v: number, seconds: number): number {
  m.bus(name).fadeTo(v, seconds);
  m.update(seconds + 1);
  return m.bus(name).effectiveGain;
}

describe("sample audio sections", () => {
  it("finds the sample projects", () => {
    expect(projects.map((p) => p.dir)).toEqual(expect.arrayContaining(["flappy", "sound-lab", "stress"]));
  });

  for (const { dir, audio, read } of projects) {
    it(`${dir}: parses with no audio problem, and project.json holds no audio section`, () => {
      expect(read.legacyAudio).toBe(false);
      expect(read.problems).toEqual([]);
      expect(read.warnings).toEqual([]);
      expect(parseAudioSettings(read.project.audio).problems).toEqual([]);
    });
    it(`${dir}: every ducking rule names its mode and survives the parse`, () => {
      const rules = (audio as { ducking?: { mode?: string }[] } | undefined)?.ducking ?? [];
      for (const rule of rules) expect(["presence", "level"]).toContain(rule.mode);
      expect(parseAudioProject(audio).project.ducking).toHaveLength(rules.length);
      expect(parseAudioSettings(read.project.audio).settings.ducking).toHaveLength(rules.length);
    });
  }

  it("sound-lab Buses.ts: fadeTo(0.25) and fadeTo(1) are 0.15 and 0.6 heard on the authored 0.6 Music bus", () => {
    const m = mixerOf("sound-lab");
    expect(m.bus("Music").authoredVolume).toBeCloseTo(0.6);
    expect(settle(m, "Music", 0.25, 0.5)).toBeCloseTo(0.15);
    expect(settle(m, "Music", 1, 0.5)).toBeCloseTo(0.6);
  });

  it("flappy GameManager.ts: fadeTo(0.35) and fadeTo(1) on the authored 1 Music bus", () => {
    const m = mixerOf("flappy");
    expect(m.bus("Music").authoredVolume).toBe(1);
    expect(settle(m, "Music", 0.35, 0.4)).toBeCloseTo(0.35);
    expect(settle(m, "Music", 1, 0.2)).toBeCloseTo(1);
  });

  it("stress Stress.ts: target / authoredVolume on a leaf (authored 0.8) and a Mix bus (authored 1) is heard as the target", () => {
    const m = mixerOf("stress");
    for (const name of ["Bus01", "Mix0"]) {
      const authored = m.bus(name).authoredVolume;
      expect([0.8, 1]).toContain(authored);
      for (const target of [0.3, 0.75, 1.2]) expect(settle(m, name, authored > 0 ? target / authored : target, 0.25)).toBeCloseTo(target);
    }
  });

  it("stress Stress.ts: mute silences a leaf and unmuting restores it", () => {
    const m = mixerOf("stress");
    const before = m.bus("Bus01").effectiveGain;
    m.bus("Bus01").mute = true;
    expect(m.bus("Bus01").effectiveGain).toBe(0);
    m.bus("Bus01").mute = false;
    expect(m.bus("Bus01").effectiveGain).toBe(before);
  });

  it("sound-lab Buses.ts: mute toggles the Music bus", () => {
    const m = mixerOf("sound-lab");
    m.bus("Music").mute = true;
    expect(m.bus("Music").effectiveGain).toBe(0);
    m.bus("Music").mute = false;
    expect(m.bus("Music").effectiveGain).toBeCloseTo(0.6);
  });
});
