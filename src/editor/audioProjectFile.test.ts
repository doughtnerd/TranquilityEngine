// ADR 0344: the editor migrates an old project.json audio section to audio.json when a project opens and serves
// audio.json's runtime view as the settings' `audio` (read by Play and the audio Inspector sections). Nothing in the
// editor writes audio.json since the Audio Studio replaced the legacy panels (decision D2's adapter is gone).
import { afterEach, describe, expect, it } from "vitest";
import { parseAudioProject } from "../engine/audio/project/format";
import type { AudioSettings } from "../engine/audio/settings";
import { ROOT, closeTestProject, openTestProject } from "./testing";
import { createProjectSettingsSection } from "./projectSettingsSection";
import { setValue } from "./projectSettingsModel";
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
    // The settings serve the runtime view: the old section as it was, its reverb send a send into the Reverb return (a
    // bus of the view, ADR 0344).
    const buses = (project.settings.audio as unknown as AudioSettings).buses;
    expect(buses[1]).toMatchObject({ name: "SFX", volume: 0.5, effects: [], sends: [{ to: "Reverb", level: 0.25 }] });
    expect(buses.at(-1)).toMatchObject({ name: "Reverb", parent: "Master" });
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

describe("the settings draft and audio.json", () => {
  it("Project Settings holds no audio: an edit writes project.json only and leaves audio.json alone", async () => {
    const { project, fs } = await openTestProject({ "project.json": '{ "name": "Game" }\n', "audio.json": RICH_AUDIO });
    const s = createProjectSettingsSection().open(project);
    expect(s.draft.audio).toBeUndefined();
    await s.edit("Width", setValue(s.draft, "display", "width", 320));
    expect(await fs.readText(`${ROOT}\\audio.json`)).toBe(RICH_AUDIO);
    expect(await read(fs, "project.json")).toEqual({ name: "Game", display: { width: 320 } });
    // Play and the audio Inspector sections still read audio.json's runtime view (its returns after the buses, ADR 0344).
    expect((project.settings.audio as unknown as AudioSettings).buses.map((b) => b.name)).toEqual(["Master", "SFX", "Delay"]);
  });
});
