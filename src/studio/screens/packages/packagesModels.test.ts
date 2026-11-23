// ADR 0351 §6–§8, A6: the Packages screen through its models — package contents with dependencies (and why each sound
// is in), sounds in several packages and in none, the package edits with their refusals, the rename's rewrite of
// `AudioPackageLoader` fields in scenes and prefabs, the script lint, the profiles and rules tab, and the report
// (estimated from the plan, exact from a Convert now) with its budget warnings.
import { describe, expect, it } from "vitest";
import { parseAudioProject } from "../../../engine/audio/project/format";
import type { AudioProject } from "../../../engine/audio/project/types";
import type { AudioReport } from "../../../export/audio";
import type { EditResult } from "../../../plugins/audio/editor/editResult";
import { studioPlan, type StudioPlanSource } from "../../encoding/studioPlan";
import {
  addPackage, addToPackage, deletePackage, lintPackageNames, looseAssets, packageList, packageRenameEdit, packageView, removeFromPackage, removeInclude, renamePackage,
  renamePackageInScene, setPreload, setShipsOn, setStrict,
} from "./packagesModel";
import { addProfile, addRule, deleteProfile, moveRule, profileKeyRows, profileRenameEdit, removeRule, renameProfile, rulePreview, setBudget, setDefaultProfile, setProfileKey, updateRule, configOfDoc } from "./profilesModel";
import { budgetBar, estimatedReport, exactReport } from "./reportModel";

const FILES = [
  "audio.json",
  "audio/ui/click.wav", "audio/ui/hover.wav",
  "audio/amb/forest_bed.wav", "audio/amb/birds.ogg",
  "audio/sfx/hit.wav", "audio/sfx/hit_soft.sample.json",
  "audio/music/boss.wav",
  "playlists/ui/menu.playlist.json", "playlists/forest/day.playlist.json", "playlists/boss_theme.playlist.json",
  "scenes/level.scene.json",
];
/** What each asset names (a playlist its sounds, a derived sample its source). */
const DEPS: Record<string, string[]> = {
  "playlists/ui/menu.playlist.json": ["audio/ui/hover.wav"],
  "playlists/forest/day.playlist.json": ["audio/amb/birds.ogg", "audio/sfx/hit_soft.sample.json", "audio/missing.wav"],
  "audio/sfx/hit_soft.sample.json": ["audio/sfx/hit.wav"],
  "playlists/boss_theme.playlist.json": ["audio/music/boss.wav"],
};
const deps = (p: string) => DEPS[p] ?? [];

const project = (raw: Record<string, unknown> = {}): AudioProject =>
  parseAudioProject({
    format: "myco.audio@1",
    packages: [
      { name: "Core", preload: true, include: ["audio/ui/**", "playlists/ui/**"] },
      { name: "Forest", include: ["playlists/forest/**", "audio/amb/forest_bed.wav"] },
      { name: "Boss", include: ["playlists/boss_theme.playlist.json", "audio/ui/click.wav"], platforms: ["desktop", "web"] },
    ],
    ...raw,
  }).project;

const ok = <T,>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};

