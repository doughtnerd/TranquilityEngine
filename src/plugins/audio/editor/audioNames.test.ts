import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectSettingsSection } from "../../../editor/projectSettingsSection";
import { nameReferences } from "../../../editor/sdk/contributions";
import { closeTestProject, openTestProject } from "../../../editor/testing";
import { useEditorPlugins } from "../../testEditorPlugins";
import { physicsEditorPlugin } from "../../physics/editor";
import { renameLayer } from "../../physics/editor/physicsSettingsModel";
import { AUDIO_PROJECT_FORMAT } from "../../../engine/audio/project/types";
import { occlusionLayerReferences } from "./audioNames";
import { audioEditorPlugin } from "./index";

// ADR 0262: `audio.json`'s occlusion layers follow a physics layer rename made in Project Settings > Physics, through the
// shell's settings names module (which rewrites the project's JSON files that name the layer).

const audioJson = (layers: string[]) => JSON.stringify({ format: AUDIO_PROJECT_FORMAT, settings: { occlusion: { layers } } });

describe("the occlusion layers' references to physics layers", () => {
  useEditorPlugins([physicsEditorPlugin, audioEditorPlugin]);
  afterEach(closeTestProject);

  it("are registered by the plugin", () => {
    expect(nameReferences.get("myco.audio.occlusion-layers")).toBe(occlusionLayerReferences);
  });

  it("follow a physics layer rename in audio.json", async () => {
    const { project } = await openTestProject({ "project.json": JSON.stringify({ physics: { layers: ["Default", "Walls", "Glass"] } }), "audio.json": audioJson(["Walls"]) });
    const s = createProjectSettingsSection().open(project);
    await s.edit("Rename physics layer to Stone", renameLayer(s.draft, 1, "Stone"));
    await vi.waitFor(() => expect(JSON.parse(project.textOf("audio.json")!).settings.occlusion.layers).toEqual(["Stone"]));
  });

  it("leave a file that doesn't list the layer, or isn't the audio project, as it is", () => {
    const [asset] = occlusionLayerReferences.assets!;
    const listed = JSON.parse(audioJson(["Walls"]));
    expect(asset!.rename(listed, "Glass", "Pane")).toBe(listed);
    const other = { format: "something@1", settings: { occlusion: { layers: ["Glass"] } } };
    expect(asset!.rename(other, "Glass", "Pane")).toBe(other);
  });
});
