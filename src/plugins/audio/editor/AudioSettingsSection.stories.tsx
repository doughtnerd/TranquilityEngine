// Stories (ADR 0219) for the Project panel's Audio section, its ducking rules (Dk1): each control with each option, the
// refusals the parse makes (a bus ducking itself, a trigger above its target, a level cycle, the 9th level rule, the
// 33rd rule), "Needs the audio core" on a backend without level ducking, and a live edit during Play reaching the play
// mixer through the op log. The section is rendered through its real props: a draft, its problems and `set`, which a
// story's harness keeps as the Project Settings panel does (each accepted edit is the next draft). The same cases run
// headless in audioSettingsSection.ducking.test.ts until the story tests have run green.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fireEvent, fn, userEvent, waitFor, within } from "storybook/test";
import type { MixOp } from "../../../engine/audio/mixOps";
import type { DuckingRule } from "../../../engine/audio/settings";
import { MemoryFileSystem } from "../../../editor/memoryFs";
import { createProjectSettingsSection } from "../../../editor/projectSettingsSection";
import { openFolderProject } from "../../../editor/projects";
import type { SettingsDraft } from "../../../editor/sdk";
import { currentProject, playState } from "../../../editor/state";
import { AudioSettingsSection } from "./AudioSettingsSection";
import { audioOf } from "./audioSettingsModel";
import { newDuckRule } from "./mix/duckModel";
import { startOpLog } from "./mix/opLog";

type SetSpy = ReturnType<typeof fn<(label: string, next: SettingsDraft) => void>>;
interface Args {
  /** The project's `audio` section. */
  audio: Record<string, unknown>;
  /** The section's `set`: every accepted edit, with its undo label. */
  set: SetSpy;
}

/** The section over a draft the harness keeps: `set` is reported to the spy and becomes the next draft. */
function Section({ audio, set }: Args) {
  const [draft, setDraft] = useState<SettingsDraft>(() => ({ audio: structuredClone(audio) }) as SettingsDraft);
  return (
    <AudioSettingsSection
      draft={draft}
      problems={[]}
      set={(label, next) => {
        set(label, next);
        setDraft(next);
      }}
    />
  );
}

/** The rules as the section last wrote them (the story's starting rules before any edit). */
const rulesOf = (args: Args): DuckingRule[] => {
  const last = args.set.mock.calls.at(-1);
  return audioOf(last ? last[1] : ({ audio: args.audio } as SettingsDraft)).ducking;
};
const labelsOf = (args: Args): string[] => args.set.mock.calls.map((c) => c[0]);

const level = (target: string, trigger: string, over: object = {}) => ({ target, trigger, mode: "level", ...over });
const presence = (target: string, trigger: string, over: object = {}) => ({ target, trigger, mode: "presence", ...over });

/** The section's controls, found by their labels as a screen reader finds them. */
function controls(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const field = (label: string) => canvas.getByLabelText(label) as HTMLInputElement | HTMLSelectElement;
  return {
    canvas,
    field,
    has: (label: string) => canvas.queryByLabelText(label) !== null,
    options: (label: string) => [...(field(label) as HTMLSelectElement).options].map((o) => o.value),
    pick: (label: string, value: string) => userEvent.selectOptions(field(label), value),
    /** Commit a number as the field does on change (typing, then leaving the field). */
    type: (label: string, n: number) => fireEvent.change(field(label), { target: { value: String(n) } }),
    click: (label: string) => userEvent.click(canvas.getByLabelText(label)),
    add: () => canvas.getByRole("button", { name: /Ducking rule/ }),
    refusal: () => canvasElement.querySelector("[data-duck-refusal]")?.textContent ?? null,
    needsCore: () => [...canvasElement.querySelectorAll("[data-needs-core]")].map((n) => [Number(n.getAttribute("data-needs-core")), n.textContent]),
  };
}