describe("package contents", () => {
  it("list each package with its count, problems and whether it ships on the platform", () => {
    expect(packageList(project(), FILES, deps, "android").map((r) => [r.name, r.count, r.problems, r.ships, r.preload])).toEqual([
      ["Core", 3, 0, true, true],
      ["Forest", 5, 1, true, false],
      ["Boss", 3, 0, false, false],
    ]);
  });

  it("say why each asset is in: its include entry, or the asset that needs it; and which other packages hold it", () => {
    const v = packageView(project(), "Forest", FILES, deps)!;
    expect(v.rows.map((r) => [r.path, r.kind, r.include, r.via, r.alsoIn])).toEqual([
      ["audio/amb/birds.ogg", "sample", null, "playlists/forest/day.playlist.json", []],
      ["audio/amb/forest_bed.wav", "sample", "audio/amb/forest_bed.wav", null, []],
      ["audio/sfx/hit.wav", "sample", null, "audio/sfx/hit_soft.sample.json", []],
      ["audio/sfx/hit_soft.sample.json", "derived", null, "playlists/forest/day.playlist.json", []],
      ["playlists/forest/day.playlist.json", "playlist", "playlists/forest/**", null, []],
    ]);
    expect(v.missing).toEqual([{ path: "audio/missing.wav", from: "playlists/forest/day.playlist.json" }]);
    const core = packageView(project(), "Core", FILES, deps)!;
    expect(core.rows.find((r) => r.path === "audio/ui/click.wav")!.alsoIn).toEqual(["Boss"]);
    expect(packageView(project(), "Nope", FILES, deps)).toBeNull();
  });

  it("find the packable assets in no package", () => {
    expect(looseAssets(project(), FILES, deps)).toEqual([]);
    expect(looseAssets(ok(deletePackage(project(), "Boss")), FILES, deps)).toEqual(["audio/music/boss.wav", "playlists/boss_theme.playlist.json"]);
  });
});

describe("package edits", () => {
  it("add packages with fresh names, rename them uniquely and delete them", () => {
    const p = ok(addPackage(ok(addPackage(project()))));
    expect(p.packages!.map((d) => d.name)).toEqual(["Core", "Forest", "Boss", "Package", "Package 2"]);
    expect(renamePackage(p, "Package", "Core")).toEqual({ refused: 'there\'s already a package named "Core"' });
    expect(renamePackage(p, "Package", "a/b")).toEqual({ refused: 'a package name can\'t contain / \\ : * ? " < > or |' });
    expect(ok(renamePackage(p, "Package", "Caves")).packages!.map((d) => d.name)).toContain("Caves");
    expect(ok(deletePackage(ok(deletePackage(ok(deletePackage(project(), "Core")), "Forest")), "Boss")).packages).toBeUndefined();
  });

  it("add a sound, refuse it twice; remove a listed one; refuse one a glob or another asset holds", () => {
    const p = ok(addToPackage(project(), "Boss", "audio/sfx/hit.wav"));
    expect(p.packages![2]!.include).toEqual(["playlists/boss_theme.playlist.json", "audio/ui/click.wav", "audio/sfx/hit.wav"]);
    expect(addToPackage(p, "Boss", "audio/sfx/hit.wav")).toEqual({ refused: 'audio/sfx/hit.wav is already listed in "Boss"' });
    expect(addToPackage(p, "Boss", "scenes/level.scene.json")).toEqual({ refused: "only sounds, derived samples and playlists go in a package" });
    expect(ok(removeFromPackage(p, "Boss", "audio/sfx/hit.wav")).packages![2]!.include).toEqual(["playlists/boss_theme.playlist.json", "audio/ui/click.wav"]);
    expect(removeFromPackage(project(), "Core", "audio/ui/hover.wav")).toEqual({ refused: 'audio/ui/hover.wav is caught by "audio/ui/**"; edit that entry instead' });
    expect(removeFromPackage(project(), "Boss", "audio/music/boss.wav", { files: FILES, deps })).toEqual({ refused: "playlists/boss_theme.playlist.json needs audio/music/boss.wav, so it stays while playlists/boss_theme.playlist.json is in the package" });
    expect(ok(removeInclude(project(), "Core", "audio/ui/**")).packages![0]!.include).toEqual(["playlists/ui/**"]);
  });

  it("set preload, the platforms (all of them is none written) and the project's strict rule", () => {
    expect(ok(setPreload(project(), "Forest", true)).packages![1]!.preload).toBe(true);
    const all = ok(setShipsOn(project(), "Boss", "android", true));
    expect(all.packages![2]!.platforms).toBeNull();
    const web = ok(setShipsOn(ok(setShipsOn(project(), "Boss", "desktop", false)), "Boss", "android", false));
    expect(web.packages![2]!.platforms).toEqual(["web"]);
    expect(setShipsOn(web, "Boss", "web", false)).toEqual({ refused: "a package ships on at least one platform (delete it instead)" });
    const lenient = ok(setStrict(project(), false));
    expect(lenient.packaging).toEqual({ strict: false });
    expect(ok(setStrict(lenient, true)).packaging).toBeUndefined();
  });
});

