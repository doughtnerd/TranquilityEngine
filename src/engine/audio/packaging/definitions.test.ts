// ADR 0337 §7: package definitions in audio.json, and what a package holds with its dependencies.
import { describe, expect, it } from "vitest";
import { audioProjectToJson, parseAudioProject } from "../project/format";
import { audioDependencies, packageContents, packagesToJson, parsePackages, parsePackagingOptions, shipsOn, whyNotPackageName, type PackageDef } from "./definitions";

const packages = [
  { name: "Core", preload: true, include: ["audio/ui/**", "playlists/ui/**"] },
  { name: "Forest", include: ["playlists/forest/**", "audio/amb/forest_bed.wav"] },
  { name: "Boss", include: ["playlists/boss_theme.playlist.json"], platforms: ["desktop", "web"] },
];

describe("package definitions", () => {
  it("round-trip through audio.json with packaging", () => {
    const parsed = parseAudioProject({ format: "myco.audio@1", packages, packaging: { strict: false } });
    expect(parsed.problems).toEqual([]);
    expect(parsed.project.packages).toEqual([
      { name: "Core", preload: true, include: ["audio/ui/**", "playlists/ui/**"], platforms: null },
      { name: "Forest", preload: false, include: ["playlists/forest/**", "audio/amb/forest_bed.wav"], platforms: null },
      { name: "Boss", preload: false, include: ["playlists/boss_theme.playlist.json"], platforms: ["web", "desktop"] },
    ]);
    expect(parsed.project.packaging).toEqual({ strict: false });
    const json = audioProjectToJson(parsed.project);
    expect(json.packages).toEqual([packages[0], packages[1], { ...packages[2], platforms: ["web", "desktop"] }]);
    expect(json.packaging).toEqual({ strict: false });
    expect(parseAudioProject(JSON.parse(JSON.stringify(json))).project).toEqual(parsed.project);
  });

  it("leave audio.json alone when there are none, and strict is the default", () => {
    const p = parseAudioProject({ format: "myco.audio@1", packaging: { strict: true } }).project;
    expect(p.packages).toBeUndefined();
    expect(p.packaging).toBeUndefined();
    expect(audioProjectToJson(p)).not.toHaveProperty("packages");
    expect(audioProjectToJson(p)).not.toHaveProperty("packaging");
    expect(parsePackagingOptions(undefined, [])).toEqual({ strict: true });
    expect(packagesToJson([])).toBeNull();
  });

  it("drop or fix bad entries with one problem each", () => {
    const problems: string[] = [];
    const out = parsePackages(
      [
        { name: "A", include: ["x/**", "x/**", 3], preload: "yes", platforms: ["web", "ps5", "web"], color: "red" },
        { name: "A", include: [] },
        { include: [] },
        "B",
        { name: "a/b" },
        { name: "C", include: "x", platforms: "web" },
      ],
      problems,
    );
    expect(out).toEqual([
      { name: "A", include: ["x/**"], preload: false, platforms: ["web"] },
      { name: "C", include: [], preload: false, platforms: null },
    ]);
    expect(problems).toEqual([
      "packages[0].color: unknown key; ignored.",
      'packages[0].include[1]: "x/**" is listed twice; dropped.',
      "packages[0].include[2]: must be a path or glob; dropped.",
      "packages[0].preload: must be true or false; using false.",
      'packages[0].platforms: unknown platform "ps5" (expected web, desktop, android); skipped.',
      'packages[1]: there\'s already a package named "A"; dropped.',
      "packages[2]: a package needs a name; dropped.",
      "packages[3]: must be an object; dropped.",
      'packages[4]: a package name can\'t contain / \\ : * ? " < > or |; dropped.',
      "packages[5].include: must be a list of paths and globs; ignored.",
      "packages[5].platforms: must be a list of platforms; using every platform.",
    ]);
    expect(parsePackagingOptions({ strict: 1, x: 2 }, problems)).toEqual({ strict: true });
    expect(whyNotPackageName("Core", ["Core"])).toMatch(/already/);
  });

  it("say which platforms a package ships on", () => {
    const boss: PackageDef = { name: "Boss", include: [], preload: false, platforms: ["web"] };
    expect(shipsOn(boss, "web")).toBe(true);
    expect(shipsOn(boss, "android")).toBe(false);
    expect(shipsOn({ ...boss, platforms: null }, "android")).toBe(true);
  });
});

describe("packageContents", () => {
  const files = [
    "audio/ui/click.wav",
    "audio/ui/hover.wav",
    "audio/amb/forest_bed.wav",
    "audio/amb/birds.wav",
    "audio/amb/birds_cut.sample.json",
    "audio/amb/birds.flat1.wav",
    "audio/boss/theme.ogg",
    "audio/attenuation/far.attenuation.json",
    "playlists/forest/day.playlist.json",
    "playlists/forest/loop.playlist.json",
    "playlists/boss_theme.playlist.json",
  ];
  const json: Record<string, unknown> = {
    "playlists/forest/day.playlist.json": {
      format: "myco.playlist@1", type: "queue",
      spatial: { attenuation: "audio/attenuation/far.attenuation.json" },
      entries: [{ sample: "audio/amb/birds_cut.sample.json" }, { playlist: "playlists/forest/loop.playlist.json" }],
    },
    // A cycle back to day: visited once.
    "playlists/forest/loop.playlist.json": { format: "myco.playlist@1", type: "queue", entries: [{ playlist: "playlists/forest/day.playlist.json" }, { sample: "audio/amb/gone.wav" }] },
    "playlists/boss_theme.playlist.json": { format: "myco.playlist@1", type: "queue", entries: [{ sample: "audio/boss/theme.ogg" }] },
    "audio/amb/birds_cut.sample.json": { format: "myco.sample@1", source: "audio/amb/birds.wav", sample: { source: "birds.flat1.wav" } },
  };
  const deps = audioDependencies((p) => json[p]);

  it("expands globs and adds dependencies transitively: playlists, derived samples, renders, attenuation", () => {
    const def: PackageDef = { name: "Forest", include: ["playlists/forest/**", "audio/amb/forest_bed.wav", "audio/nothing/**"], preload: false, platforms: null };
    const c = packageContents(def, files, deps);
    expect(c.paths).toEqual([
      "audio/amb/birds.flat1.wav",
      "audio/amb/birds.wav",
      "audio/amb/birds_cut.sample.json",
      "audio/amb/forest_bed.wav",
      "audio/attenuation/far.attenuation.json",
      "playlists/forest/day.playlist.json",
      "playlists/forest/loop.playlist.json",
    ]);
    expect(c.unmatched).toEqual(["audio/nothing/**"]);
    expect(c.missing).toEqual([{ path: "audio/amb/gone.wav", from: "playlists/forest/loop.playlist.json" }]);
  });

  it("takes exact paths and folders", () => {
    expect(packageContents({ name: "B", include: ["playlists/boss_theme.playlist.json"], preload: false, platforms: null }, files, deps).paths).toEqual(["audio/boss/theme.ogg", "playlists/boss_theme.playlist.json"]);
    expect(packageContents({ name: "U", include: ["audio/ui"], preload: true, platforms: null }, files, deps).paths).toEqual(["audio/ui/click.wav", "audio/ui/hover.wav"]);
  });
});