const meta = {
  title: "Audio/Project settings/Ducking",
  render: (args) => <Section {...args} />,
  args: { audio: { ducking: [] }, set: fn() },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

export const Empty: Story = {
  args: { audio: { ducking: [] } },
  play: async ({ canvasElement, args }) => {
    const c = controls(canvasElement);
    await userEvent.click(c.add());
    expect(rulesOf(args)).toEqual([{ target: "Music", trigger: "Voice", mode: "level", detector: "rms", threshold: -30, amount: 0.4, attack: 0.1, release: 0.5 }]);
    expect(labelsOf(args)).toEqual(["Add ducking rule"]);
    expect(c.refusal()).toBeNull();
    // The form shows the new rule's mode, detector and threshold.
    expect(c.field("Ducking 1 mode").value).toBe("level");
    expect(c.field("Ducking 1 detector").value).toBe("rms");
    expect(c.field("Ducking 1 threshold").value).toBe("-30");
    // Each press adds another, in order.
    await userEvent.click(c.add());
    await userEvent.click(c.add());
    expect(rulesOf(args)).toHaveLength(3);
    expect(rulesOf(args).every((x) => x.mode === "level" && x.detector === "rms" && x.threshold === -30)).toBe(true);
  },
};

export const TwoBuses: Story = {
  args: { audio: { buses: [{ name: "Master" }, { name: "Fx", parent: "Master" }], ducking: [] } },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(controls(canvasElement).add());
    expect(rulesOf(args)).toHaveLength(1);
    expect(rulesOf(args)[0]).toMatchObject({ target: "Master", trigger: "Fx", mode: "level" });
  },
};

export const OneBus: Story = {
  args: { audio: { buses: [{ name: "Master" }], ducking: [] } },
  play: async ({ canvasElement }) => {
    expect(controls(canvasElement).add()).toBeDisabled();
  },
};

export const PresenceRule: Story = {
  args: { audio: { ducking: [presence("Music", "Voice")] } },
  play: async ({ canvasElement, args, step }) => {
    const c = controls(canvasElement);
    expect(c.options("Ducking 1 mode")).toEqual(["presence", "level"]);
    expect(c.has("Ducking 1 detector")).toBe(false);
    expect(c.has("Ducking 1 threshold")).toBe(false);
    await step("amount, attack and release on a presence rule", async () => {
      await c.type("Ducking 1 amount", 0.25);
      await c.type("Ducking 1 attack", 0.02);
      await c.type("Ducking 1 release", 1.5);
      expect(rulesOf(args)[0]).toMatchObject({ mode: "presence", amount: 0.25, attack: 0.02, release: 1.5 });
    });
    await step("a presence rule takes the target choices", async () => {
      await c.pick("Ducking 1 target", "UI");
      expect(rulesOf(args)[0]).toMatchObject({ mode: "presence", target: "UI" });
    });
    await step("presence to level adds the detector and threshold controls with the defaults", async () => {
      await c.pick("Ducking 1 mode", "level");
      expect(rulesOf(args)[0]).toMatchObject({ mode: "level", detector: "rms", threshold: -30 });
      expect(c.field("Ducking 1 detector").value).toBe("rms");
      expect(c.field("Ducking 1 threshold").value).toBe("-30");
    });
  },
};

