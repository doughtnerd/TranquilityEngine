// ADR 0173: the Mixer panel's section is the SDK's `editor.project.settings`, the Project Settings panel's own history.
// `loadMixer` (through `registerMixPanels`'s view) fills `mixerHost.section`; a fader drag on the rendered panel (its real
// deps: draft and commit through the host's section; the play mixer's previews and readings spied) commits one undo step
// there; an undo from the Project Settings panel's history puts the value back, and the op log hands the restored volume
// to the play mixer (the heard value). No wall clock: the drag is three pointer events, the op log is synchronous, and
// the save is awaited through the SDK.
import { h } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editor, type EditorPluginContext, type SettingsDraft } from "../../../../editor/sdk";
import { projectSettings } from "../../../../editor/projectSettingsInstance";
import { closeTestProject, openTestProject } from "../../../../editor/testing";
import { find, render } from "../../../../editor/testRender";
import { EMPTY_BUS_LOUDNESS } from "../../../../engine/audio/loudnessTypes";
import { mixer, type Bus } from "../../../../engine/audio/mixer";
import type { MixOp } from "../../../../engine/audio/mixOps";
import { registerMixPanels } from "./index";
import { MixerPanel, mixerHost } from "./MixerPanel";
import { playState } from "../../../../editor/state";
import { startOpLog } from "./opLog";

vi.mock("preact/hooks", () => import("../../../../editor/testRender"));

const PROJECT = JSON.stringify({ name: "Game", audio: { buses: [{ name: "master" }, { name: "sfx", parent: "master" }, { name: "music", parent: "master" }] } }, null, 2);

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.restoreAllMocks();
  closeTestProject(); // `mixerHost` stays filled: the panel's module loads once, as in the editor
});

const sfxVolumeOf = (d: SettingsDraft): number | undefined => (d.audio as { buses: Array<{ name: string; volume?: number }> }).buses.find((b) => b.name === "sfx")!.volume;

/** The Mixer panel's view, loaded as the shell loads it: `registerMixPanels` then the panel's `view()`. */
async function loadMixerPanel(): Promise<void> {
  const views = new Map<string, () => Promise<unknown>>();
  registerMixPanels({ registerPanel: (p: { id: string; view: () => Promise<unknown> }) => void views.set(p.id, p.view) } as unknown as EditorPluginContext);
  await views.get("audiomixer")!();
}

async function rig() {
  const { project } = await openTestProject({ "project.json": PROJECT });
  await loadMixerPanel();
  // The play mixer: what it was last told for sfx's volume is what's heard.
  let heard = 1;
  playState.value = "playing"; // the op log is live only while Play runs
  disposers.push(() => void (playState.value = "edit"));
  const log = startOpLog(() => ({
      apply: (op: MixOp) => {
        if (op.op === "setBus" && op.bus === "sfx" && op.key === "volume") heard = op.value === null ? 1 : (op.value as number);
        return { ok: true, class: "direct" };
      },
  }));
  disposers.push(log.dispose);
  // The panel's previews go to the play mixer too, and its readings come from there.
  vi.spyOn(mixer, "apply").mockImplementation((op: MixOp) => {
    if (op.op === "setBus" && op.bus === "sfx" && op.key === "volume") heard = op.value as number;
    return { ok: true, class: "direct" };
  });
  vi.spyOn(mixer, "bus").mockImplementation(() => ({ exists: true, volume: heard, mute: false, solo: false, peak: 0, effectiveGain: 1, duckGain: 1, activeVoices: 0, loudness: EMPTY_BUS_LOUDNESS }) as unknown as Bus);
  const flushNow = mixerHost.flushNow;
  mixerHost.flushNow = () => {};
  const panel = render(() => h(MixerPanel, {}));
  disposers.push(() => { panel.unmount(); mixerHost.flushNow = flushNow; });
  /** The sfx fader's handlers, from the panel as rendered now. */
  const fader = () => find(panel.tree(), (n) => n.props["aria-label"] === "sfx volume")[0]!.props as unknown as Record<"onPointerDown" | "onPointerMove" | "onPointerUp", (e: unknown) => void>;
  const track = { getBoundingClientRect: () => ({ height: 100 }), setPointerCapture() {}, releasePointerCapture() {}, focus() {} };
  const pointer = (clientY: number) => ({ clientY, button: 0, shiftKey: false, pointerId: 7, currentTarget: track });
  return { project, heard: () => heard, log, fader, pointer };
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
    r.fader().onPointerDown(r.pointer(50));
    r.fader().onPointerMove(r.pointer(60));
    r.fader().onPointerMove(r.pointer(70)); // down: quieter
    expect(editor.project.settings.canUndo()).toBe(false); // previews never enter the history
    const v = editor.project.settings.version;
    r.fader().onPointerUp(r.pointer(70));
    await vi.waitFor(() => expect(sfxVolumeOf(JSON.parse(r.project.textOf("project.json")!) as SettingsDraft)).toBeDefined()); // saved
    const g = sfxVolumeOf(editor.project.settings.draft())!;
    expect(g).toBeLessThan(1);
    expect(editor.project.settings.version).toBeGreaterThan(v);
    expect(sfxVolumeOf(JSON.parse(r.project.textOf("project.json")!) as SettingsDraft)).toBeCloseTo(g, 9);
    expect(r.heard()).toBeCloseTo(g, 9);
    expect(panel.undoLabel).toBeTruthy(); // one step, the panel's history
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
