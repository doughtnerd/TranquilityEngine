// ADR 0330 and decision D2: the editor migrates an old project.json audio section to audio.json when a project opens,
// serves audio.json's runtime view as the settings' `audio`, and saves the legacy panels' edits to audio.json, keeping
// what the old section shape can't express.
import { afterEach, describe, expect, it } from "vitest";
import { parseAudioProject } from "../engine/audio/project/format";
import type { AudioSettings } from "../engine/audio/settings";
import { ROOT, closeTestProject, openTestProject } from "./testing";
import { createProjectSettingsSection } from "./projectSettingsSection";
import { setValue, type SettingsDraft } from "./projectSettingsModel";
import { migrateProjectText } from "./audioProjectFile";

afterEach(() => closeTestProject());

const OLD_PROJECT = `{
  "name": "Game",
  "audio": {
    "buses": [{ "name": "Master" }, { "name": "SFX", "parent": "Master", "volume": 0.5, "effects": [{ "type": "reverb", "send": 0.25 }] }]
  },
  "autoload": []
}
`;

/** A mix with what the old section shape can't express: a VCA, a second return, an eq. */
const RICH_AUDIO = JSON.stringify({
  format: "myco.audio@1",
  buses: [
    { name: "Master" },
    { name: "SFX", parent: "Master", volumeDb: -6, effects: [{ id: "eq", type: "eq", params: { low: 3 } }], sends: [{ to: "Delay", levelDb: -10 }] },
  ],
  returns: [{ name: "Delay", effects: [{ id: "fx1", type: "delay" }] }],
  vcas: [{ name: "Game", volumeDb: -3, members: ["SFX"] }],
});

const read = async (fs: { readText(p: string): Promise<string> }, path: string): Promise<unknown> => JSON.parse(await fs.readText(`${ROOT}\\${path}`));
const sfx = (d: SettingsDraft) => (d.audio as unknown as AudioSettings).buses.find((b) => b.name === "SFX")!;
const withSfxVolume = (d: SettingsDraft, volume: number): SettingsDraft => {
  const audio = d.audio as unknown as AudioSettings;
  return { ...d, audio: { ...audio, buses: audio.buses.map((b) => (b.name === "SFX" ? { ...b, volume } : b)) } as unknown as Record<string, unknown> };
};

describe("migration when a project opens", () => {
  it("writes audio.json from the section, takes it out of project.json and keeps the old project.json in .myco/migrated", async () => {
    const { project, fs } = await openTestProject({ "project.json": OLD_PROJECT });
    expect(await fs.readText(`${ROOT}\\.myco\\migrated\\project.json`)).toBe(OLD_PROJECT);
    expect(await fs.readText(`${ROOT}\\project.json`)).toBe(`{\n  "name": "Game",\n  "autoload": []\n}\n`);
    const audio = parseAudioProject(await read(fs, "audio.json"));
    expect(audio.problems).toEqual([]);
    expect(audio.project.returns.map((r) => r.name)).toEqual(["Reverb"]);
    expect(project.files).toContain("audio.json");
    expect(project.files.some((f) => f.startsWith(".myco"))).toBe(false);
    // The settings serve the runtime view: the old section as it was.
    expect((project.settings.audio as unknown as AudioSettings).buses[1]).toMatchObject({ name: "SFX", volume: 0.5, effects: [{ type: "reverb", send: 0.25 }] });
  });

  it("leaves a project without a section alone, and keeps an audio.json that is already there", async () => {
    const plain = await openTestProject({ "project.json": '{ "name": "Plain" }' });
    expect(await plain.fs.exists(`${ROOT}\\.myco\\migrated\\project.json`)).toBe(false);
    expect(await plain.fs.exists(`${ROOT}\\audio.json`)).toBe(false);
    closeTestProject();
    const both = await openTestProject({ "project.json": OLD_PROJECT, "audio.json": RICH_AUDIO, ".myco/migrated/project.json": "{}" });
    expect(await both.fs.readText(`${ROOT}\\audio.json`)).toBe(RICH_AUDIO);
    expect(await both.fs.readText(`${ROOT}\\.myco\\migrated\\project.2.json`)).toBe(OLD_PROJECT);
    expect(await read(both.fs, "project.json")).toEqual({ name: "Game", autoload: [] });
  });

  it("migrateProjectText: null for a project.json without a section or that isn't JSON", () => {
    expect(migrateProjectText('{ "name": "x" }')).toBeNull();
    expect(migrateProjectText("{ nope")).toBeNull();
    expect(migrateProjectText('{ "audio": { "buses": 3 } }')!.problems).toEqual(["audio.buses must be a list."]);
  });
});