describe("package renames", () => {
  const scene = {
    format: "myco.scene@1",
    nodes: [
      { id: "a", components: [{ type: "engine.AudioPackageLoader", data: { packages: ["Forest", "Core"], unloadOnDestroy: true } }, { type: "engine.AudioSource", data: { clip: "Forest" } }] },
      { id: "b", prefab: "p.prefab.json", overrides: [{ target: "x", component: "engine.AudioPackageLoader", field: "packages", value: ["Forest"] }] },
    ],
  };

  it("rewrite AudioPackageLoader lists in scenes and prefab overrides, nothing else", () => {
    const out = renamePackageInScene(scene, "Forest", "Woods") as typeof scene;
    expect(out.nodes[0]!.components![0]!.data).toEqual({ packages: ["Woods", "Core"], unloadOnDestroy: true });
    expect(out.nodes[0]!.components![1]).toBe(scene.nodes[0]!.components![1]);
    expect((out.nodes[1] as { overrides: { value: string[] }[] }).overrides[0]!.value).toEqual(["Woods"]);
    expect(renamePackageInScene(scene, "Boss", "Final")).toBe(scene);
  });

  it("as a project-wide edit: only files naming the loader and the name; audio.json is left to its own edit", () => {
    const edit = packageRenameEdit("Forest", "Woods");
    expect(edit.mentioned(JSON.stringify(scene))).toBe(true);
    expect(edit.mentioned('{"clip":"Forest"}')).toBe(false);
    expect(edit.scene(scene as never)).not.toBeNull();
    expect(edit.json({ packages: [] }, "audio.json")).toBeNull();
  });

  it("lint Audio.package names in scripts that match no package", () => {
    const scripts = new Map([
      ["scripts/level.ts", 'import { Audio } from "myco";\nawait Audio.package("Forest").load();\nAudio.package(\'Caves\').load();\nAudio.package(name);\n'],
      ["scripts/boss.ts", "Audio . package( `Bos` ).unload();"],
    ]);
    expect(lintPackageNames(scripts, ["Core", "Forest", "Boss"])).toEqual([
      { path: "scripts/boss.ts", line: 1, name: "Bos" },
      { path: "scripts/level.ts", line: 3, name: "Caves" },
    ]);
  });
});