export const LevelRule: Story = {
  args: { audio: { ducking: [level("Music", "Voice", { amount: 0.7, attack: 2, release: 3 })] } },
  play: async ({ canvasElement, args, step }) => {
    const c = controls(canvasElement);
    await step("choosing the mode a rule already has changes nothing", async () => {
      await c.pick("Ducking 1 mode", "level");
      expect(labelsOf(args)).toEqual([]);
    });
    await step("the detector offers peak and rms; each is written", async () => {
      expect(c.options("Ducking 1 detector")).toEqual(["peak", "rms"]);
      await c.pick("Ducking 1 detector", "peak");
      expect(rulesOf(args)[0]!.detector).toBe("peak");
      expect(c.field("Ducking 1 detector").value).toBe("peak");
      await c.pick("Ducking 1 detector", "rms");
      expect(rulesOf(args)[0]!.detector).toBe("rms");
    });
    await step("the threshold's limits are -80 and 0; typical values are written, values outside are clamped", async () => {
      const f = c.field("Ducking 1 threshold") as HTMLInputElement;
      expect([f.min, f.max]).toEqual(["-80", "0"]);
      for (const n of [-80, 0, -18, -30]) {
        await c.type("Ducking 1 threshold", n);
        expect(rulesOf(args)[0]!.threshold).toBe(n);
      }
      await c.type("Ducking 1 threshold", -200);
      expect(rulesOf(args)[0]!.threshold).toBe(-80);
      await c.type("Ducking 1 threshold", 20);
      expect(rulesOf(args)[0]!.threshold).toBe(0);
    });
    await step("amount, attack and release: each limit and a typical value", async () => {
      for (const [key, values] of [["amount", [0, 1, 0.4]], ["attack", [10, 0, 0.1]], ["release", [10, 0, 0.5]]] as const) {
        for (const n of values) {
          await c.type(`Ducking 1 ${key}`, n);
          expect(rulesOf(args)[0]![key]).toBe(n);
        }
      }
      await c.type("Ducking 1 amount", 2);
      await c.type("Ducking 1 attack", 50);
      await c.type("Ducking 1 release", -1);
      expect(rulesOf(args)[0]).toMatchObject({ amount: 1, attack: 10, release: 0 });
    });
    await step("level to presence drops the detector and threshold, and their controls", async () => {
      await c.pick("Ducking 1 mode", "presence");
      expect("detector" in rulesOf(args)[0]! || "threshold" in rulesOf(args)[0]!).toBe(false);
      expect(c.has("Ducking 1 detector")).toBe(false);
      expect(c.has("Ducking 1 threshold")).toBe(false);
    });
  },
};

export const TargetAndTrigger: Story = {
  args: { audio: { ducking: [level("Music", "Voice")] } },
  play: async ({ canvasElement, args, step }) => {
    const c = controls(canvasElement);
    await step("a bus can't duck itself: refused with the parse's message, the rule stays", async () => {
      await c.pick("Ducking 1 trigger", "Music");
      expect(labelsOf(args)).toEqual([]);
      expect(c.refusal()).toContain("a bus can't duck itself");
    });
    await step("a trigger above its target is refused", async () => {
      await c.pick("Ducking 1 trigger", "Master");
      expect(c.refusal()).toContain("Master is above Music in the tree");
      expect(rulesOf(args)[0]!.trigger).toBe("Voice");
    });
    await step("each lists every bus and each choice is written", async () => {
      expect(c.options("Ducking 1 target")).toEqual(["Master", "Music", "SFX", "UI", "Voice"]);
      expect(c.options("Ducking 1 trigger")).toEqual(["Master", "Music", "SFX", "UI", "Voice"]);
      await c.pick("Ducking 1 target", "SFX");
      await c.pick("Ducking 1 trigger", "UI");
      expect(rulesOf(args)[0]).toMatchObject({ target: "SFX", trigger: "UI" });
      expect(c.refusal()).toBeNull();
    });
  },
};

export const ThreeRules: Story = {
  args: { audio: { ducking: [level("Music", "Voice"), presence("SFX", "Voice"), level("UI", "Voice", { threshold: -12 })] } },
  play: async ({ canvasElement, args, step }) => {
    const c = controls(canvasElement);
    expect(c.canvas.getByLabelText("Move ducking rule 1 up")).toBeDisabled();
    expect(c.canvas.getByLabelText("Move ducking rule 3 down")).toBeDisabled();
    expect(c.canvas.getByLabelText("Move ducking rule 2 up")).toBeEnabled();
    await step("move down and move up swap neighbours, each rule moved whole", async () => {
      await c.click("Move ducking rule 1 down");
      expect(rulesOf(args).map((x) => x.target)).toEqual(["SFX", "Music", "UI"]);
      await c.click("Move ducking rule 3 up");
      expect(rulesOf(args).map((x) => x.target)).toEqual(["SFX", "UI", "Music"]);
      expect(rulesOf(args).map((x) => x.mode)).toEqual(["presence", "level", "level"]);
    });
    await step("remove drops that rule and clears a showing refusal", async () => {
      await c.pick("Ducking 2 trigger", "UI"); // a bus can't duck itself
      expect(c.refusal()).not.toBeNull();
      await c.click("Remove ducking rule 2");
      expect(rulesOf(args).map((x) => x.target)).toEqual(["SFX", "Music"]);
      expect(c.refusal()).toBeNull();
      expect(labelsOf(args).at(-1)).toBe("Remove ducking rule");
    });
    await step("remove the first and the last", async () => {
      await c.click("Remove ducking rule 1");
      expect(rulesOf(args).map((x) => x.target)).toEqual(["Music"]);
      await c.click("Remove ducking rule 1");
      expect(rulesOf(args)).toEqual([]);
      expect(c.canvas.getByText("None")).toBeVisible();
    });
  },
};

