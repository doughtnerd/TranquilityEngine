// Stories (ADR 0219) for the parameter cards (ADR 0304): the one view of an event's own parameters and of the project's
// global ones. Each story renders the cards over a real holder (`eventParameterList`, `globalParameterList`) through a
// harness that keeps the holder as its panel does: every accepted edit is applied through `applyEdit` (ADR 0307) and
// becomes the next value; a refusal goes to the status bar, read here through a spy on `editor.messages.error`. The
// list's own rules are unit tests (parameterList.test.ts).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fireEvent, fn, spyOn, userEvent, within, type MockInstance } from "storybook/test";
import { emptyAudioEvent, type AudioEventAsset, type ParameterDef } from "../../../engine/audio/eventFormat";
import { editor, type SettingsDraft } from "../../../editor/sdk";
import { globalParameterList } from "./audioSettingsModel";
import { applyEdit } from "./editResult";
import { eventParameterList } from "./event/eventParameters";
import { ParameterCards } from "./ParameterCard";
import type { ParameterList } from "./parameterList";

interface Args {
  /** The parameters the story starts with. */
  parameters: ParameterDef[];
  /** Every accepted edit's undo label. */
  onEdit: ReturnType<typeof fn<(label: string) => void>>;
}

/** The cards over a holder the harness keeps; the latest list is published to `shown` for the play functions. */
function Harness<H>(props: { list: ParameterList<H>; initial: H; onEdit: (label: string) => void; removeTitle: string }) {
  const [holder, setHolder] = useState(props.initial);
  shown = props.list.parameters(holder);
  return (
    <div style={{ width: "320px" }}>
      <ParameterCards
        list={props.list}
        holder={holder}
        apply={(result, label) => applyEdit(result, label, (next) => { props.onEdit(label); setHolder(next); }, holder)}
        hint="the story's parameters"
        empty="None"
        removeTitle={() => props.removeTitle}
      />
    </div>
  );
}

/** The list as the harness last rendered it. */
let shown: readonly ParameterDef[] = [];
/** `editor.messages.error`, spied for each story. */
let errors: MockInstance<(text: string) => void> | null = null;

function controls(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const field = (label: string) => canvas.getByLabelText(label, { exact: true }) as HTMLInputElement | HTMLSelectElement;
  return {
    canvas,
    field,
    /** Commit text as a field does (Enter for a text field, change for a number). */
    commit: async (label: string, text: string) => {
      const f = field(label);
      if (f.type === "number") return void fireEvent.change(f, { target: { value: text } });
      await userEvent.clear(f);
      await userEvent.type(f, `${text}{Enter}`);
    },
    pick: (label: string, value: string) => userEvent.selectOptions(field(label), value),
    button: (name: string) => canvas.getByRole("button", { name }),
    refusal: () => (errors?.mock.calls.at(-1)?.[0] as string | undefined) ?? null,
  };
}