describe("profiles and rules", () => {
  const base = () => project({ encoding: { default: "Default", profiles: { Default: { codec: "auto" }, Music: { codec: "vorbis", load: "stream" } }, rules: [{ path: "audio/music/**", profile: "Music" }, { path: "audio/**", profile: "Default" }], budgets: { web: { downloadMB: 40 } } } });

  it("add, rename (with the rules and default naming it) and delete profiles; a profile in use can't go", () => {
    const p = ok(addProfile(base()));
    expect(Object.keys(configOfDoc(p).profiles)).toEqual(["Default", "Music", "Profile"]);
    const r = ok(renameProfile(base(), "Default", "Base"));
    expect(configOfDoc(r)).toMatchObject({ default: "Base", rules: [{ profile: "Music" }, { profile: "Base" }] });
    expect(Object.keys(configOfDoc(r).profiles)).toEqual(["Base", "Music"]);
    expect(renameProfile(base(), "Default", "Music")).toEqual({ refused: 'there\'s already a profile named "Music"' });
    expect(deleteProfile(base(), "Default")).toEqual({ refused: "the default, rule audio/** use it; change those first" });
    expect(Object.keys(configOfDoc(ok(deleteProfile(p, "Profile"))).profiles)).toEqual(["Default", "Music"]);
    expect(configOfDoc(ok(setDefaultProfile(base(), null))).default).toBeNull();
  });

  it("set a profile's key for every platform or one, and show what it gives per platform", () => {
    const p = ok(setProfileKey(ok(setProfileKey(base(), "Music", "android", "quality", 0.333)), "Music", null, "quality", 0.6));
    const music = configOfDoc(p).profiles.Music!;
    expect(music).toEqual({ codec: "vorbis", load: "stream", quality: 0.6, platforms: { android: { quality: 0.33 } } });
    expect(profileKeyRows(music, "android").find((r) => r.key === "quality")).toEqual({ key: "quality", value: 0.33, platformValue: true });
    expect(profileKeyRows(music, "web").find((r) => r.key === "quality")).toEqual({ key: "quality", value: 0.6, platformValue: false });
    const cleared = configOfDoc(ok(setProfileKey(p, "Music", "android", "quality", undefined))).profiles.Music!;
    expect(cleared.platforms).toBeUndefined();
  });

  it("edit, move and remove rules, previewing what each catches (first match wins)", () => {
    const files = ["audio/music/boss.wav", "audio/ui/click.wav", "playlists/x.playlist.json"];
    expect(rulePreview(configOfDoc(base()), files)).toEqual([
      { index: 0, catches: ["audio/music/boss.wav"], shadowed: 0 },
      { index: 1, catches: ["audio/ui/click.wav"], shadowed: 1 },
    ]);
    const moved = ok(moveRule(base(), 1, -1));
    expect(rulePreview(configOfDoc(moved), files)[1]).toEqual({ index: 1, catches: [], shadowed: 1 });
    expect(moveRule(base(), 0, -1)).toEqual({ refused: "it's already the first rule" });
    expect(configOfDoc(ok(updateRule(base(), 0, { path: " audio/bgm/** " }))).rules[0]).toEqual({ path: "audio/bgm/**", profile: "Music" });
    expect(updateRule(base(), 0, { profile: "Nope" })).toEqual({ refused: 'there\'s no profile named "Nope"' });
    expect(addRule(base(), "", "Music")).toEqual({ refused: "a rule needs a path or glob" });
    expect(configOfDoc(ok(removeRule(base(), 0))).rules).toEqual([{ path: "audio/**", profile: "Default" }]);
  });

  it("set and clear budgets", () => {
    const p = ok(setBudget(base(), "android", "memoryMB", 48));
    expect(configOfDoc(p).budgets).toEqual({ web: { downloadMB: 40 }, android: { memoryMB: 48 } });
    expect(configOfDoc(ok(setBudget(p, "web", "downloadMB", null))).budgets).toEqual({ android: { memoryMB: 48 } });
    expect(setBudget(p, "web", "downloadMB", -1)).toMatchObject({ refused: expect.stringContaining("a budget is a number of MB") });
  });

  it("rename a profile in sidecars that choose it", () => {
    const edit = profileRenameEdit("Music", "Score");
    expect(edit.json({ format: "myco.import@1", encoding: { profile: "Music", quality: 0.7 } }, "audio/a.wav.meta.json")).toEqual({ format: "myco.import@1", encoding: { profile: "Score", quality: 0.7 } });
    expect(edit.json({ encoding: { profile: "UI" } }, "audio/a.wav.meta.json")).toBeNull();
    expect(edit.json({ encoding: { profile: "Music" } }, "scenes/a.scene.json")).toBeNull();
  });
});

