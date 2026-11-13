// ADR 0171/0172 (M5, task G7b; api-and-models §7): the Profiler's loudness track is registered beside the other factories with the
// project's target in force: `audio.loudnessTargets` (the mixer's settings) as `Audio.loudnessTarget` (the session's choice) names
// it. A case per option: each entry of the list, no selection (the first), and a project with no targets.
import { afterEach, describe, expect, it } from "vitest";
import type { EditorPluginContext } from "../../../../editor/sdk";
import { mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import { Audio } from "../../runtime/Audio";
import { loudnessHub } from "../../runtime/mix/loudnessHub";
import { LOUD_OUTPUT_TAP } from "../../runtime/wire.generated";
import { loudnessTargetNamed, registerMixPanels } from "./index";
import { buildScene, MUSIC_SLOT } from "./loudnessSceneSupport";
import { CaptureSource } from "./profilerSource";
import { LOUDNESS_MARKS_TRACK_ID, LOUDNESS_TRACK_ID, type LoudnessTrackModule } from "./tracks/loudness";
import { inProcessWorker } from "./voiceSceneSupport";

const TARGETS = [
  { name: "console", integrated: -24, tolerance: 2, truePeak: -1 },
  { name: "mobile", integrated: -16, tolerance: 1.5, truePeak: -2 },
];

describe("loudnessTargetNamed", () => {
  it("is the entry the session's target names; null for no target, an unknown name or no list", () => {
    expect(loudnessTargetNamed(TARGETS, "console")).toBe(TARGETS[0]);
    expect(loudnessTargetNamed(TARGETS, "mobile")).toBe(TARGETS[1]);
    expect(loudnessTargetNamed(TARGETS, null)).toBeNull();
    expect(loudnessTargetNamed(TARGETS, "cinema")).toBeNull();
    expect(loudnessTargetNamed([], "console")).toBeNull();
    expect(loudnessTargetNamed(undefined, "console")).toBeNull();
  });
});

describe("the Profiler's loudness track in loadProfiler", () => {
  afterEach(() => {
    mixer.configure(defaultAudioSettings());
    loudnessHub.configure({ available: false, root: "Master", buses: [] });
  });

  it("is registered with the project's target: the track's readout shows the target in force, and none when none is selected", async () => {
    const settings = defaultAudioSettings();
    settings.loudnessTargets = TARGETS.map((t) => ({ ...t }));
    mixer.configure(settings);
    loudnessHub.configure({ available: false, root: "Master", buses: [], targets: settings.loudnessTargets });

    const panels: { view: () => Promise<unknown> }[] = [];
    registerMixPanels({ registerPanel: (p: (typeof panels)[number]) => void panels.push(p) } as unknown as EditorPluginContext);
    await panels[0]!.view();
    const { profilerTrackFactories } = await import("./ProfilerPanel");
    const scene = buildScene();
    const source = await CaptureSource.openFile(scene.file.slice().buffer, { worker: inProcessWorker() });
    const ctx = { source, names: { clip: () => undefined, event: () => undefined, bus: (slot: number) => (slot === MUSIC_SLOT ? "Music" : slot === LOUD_OUTPUT_TAP ? "Master" : undefined) } };
    const made = profilerTrackFactories.map((f) => f(ctx));
    const loudness = made.find((mods) => mods.some((m) => m.track.id === LOUDNESS_TRACK_ID));
    expect(loudness, "a loudness factory is registered").toBeDefined();
    expect(loudness!.map((m) => m.track.id)).toEqual([LOUDNESS_TRACK_ID, LOUDNESS_MARKS_TRACK_ID]);
    const mod = loudness![0] as LoudnessTrackModule;
    const at = scene.expected.find((x) => x.slot === LOUD_OUTPUT_TAP && x.status === 79 && !x.afterEvent)!.t - source.startSeconds;

    for (const t of TARGETS) {
      Audio.loudnessTarget = t.name;
      await mod.refresh();
      expect(mod.tooltipAt!(at)).toContain(`Target ${t.name}: ${t.integrated.toFixed(1)} LUFS`);
    }
    // `null` selects the first entry (the hub's rule).
    Audio.loudnessTarget = null;
    await mod.refresh();
    expect(mod.tooltipAt!(at)).toContain("Target console:");
    // A project with no targets of its own has none in force: no line and no marks, whatever the session's name.
    const bare = defaultAudioSettings();
    bare.loudnessTargets = [];
    mixer.configure(bare);
    await mod.refresh();
    expect(mod.tooltipAt!(at)).not.toContain("Target");
    expect(mod.marks()).toEqual([]);
    source.close();
  });
});