export const LevelCycle: Story = {
  args: { audio: { ducking: [level("Music", "Voice"), level("SFX", "Music")] } },
  play: async ({ canvasElement, args, step }) => {
    const c = controls(canvasElement);
    await step("two rules: A ducks B and B ducks A is refused, naming both", async () => {
      await c.pick("Ducking 2 target", "Voice");
      expect(labelsOf(args)).toEqual([]);
      const msg = c.refusal();
      expect(msg).toContain("level rules can't form a cycle");
      expect(msg).toContain("ducking[0] (Voice ducks Music)");
      expect(msg).toContain("ducking[1] (Music ducks Voice)");
      expect(rulesOf(args)[1]!.target).toBe("SFX");
    });
    await step("the next successful edit clears the message", async () => {
      await c.type("Ducking 1 amount", 0.2);
      await waitFor(() => expect(c.refusal()).toBeNull());
    });
    await step("the same pair as presence is accepted", async () => {
      await c.pick("Ducking 2 mode", "presence");
      await c.pick("Ducking 2 target", "Voice");
      expect(c.refusal()).toBeNull();
      expect(rulesOf(args)[1]).toMatchObject({ mode: "presence", target: "Voice", trigger: "Music" });
    });
    await step("switching that presence rule to level refuses: it closes the cycle", async () => {
      await c.pick("Ducking 2 mode", "level");
      expect(c.refusal()).toContain("ducking[1] (Music ducks Voice)");
      expect(rulesOf(args)[1]!.mode).toBe("presence");
    });
  },
};

export const ThreeRuleCycle: Story = {
  args: { audio: { ducking: [level("Music", "Voice"), level("SFX", "Music"), level("UI", "SFX")] } },
  play: async ({ canvasElement, args }) => {
    const c = controls(canvasElement);
    await c.pick("Ducking 3 target", "Voice");
    expect(c.refusal()).toMatch(/ducking\[0\] \(Voice ducks Music\).*ducking\[1\] \(Music ducks SFX\).*ducking\[2\] \(SFX ducks Voice\)/);
    expect(rulesOf(args)[2]!.target).toBe("UI");
  },
};

const eightLevel = () => Array.from({ length: 8 }, () => level("Music", "Voice"));

export const EightLevelRules: Story = {
  args: { audio: { ducking: [...eightLevel(), presence("SFX", "Voice")] } },
  play: async ({ canvasElement, args, step }) => {
    const c = controls(canvasElement);
    await step("the 9th level rule is refused with its message and isn't saved", async () => {
      await userEvent.click(c.add());
      expect(labelsOf(args)).toEqual([]);
      expect(c.refusal()).toContain("at most 8 level rules");
    });
    await step("a presence rule can't be switched to level as the 9th level rule", async () => {
      await c.pick("Ducking 9 mode", "level");
      expect(c.refusal()).toContain("at most 8 level rules");
      expect(rulesOf(args)[8]!.mode).toBe("presence");
    });
    await step("removing a level rule makes room again", async () => {
      await c.click("Remove ducking rule 1");
      await userEvent.click(c.add());
      expect(c.refusal()).toBeNull();
      expect(rulesOf(args).filter((r) => r.mode === "level")).toHaveLength(8);
    });
  },
};