describe("report", () => {
  const sources: Record<string, { bytes: number; frames: number; rate: number; channels: number }> = {
    "audio/ui/click.wav": { bytes: 100_000, frames: 24_000, rate: 48_000, channels: 1 },
    "audio/ui/hover.wav": { bytes: 100_000, frames: 24_000, rate: 48_000, channels: 1 },
    "audio/amb/forest_bed.wav": { bytes: 20_000_000, frames: 48_000 * 100, rate: 48_000, channels: 2 },
    "audio/amb/birds.ogg": { bytes: 500_000, frames: 48_000 * 30, rate: 48_000, channels: 2 },
    "audio/sfx/hit.wav": { bytes: 200_000, frames: 48_000, rate: 48_000, channels: 2 },
    "audio/music/boss.wav": { bytes: 40_000_000, frames: 48_000 * 200, rate: 48_000, channels: 2 },
  };
  const source = (audio: AudioProject): StudioPlanSource => ({ files: FILES, audio, json: (p) => (DEPS[p] ? { format: "myco.playlist@1", type: "clip", clips: DEPS[p]!.map((path) => ({ path })) } : undefined) });
  const facts = (p: string) => sources[p] ?? { bytes: 0, frames: null, rate: null, channels: null };

  it("estimates per package and in total, with the memory bound and budget warnings", () => {
    const audio = project({ encoding: { profiles: { Bed: { load: "stream", prefetchMs: 500 } }, rules: [{ path: "audio/amb/forest_bed.wav", profile: "Bed" }], budgets: { web: { downloadMB: 1, memoryMB: 100 } } } });
    const r = estimatedReport(studioPlan(source(audio), "web"), facts);
    expect(r.exact).toBe(false);
    expect(r.unknown).toBe(0);
    expect(r.totals.files).toBe(6);
    const bed = r.sounds.find((s) => s.path === "audio/amb/forest_bed.wav")!;
    expect(bed).toMatchObject({ codec: "vorbis", load: "stream", profile: "Bed" });
    // The forest bed is streamed: loose media, and only its 0.5 s head in the package.
    const forest = r.packages.find((p) => p.name === "Forest")!;
    expect(forest.memoryBytes).toBeGreaterThanOrEqual(24_000 * 2 * 2);
    expect(r.packages.map((p) => p.name)).toEqual(["Core", "Forest", "Boss"]);
    const core = r.packages.find((p) => p.name === "Core")!;
    const boss = r.packages.find((p) => p.name === "Boss")!;
    expect(r.totals.memoryBytes).toBe(core.memoryBytes + Math.max(forest.memoryBytes, boss.memoryBytes));
    expect(r.overDownload).toBe(true);
    expect(r.warnings[0]).toMatch(/^audio download .* MB is over the web budget of 1 MB\.$/);
    expect(r.overMemory).toBe(false);
  });

  it("counts sounds whose length isn't known yet as unknown", () => {
    const r = estimatedReport(studioPlan(source(project()), "web"), (p) => ({ bytes: sources[p]?.bytes ?? 0, frames: null, rate: null, channels: null }));
    // WAV sounds convert to Vorbis (unknown until read); the Ogg ships as it is.
    expect(r.unknown).toBe(5);
  });

  it("takes a Convert now's report as exact", () => {
    const report: AudioReport = {
      format: "myco.audioreport@1", platform: "android", converted: true,
      sounds: [{ path: "audio/ui/click.wav", renderOf: null, sourceBytes: 100_000, shippedBytes: 8_000, codec: "adpcm", rate: 48_000, channels: 1, frames: 24_000, load: "compressed", memoryBytes: 4_000, packages: ["Core", "Boss"], cached: false, settings: { codec: "adpcm", quality: 0.4, sampleRate: "source", channels: "source", load: "compressed", prefetchMs: 0 }, from: {} as never, notes: [] }],
      packages: [{ name: "Core", preload: true, bytes: 4_100, memoryBytes: 4_000, sounds: ["audio/ui/click.wav"], problems: [] }],
      totals: { files: 1, sourceBytes: 100_000, shippedBytes: 8_200, memoryBytes: 4_000 },
      budgets: { warnings: [] }, problems: [],
    };
    const r = exactReport(report, configOfDoc(project({ encoding: { budgets: { android: { memoryMB: 0.001 } } } })));
    expect(r).toMatchObject({ exact: true, platform: "android", overMemory: true, totals: report.totals });
    expect(r.sounds[0]!.bytes).toBe(4_000);
    expect(budgetBar(512 * 1024, 1)).toEqual({ share: 0.5, text: "512 KB of 1 MB", over: false });
    expect(budgetBar(1, undefined)).toBeNull();
  });
});
