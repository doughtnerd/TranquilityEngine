// ADR 0173: the Mixer panel's section is the SDK's `editor.project.settings`, the Project Settings panel's own history.
// `loadMixer` (through `registerMixPanels`'s view) fills `mixerHost.section`; a fader drag over the panel's real deps
// (`defaultMixerDeps`: draft and commit through the host's section) commits one undo step there; an undo from the Project
// Settings panel's history puts the value back, and the op log hands the restored volume to the play mixer (the heard value).
// No wall clock: the drag is three calls, the op log is synchronous, and the save is awaited through the SDK.
import { afterEach, describe, expect, it } from "vitest";
import { editor, type EditorPluginContext, type SettingsDraft } from "../../../../editor/sdk";
import { projectSettings } from "../../../../editor/projectSettingsInstance";
import { closeTestProject, openTestProject } from "../../../../editor/testing";
import { EMPTY_BUS_LOUDNESS } from "../../../../engine/audio/loudnessTypes";
import type { MixOp } from "../../../../engine/audio/mixOps";
import { positionToGain } from "./faderModel";
import { MIXER_PANEL, mixerSectionOf, registerMixPanels } from "./index";
import { defaultMixerDeps, mixerHost } from "./MixerPanel";
import { MixerPanelController } from "./mixerPanelModel";
import { createOpLog } from "./opLog";

const PROJECT = JSON.stringify({ name: "Game", audio: { buses: [{ name: "master" }, { name: "sfx", parent: "master" }, { name: "music", parent: "master" }] } }, null, 2);

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  closeTestProject(); // `mixerHost` stays filled: the panel's module loads once, as in the editor
});

const sfxVolumeOf = (d: SettingsDraft): number | undefined => (d.audio as { buses: Array<{ name: string; volume?: number }> }).buses.find((b) => b.name === "sfx")!.volume;

/** The Mixer panel's view, loaded as the shell loads it: `registerMixPanels` then the panel's `view()`. */
async function loadMixerPanel(): Promise<void> {
  const views = new Map<string, () => Promise<unknown>>();
  registerMixPanels({ registerPanel: (p: { id: string; view: () => Promise<unknown> }) => void views.set(p.id, p.view) } as unknown as EditorPluginContext);
  await views.get(MIXER_PANEL)!();
}

async function rig() {
  const { project } = await openTestProject({ "project.json": PROJECT });
  await loadMixerPanel();
  // The play mixer: what it was last told for sfx's volume is what's heard.
  let heard = 1;
  const log = createOpLog({
    onSectionChanged: (k, l) => editor.project.onSectionChanged(k, l),
    isPlaying: () => true,
    mixer: () => ({
      apply: (op: MixOp) => {
        if (op.op === "setBus" && op.bus === "sfx" && op.key === "volume") heard = op.value === null ? 1 : (op.value as number);
        return { ok: true, class: "direct" };
      },
    }),
  });
  disposers.push(log.dispose);
  const commits: string[] = [];
  let saved: void | Promise<void> = undefined;
  const real = defaultMixerDeps();
  const c = new MixerPanelController(
    {
      ...real,
      commit: (label, next) => (commits.push(label), (saved = real.commit(label, next))), // the host's section, i.e. the SDK
      playing: () => true,
      apply: (op) => (op.op === "setBus" && op.bus === "sfx" && op.key === "volume" && (heard = op.value as number), { ok: true, class: "direct" }), // the preview
      flushNow: () => {},
      readBus: () => ({ runtimeVolume: heard, runtimeMute: false, solo: false, peak: 0, effectiveGain: 1, duckGain: 1, activeVoices: 0, loudness: EMPTY_BUS_LOUDNESS }),
      setMonitor: () => {},
      hub: undefined,
      mark: () => {},
      clock: () => 0,
    },
    () => {},
  );
  c.sample();
  /** The last commit's save (`edit` resolves once project.json is written). */
  const settle = () => saved;
  return { project, c, commits, heard: () => heard, log, settle };
}

describe("the Mixer over editor.project.settings", () => {
  it("loadMixer fills mixerHost.section from the SDK surface", async () => {
    await openTestProject({ "project.json": PROJECT });
    await loadMixerPanel();
    expect(mixerHost.section).not.toBeNull();
    expect(mixerHost.section!.open(editor.project.peek()!).draft).toEqual(editor.project.settings.draft());
    expect(mixerHost.section!.history.name).toBe("Project Settings");
  });

  it("a fader drag commits one undo step in the Project Settings history; its undo restores the value and the heard value", async () => {
    const r = await rig();
    const panel = projectSettings.open(r.project); // what the Project Settings panel edits and undoes
    expect(r.c.stripModel.beginDrag("sfx")).toBe(true);
    r.c.stripModel.drag(positionToGain(0.4));
    r.c.stripModel.drag(positionToGain(0.5));
    expect(editor.project.settings.canUndo()).toBe(false); // previews never enter the history
    const v = editor.project.settings.version;
    r.c.stripModel.endDrag();
    await r.settle();
    const g = positionToGain(0.5);
    expect(r.commits).toHaveLength(1);
    expect(editor.project.settings.version).toBeGreaterThan(v);
    expect(sfxVolumeOf(editor.project.settings.draft())).toBeCloseTo(g, 9);
    expect(sfxVolumeOf(JSON.parse(r.project.textOf("project.json")!) as SettingsDraft)).toBeCloseTo(g, 9); // saved
    expect(r.heard()).toBeCloseTo(g, 9);
    expect(panel.undoLabel).toBe(r.commits[0]); // one step, the panel's history
    // The Project Settings panel's Undo.
    await panel.undo();
    expect(sfxVolumeOf(editor.project.settings.draft())).toBeUndefined();
    expect(r.heard()).toBe(1);
    expect(panel.canUndo).toBe(false); // it was one step
    expect(r.log.entries.at(-1)!.cause).toBe("undo");
    // And the other way: the SDK redoes, the Mixer's own Ctrl+Z (its history) undoes.
    editor.project.settings.redo();
    expect(r.heard()).toBeCloseTo(g, 9);
    expect(mixerHost.section!.history.canUndo).toBe(true);
    mixerHost.section!.history.undo();
    expect(sfxVolumeOf(panel.draft)).toBeUndefined();
    expect(r.heard()).toBe(1);  });

  it("an edit in the Project Settings panel shows in the Mixer's draft and version", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const section = mixerSectionOf(editor.project.settings);
    const v = section.version!.value;
    const panel = projectSettings.open(project);
    const audio = panel.draft.audio as { buses: Array<Record<string, unknown>> };
    await panel.edit("Set volume", { ...panel.draft, audio: { ...audio, buses: audio.buses.map((b) => (b.name === "sfx" ? { ...b, volume: 0.25 } : b)) } } as SettingsDraft);
    expect(section.version!.value).toBeGreaterThan(v);
    expect(sfxVolumeOf(section.open(project).draft)).toBe(0.25);
    expect(section.history.canUndo).toBe(true);
  });
});
