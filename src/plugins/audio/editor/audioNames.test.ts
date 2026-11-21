import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectSettingsSection } from "../../../editor/projectSettingsSection";
import { nameReferences, projectSettingsSections } from "../../../editor/sdk/contributions";
import { closeTestProject, openTestProject } from "../../../editor/testing";
import type { EditorProject } from "../../../editor/projects";
import { useEditorPlugins } from "../../testEditorPlugins";
import { physicsEditorPlugin } from "../../physics/editor";
import { renameLayer } from "../../physics/editor/physicsSettingsModel";
import { audioNamedLists, occlusionLayerReferences } from "./audioNames";
import { audioEditorPlugin } from "./index";
import { addMaterial, globalParameterList, renameBus, renameMaterial } from "./audioSettingsModel";
import type { EditResult } from "./editResult";

/** The accepted draft of an edit (ADR 0307), or the test fails with its refusal. */
const nextOf = <T,>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};

// The Audio section's named lists (ADR 0262): renaming a bus, an acoustic material or a global parameter in the
// settings renames the scenes and audio event files that name it, through the shell's settings names module.

const scene = (components: unknown[]) => JSON.stringify({ format: "myco.scene@1", nodes: [{ id: "n", name: "N", components }] });
const EVENT = {
  format: "myco.audioevent@1",
  bus: "SFX",
  sends: { reverb: 0.5, SFX: 0.3, UI: 0.1 },
  automation: [{ parameter: "Speed", target: "volume", curve: [[0, 0], [1, 1]] }],
  root: { type: "switch", parameter: "Speed", children: [{ type: "clip", clip: "a.ogg", automation: [{ parameter: "Speed", target: "pitch", curve: [[0, 1], [1, 2]] }] }] },
};
const MUSIC = { format: "myco.audioevent@1", bus: "Music", root: { type: "segment", id: "s", tracks: [{ clip: "m.ogg", bus: "SFX", automation: [{ parameter: "Speed", target: "volume", curve: [[0, 0], [1, 1]] }] }], regions: [{ id: "r", from: "1:1:0", to: "2:1:0", while: { parameter: "Speed", atLeast: 1 } }] } };
const LOCAL = { format: "myco.audioevent@1", bus: "UI", parameters: [{ name: "Speed", min: 0, max: 1, default: 0, seekSpeed: 0 }], automation: [{ parameter: "Speed", target: "volume", curve: [[0, 0], [1, 1]] }], root: { type: "layer", children: [] } };

const json = (project: EditorProject, path: string) => JSON.parse(project.textOf(path)!);