const meta = {
  title: "Audio/Parameters/Cards",
  args: { parameters: [], onEdit: fn() },
  beforeEach: () => {
    shown = [];
    errors = spyOn(editor.messages, "error") as unknown as MockInstance<(text: string) => void>;
    return () => {
      errors?.mockRestore();
      errors = null;
    };
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

const eventOf = (parameters: ParameterDef[]): AudioEventAsset => ({ ...emptyAudioEvent(), parameters });
const draftOf = (parameters: ParameterDef[]): SettingsDraft => ({ audio: { parameters } }) as SettingsDraft;

export const EventParameters: Story = {
  render: (args) => <Harness list={eventParameterList} initial={eventOf(args.parameters)} onEdit={args.onEdit} removeTitle="Remove this parameter" />,
  play: async ({ canvasElement, args, step }) => {
    const c = controls(canvasElement);
    expect(c.canvas.getByText("None")).toBeVisible();
    await step("add a numeric and a labelled parameter", async () => {
      await userEvent.click(c.button("+ Parameter"));
      await userEvent.click(c.button("+ Labelled parameter"));
      expect(shown).toEqual([
        { name: "Parameter", min: 0, max: 1, default: 0, seekSpeed: 0 },
        { name: "Parameter 2", labels: ["State 1", "State 2"], default: "State 1" },
      ]);
      expect(args.onEdit.mock.calls.map((x) => x[0])).toEqual(["Add parameter", "Add labelled parameter"]);
    });
    await step("a min above max swaps the two, as the parse does", async () => {
      await c.commit("Parameter min", "4");
      expect(shown[0]).toEqual({ name: "Parameter", min: 1, max: 4, default: 1, seekSpeed: 0 });
    });
    await step("labels and the default label", async () => {
      await c.commit("Parameter 2 labels", "Calm, Tense, Calm");
      await c.pick("Parameter 2 default", "Tense");
      expect(shown[1]).toEqual({ name: "Parameter 2", labels: ["Calm", "Tense"], default: "Tense" });
    });
    await step("a rename to a taken name is refused, says why, and saves nothing", async () => {
      const before = args.onEdit.mock.calls.length;
      await c.commit("Parameter Parameter 2 name", "Parameter");
      expect(c.refusal()).toBe('Can\'t rename parameter Parameter 2 to Parameter: another parameter is named "Parameter"');
      expect(args.onEdit.mock.calls.length).toBe(before);
      expect(shown.map((p) => p.name)).toEqual(["Parameter", "Parameter 2"]);
    });
    await step("switch kind and remove", async () => {
      await c.pick("Parameter 2 kind", "numeric");
      expect(shown[1]).toEqual({ name: "Parameter 2", min: 0, max: 1, default: 1, seekSpeed: 0 });
      await userEvent.click(c.button("Remove parameter Parameter"));
      expect(shown.map((p) => p.name)).toEqual(["Parameter 2"]);
    });
  },
};

export const GlobalParameters: Story = {
  args: { parameters: [{ name: "Intensity", min: 0, max: 1, default: 0.25, seekSpeed: 0 }, { name: "Area", labels: ["Outdoor", "Cave"], default: "Cave" }] },
  render: (args) => <Harness list={globalParameterList} initial={draftOf(args.parameters)} onEdit={args.onEdit} removeTitle="Remove this parameter and the automation that uses it" />,
  play: async ({ canvasElement, step }) => {
    const c = controls(canvasElement);
    expect(c.canvas.getByRole("group", { name: "Parameter Area" })).toHaveAttribute("data-kind", "labelled");
    expect((c.field("Intensity default") as HTMLInputElement).value).toBe("0.25");
    await step("a rename to an empty name is refused with a message", async () => {
      await c.commit("Parameter Intensity name", " ");
      expect(c.refusal()).toContain("a parameter needs a name");
      expect(shown.map((p) => p.name)).toEqual(["Intensity", "Area"]);
    });
    await step("a rename is accepted", async () => {
      await c.commit("Parameter Intensity name", "Danger");
      expect(shown.map((p) => p.name)).toEqual(["Danger", "Area"]);
    });
  },
};

const sixteen = Array.from({ length: 16 }, (_, i): ParameterDef => ({ name: `P${i + 1}`, min: 0, max: 1, default: 0, seekSpeed: 0 }));

export const EventAtTheLimit: Story = {
  args: { parameters: sixteen },
  render: (args) => <Harness list={eventParameterList} initial={eventOf(args.parameters)} onEdit={args.onEdit} removeTitle="Remove this parameter" />,
  play: async ({ canvasElement }) => {
    const c = controls(canvasElement);
    expect(c.button("+ Parameter")).toBeDisabled();
    expect(c.button("+ Labelled parameter")).toBeDisabled();
    expect(c.button("+ Parameter")).toHaveAttribute("title", "At most 16 parameters");
  },
};
