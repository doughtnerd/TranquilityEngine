// ADR 0173: the Mixer panel's section is the SDK's `editor.project.settings`, the Project Settings panel's own history.
// `loadMixer` (through `registerMixPanels`'s view) fills `mixerHost.section` from the SDK surface, and an edit in the
// Project Settings panel shows in the Mixer's draft and version. A fader drag on the rendered panel committing one undo
// step there, undone from either panel, is the FaderDrag story (MixerPanel.stories.tsx).
import { afterEach, describe, expect, it } from "vitest";
import { editor, type EditorPluginContext, type SettingsDraft } from "../../../../editor/sdk";
import { projectSettings } from "../../../../editor/projectSettingsInstance";
import { closeTestProject, openTestProject } from "../../../../editor/testing";
import { registerMixPanels } from "./index";
import { mixerHost } from "./MixerPanel";

const PROJECT = JSON.stringify({ name: "Game", audio: { buses: [{ name: "master" }, { name: "sfx", parent: "master" }, { name: "music", parent: "master" }] } }, null, 2);

afterEach(() => {
  closeTestProject(); // `mixerHost` stays filled: the panel's module loads once, as in the editor
});

const sfxVolumeOf = (d: SettingsDraft): number | undefined => (d.audio as { buses: Array<{ name: string; volume?: number }> }).buses.find((b) => b.name === "sfx")!.volume;

/** The Mixer panel's view, loaded as the shell loads it: `registerMixPanels` then the panel's `view()`. */
async function loadMixerPanel(): Promise<void> {
  const views = new Map<string, () => Promise<unknown>>();
  registerMixPanels({ registerPanel: (p: { id: string; view: () => Promise<unknown> }) => void views.set(p.id, p.view) } as unknown as EditorPluginContext);
  await views.get("audiomixer")!();
}

describe("the Mixer over editor.project.settings", () => {
  it("loadMixer fills mixerHost.section from the SDK surface", async () => {
    await openTestProject({ "project.json": PROJECT });
    await loadMixerPanel();
    expect(mixerHost.section).not.toBeNull();
    expect(mixerHost.section!.open(editor.project.peek()!).draft).toEqual(editor.project.settings.draft());
    expect(mixerHost.section!.history.name).toBe("Project Settings");
  });

  it("an edit in the Project Settings panel shows in the Mixer's draft and version", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    await loadMixerPanel();
    const section = mixerHost.section!; // the registration's view of Project Settings
    const v = section.version!.value;
    const panel = projectSettings.open(project);
    const audio = panel.draft.audio as { buses: Array<Record<string, unknown>> };
    await panel.edit("Set volume", { ...panel.draft, audio: { ...audio, buses: audio.buses.map((b) => (b.name === "sfx" ? { ...b, volume: 0.25 } : b)) } } as SettingsDraft);
    expect(section.version!.value).toBeGreaterThan(v);
    expect(sfxVolumeOf(section.open(project).draft)).toBe(0.25);
    expect(section.history.canUndo).toBe(true);
  });
});