describe("the Audio section's named lists", () => {
  useEditorPlugins([physicsEditorPlugin, audioEditorPlugin]);
  afterEach(closeTestProject);

  it("are declared on the section, with the occlusion layers' references to physics layers", () => {
    expect(projectSettingsSections.get("audio")?.names).toBe(audioNamedLists);
    expect(audioNamedLists.map((l) => l.id)).toEqual(["audio.buses", "audio.materials", "audio.parameters"]);
    expect(nameReferences.get("myco.audio.occlusion-layers")).toBe(occlusionLayerReferences);
  });

  it("rename a bus in sources, reverb zones and event files: the event's bus, its aux send and a music track's bus", async () => {
    const { project } = await openTestProject({
      "project.json": "{}",
      "a.scene.json": scene([{ type: "engine.AudioSource", data: { output: "SFX" } }, { type: "engine.AudioReverbZone", data: { output: "SFX" } }, { type: "engine.AudioSource", data: { output: "UI" } }]),
      "hit.audioevent.json": JSON.stringify(EVENT),
      "town.audioevent.json": JSON.stringify(MUSIC),
    });
    const s = createProjectSettingsSection().open(project);
    await s.edit("Rename bus SFX to Effects", nextOf(renameBus(s.draft, "SFX", "Effects")));
    await vi.waitFor(() => expect(project.textOf("town.audioevent.json")).toContain('"Effects"'));
    expect(json(project, "a.scene.json").nodes[0].components.map((c: { data: { output: string } }) => c.data.output)).toEqual(["Effects", "Effects", "UI"]);
    const hit = json(project, "hit.audioevent.json");
    expect(hit.bus).toBe("Effects");
    expect(hit.sends).toEqual({ reverb: 0.5, Effects: 0.3, UI: 0.1 });
    expect(Object.keys(hit.sends)).toEqual(["reverb", "Effects", "UI"]); // order kept
    expect(json(project, "town.audioevent.json").root.tracks[0].bus).toBe("Effects");
    expect(json(project, "town.audioevent.json").bus).toBe("Music");

    await s.undo(); // the rename goes back in the files too
    await vi.waitFor(() => expect(json(project, "hit.audioevent.json").bus).toBe("SFX"));
    expect(json(project, "a.scene.json").nodes[0].components[0].data.output).toBe("SFX");
  });

  it("rename a global parameter in events that read it, but not in one whose own parameter has the name", async () => {
    const { project } = await openTestProject({ "project.json": "{}", "hit.audioevent.json": JSON.stringify(EVENT), "town.audioevent.json": JSON.stringify(MUSIC), "local.audioevent.json": JSON.stringify(LOCAL) });
    const s = createProjectSettingsSection().open(project);
    await s.edit("Add parameter", nextOf(globalParameterList.add(s.draft)));
    await s.edit("Rename parameter", nextOf(globalParameterList.rename(s.draft, "Parameter", "Speed")));
    await s.edit("Rename parameter Speed to Pace", nextOf(globalParameterList.rename(s.draft, "Speed", "Pace")));
    await vi.waitFor(() => expect(project.textOf("town.audioevent.json")).toContain('"Pace"'));
    expect(JSON.stringify(json(project, "hit.audioevent.json"))).not.toContain('"Speed"');
    expect(json(project, "hit.audioevent.json").root.parameter).toBe("Pace");
    const town = json(project, "town.audioevent.json").root;
    expect([town.tracks[0].automation[0].parameter, town.regions[0].while.parameter]).toEqual(["Pace", "Pace"]);
    expect(project.textOf("local.audioevent.json")).toBe(JSON.stringify(LOCAL)); // untouched
  });

  it("rename a custom acoustic material in occluders", async () => {
    const { project } = await openTestProject({ "project.json": "{}", "a.scene.json": scene([{ type: "engine.AudioOccluder", data: { material: "Material" } }, { type: "engine.AudioOccluder", data: { material: "concrete" } }]) });
    const s = createProjectSettingsSection().open(project);
    await s.edit("Add material", addMaterial(s.draft));
    await s.edit("Rename material", renameMaterial(s.draft, "Material", "Felt"));
    await vi.waitFor(() => expect(project.textOf("a.scene.json")).toContain('"Felt"'));
    expect(json(project, "a.scene.json").nodes[0].components[1].data.material).toBe("concrete");
  });

  it("follow a physics layer rename in audio.occlusion.layers, in the same undo step", async () => {
    const { project } = await openTestProject({ "project.json": JSON.stringify({ physics: { layers: ["Default", "Walls", "Glass"] }, audio: { occlusion: { layers: ["Walls"] } } }) });
    const s = createProjectSettingsSection().open(project);
    await s.edit("Rename physics layer to Stone", renameLayer(s.draft, 1, "Stone"));
    expect((s.draft.audio as { occlusion: { layers: string[] } }).occlusion.layers).toEqual(["Stone"]);
    await s.undo();
    expect((s.draft.audio as { occlusion: { layers: string[] } }).occlusion.layers).toEqual(["Walls"]);
    expect(occlusionLayerReferences.settings!(s.draft, "Glass", "Pane")).toBe(s.draft); // not listed: unchanged
  });
});