export const ManyRules: Story = {
  args: { audio: { ducking: Array.from({ length: 32 }, () => presence("Music", "Voice")) } },
  play: async ({ canvasElement, args }) => {
    const c = controls(canvasElement);
    expect(c.canvas.getAllByRole("group", { name: /^Ducking rule \d+$/ })).toHaveLength(32);
    await userEvent.click(c.add());
    expect(labelsOf(args)).toEqual([]);
    expect(c.refusal()).toContain("at most 32 rules");
  },
};

export const BabylonBackend: Story = {
  args: { audio: { backend: "babylon", ducking: [level("Music", "Voice"), presence("SFX", "Voice"), level("UI", "Voice")] } },
  play: async ({ canvasElement, args, step }) => {
    const c = controls(canvasElement);
    expect(c.needsCore()).toEqual([[0, "Needs the audio core"], [2, "Needs the audio core"]]);
    await step("the rule is kept and still editable there", async () => {
      await c.type("Ducking 1 threshold", -24);
      await c.pick("Ducking 1 detector", "peak");
      expect(rulesOf(args)[0]).toMatchObject({ mode: "level", detector: "peak", threshold: -24 });
    });
    await step("switching to presence removes the note", async () => {
      await c.pick("Ducking 1 mode", "presence");
      expect(c.needsCore()).toEqual([[2, "Needs the audio core"]]);
    });
  },
};

export const CoreBackend: Story = {
  args: { audio: { ducking: [level("Music", "Voice")] } },
  play: async ({ canvasElement }) => {
    expect(controls(canvasElement).needsCore()).toEqual([]);
  },
};

// ---- a live edit during Play: the section over the project's settings, the op log feeding a spied mixer ----

interface LiveArgs {
  /** The play mixer's `apply`, as the op log calls it. */
  apply: ReturnType<typeof fn<(op: MixOp) => { ok: true; class: "direct" }>>;
}

/** The section edited through the Project Settings section of an in-memory project, as the Project panel does. */
function LiveSection({ section }: { section: ReturnType<ReturnType<typeof createProjectSettingsSection>["open"]> }) {
  const [draft, setDraft] = useState(section.draft);
  return <AudioSettingsSection draft={draft} problems={[]} set={(label, next) => void section.edit(label, next).then(() => setDraft(section.draft))} />;
}

export const LiveEditDuringPlay: StoryObj<LiveArgs> = {
  args: { apply: fn(() => ({ ok: true, class: "direct" }) as const) },
  loaders: [
    async () => {
      const fs = new MemoryFileSystem();
      fs.files.set("C:\\Games\\live\\project.json", JSON.stringify({ name: "G", audio: { ducking: [level("Music", "Voice")] } }));
      const project = await openFolderProject(fs, "C:\\Games\\live");
      currentProject.value = project;
      return { section: createProjectSettingsSection().open(project) };
    },
  ],
  beforeEach: ({ args }) => {
    playState.value = "playing"; // the op log is live only while Play runs
    const log = startOpLog(() => ({ apply: args.apply }));
    return () => {
      log.dispose();
      playState.value = "edit";
      currentProject.value = null;
    };
  },
  render: (_args, { loaded }) => <LiveSection section={loaded.section} />,
  play: async ({ canvasElement, args }) => {
    const c = controls(canvasElement);
    await c.type("Ducking 1 threshold", -20);
    await waitFor(() => expect(args.apply).toHaveBeenCalledWith({ op: "setDucking", index: 0, rule: { ...newDuckRule("Music", "Voice"), threshold: -20 } }));
    expect(args.apply).toHaveBeenCalledTimes(1);
    // A refused edit never reaches the section, so nothing reaches the mixer.
    await c.pick("Ducking 1 trigger", "Music");
    expect(c.refusal()).toContain("a bus can't duck itself");
    expect(args.apply).toHaveBeenCalledTimes(1);
  },
};