describe("the settings' audio key is saved to audio.json", () => {
  it("an edit writes audio.json, keeps the VCA, the return and the eq, and leaves project.json as it was", async () => {
    const { project, fs } = await openTestProject({ "project.json": '{ "name": "Game" }\n', "audio.json": RICH_AUDIO });
    const s = createProjectSettingsSection().open(project);
    expect(sfx(s.draft).volume).toBeCloseTo(Math.pow(10, -9 / 20), 6); // the VCA's -3 dB folded in
    await s.edit("Volume", withSfxVolume(s.draft, 0.5));
    expect(s.unsaved).toBe(false);
    expect(s.status).toEqual({ kind: "saved" });
    expect(await fs.readText(`${ROOT}\\project.json`)).toBe('{ "name": "Game" }\n');
    const saved = parseAudioProject(await read(fs, "audio.json")).project;
    const bus = saved.buses.find((b) => b.name === "SFX")!;
    expect(bus.volumeDb).toBeCloseTo(20 * Math.log10(0.5) + 3, 6);
    expect(bus.effects.map((e) => e.id)).toEqual(["eq"]);
    expect(bus.sends).toEqual([{ to: "Delay", levelDb: -10 }]);
    expect(saved.vcas).toEqual([{ name: "Game", volumeDb: -3, members: ["SFX"] }]);
    expect(sfx(s.draft).volume).toBe(0.5);
    await s.undo();
    expect(parseAudioProject(await read(fs, "audio.json")).project.buses[1].volumeDb).toBe(-6); // undo lands on the level it left
  });

  it("an edit to another key writes project.json only, and the session keeps its history across both files' saves", async () => {
    const { project, fs } = await openTestProject({ "project.json": '{ "name": "Game" }\n', "audio.json": RICH_AUDIO });
    const s = createProjectSettingsSection().open(project);
    await s.edit("Width", setValue(s.draft, "display", "width", 320));
    expect(await fs.readText(`${ROOT}\\audio.json`)).toBe(RICH_AUDIO);
    await s.edit("Volume", withSfxVolume(s.draft, 0.25));
    const again = createProjectSettingsSection();
    const session = again.open(project);
    expect(session.draft.display).toEqual({ width: 320 });
    expect(sfx(session.draft).volume).toBe(0.25);
    expect(s.canUndo).toBe(true);
    expect(s.undoLabel).toBe("Volume");
  });

  it("a project without audio.json gets one on its first audio edit", async () => {
    const { project, fs } = await openTestProject({ "project.json": '{ "name": "Game" }\n' });
    const s = createProjectSettingsSection().open(project);
    expect(s.draft.audio).toBeUndefined();
    await s.edit("Volume", { ...s.draft, audio: { buses: [{ name: "Master", volume: 0.5 }] } });
    expect(parseAudioProject(await read(fs, "audio.json")).project.buses.map((b) => [b.name, b.volumeDb])).toEqual([["Master", expect.closeTo(20 * Math.log10(0.5), 6)]]);
    expect(await fs.readText(`${ROOT}\\project.json`)).toBe('{ "name": "Game" }\n');
  });
});
