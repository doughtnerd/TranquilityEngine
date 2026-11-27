// Stories (ADR 0219, 0235) for the Input dialog (ADR 0433): a project with an action set, the default context and a
// vehicle context. Each story works through what a user sees (the list, the set view's rows, the action picker) and
// checks the files written, across files where an edit reaches several, and Undo: a modifier stack with a value tried
// through it, triggers grouped by how they combine, a note, folding a card, and making and deleting files as steps
// undone from a toast.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useLayoutEffect } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { ActionSetFile } from "../../../engine/input/actionAssets";
import type { InputContextSpec } from "../../../engine";
import { fileJson, storyProject, withEditor, type EditorStoryParameters } from "../../stories/editorStory";
import { inputDialog } from "../dialogState";
import { InputDialog } from "./InputDialog";

const SET = "input/player.actions.json";
const DEFAULT = "input/default.input.json";
const VEHICLE = "input/vehicle.input.json";
const player: ActionSetFile = { id: "game.Player", actions: [{ name: "jump", type: "button" }, { name: "steer", type: "axis" }, { name: "dash", type: "button" }] };
const def: InputContextSpec = { name: "default", mappings: [{ action: "jump", control: "<Keyboard>/space" }] };
const vehicle: InputContextSpec = { name: "vehicle", mappings: [{ action: "steer", composite: "axis", negative: "<Keyboard>/a", positive: "<Keyboard>/d" }] };
const PAD = "input/pad.input.json";
const pad: InputContextSpec = { name: "pad", mappings: [{ action: "jump", control: "<Gamepad>/leftStickX", modifiers: [{ deadzone: { min: 0.2 } }, { scale: 2 }], triggers: [{ hold: { min: 0.4 } }] }] };

/** The dialog, opened on `file` as File › Input… or a double-click would. */
function Opened(props: { file: string }) {
  useLayoutEffect(() => {
    inputDialog.value = props.file;
    return () => void (inputDialog.value = null);
  }, [props.file]);
  return <InputDialog />;
}

const meta = {
  title: "Editor/Input dialog",
  component: Opened,
  beforeEach: withEditor,
  parameters: { editor: { files: { "project.json": { input: { actionSets: [SET] } }, [SET]: player, [DEFAULT]: def, [VEHICLE]: vehicle, [PAD]: pad } } satisfies EditorStoryParameters },
  args: { file: SET },
} satisfies Meta<typeof Opened>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ActionSet: Story = {
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement.ownerDocument.body);
    const dialog = within(await c.findByRole("dialog", { name: "Input" }));
    await step("the list has the set and both contexts, A to Z", async () => {
      expect(dialog.getByRole("list", { name: "Contexts" })).toHaveTextContent(/default.*vehicle/);
      expect(dialog.getByRole("list", { name: "Action sets" })).toHaveTextContent("game.Player");
    });
    await step("each action says where it's mapped; dash is mapped nowhere", async () => {
      expect(dialog.getByRole("listitem", { name: "Action steer" })).toHaveTextContent(/Mapped in\s*vehicle/);
      expect(dialog.getByRole("listitem", { name: "Action dash" })).toHaveTextContent("No context maps this action yet");
    });
    await step("Map it in default adds a mapping to the default context and shows it", async () => {
      await userEvent.click(within(dialog.getByRole("listitem", { name: "Action dash" })).getByRole("button", { name: "Map it in default" }));
      await waitFor(async () => expect((await fileJson<InputContextSpec>(DEFAULT)).mappings.at(-1)).toEqual({ action: "dash", control: "" }));
      await dialog.findByRole("region", { name: "Context default" });
    });
    await step("Undo takes it back", async () => {
      await userEvent.click(dialog.getByRole("button", { name: "Undo" }));
      await waitFor(async () => expect((await fileJson<InputContextSpec>(DEFAULT)).mappings).toHaveLength(1));
    });
  },
};

export const ChangeTypeConvertsMappings: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement.ownerDocument.body);
    const dialog = within(await c.findByRole("dialog", { name: "Input" }));
    const steer = within(dialog.getByRole("listitem", { name: "Action steer" }));
    await userEvent.selectOptions(steer.getByRole("combobox", { name: "Type" }), "vec2");
    await waitFor(async () => expect((await fileJson<ActionSetFile>(SET)).actions[1]).toEqual({ name: "steer", type: "vec2" }));
    // The vehicle's Axis became a D-pad, in the same step, and a toast says so.
    await waitFor(async () => expect((await fileJson<InputContextSpec>(VEHICLE)).mappings[0]).toEqual({ action: "steer", composite: "dpad", up: "", down: "", left: "<Keyboard>/a", right: "<Keyboard>/d" }));
    const converted = await c.findByText(/Axis to D-pad/);
    await waitFor(() => expect(converted).toBeVisible()); // the toast fades in
    await userEvent.click(await toastUndo(c, /Axis to D-pad/));
    await waitFor(async () => expect((await fileJson<InputContextSpec>(VEHICLE)).mappings[0].composite).toBe("axis"));
    expect((await fileJson<ActionSetFile>(SET)).actions[1].type).toBe("axis");
  },
};

export const PickerCreatesAction: Story = {
  args: { file: VEHICLE },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement.ownerDocument.body);
    const dialog = within(await c.findByRole("dialog", { name: "Input" }));
    const mapping = within(dialog.getByRole("listitem", { name: "Mapping 1" }));
    await userEvent.click(mapping.getByRole("button", { name: "Action" }));
    await userEvent.type(dialog.getByRole("combobox", { name: "Search actions" }), "horn");
    expect(dialog.getByRole("option", { name: "Create “horn” in game.Player" })).toBeVisible();
    await userEvent.click(dialog.getByRole("option", { name: "Create “horn” in game.Player" }));
    // The action's type comes from the mapping (Axis: an axis); the mapping names it.
    await waitFor(async () => expect((await fileJson<ActionSetFile>(SET)).actions.at(-1)).toEqual({ name: "horn", type: "axis" }));
    await waitFor(async () => expect((await fileJson<InputContextSpec>(VEHICLE)).mappings[0].action).toBe("horn"));
    const added = await c.findByText(/Added horn \(axis\)/);
    await waitFor(() => expect(added).toBeVisible()); // the toast fades in
  },
};

/** The Undo of the toast that says `text` (the dialog's header has an Undo too). */
async function toastUndo(c: ReturnType<typeof within>, text: RegExp) {
  const toast = (await c.findByText(text)).closest(".kit-toast") as HTMLElement;
  return within(toast).getByRole("button", { name: "Undo" });
}

export const ModifierStackAndTriggers: Story = {
  args: { file: PAD },
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement.ownerDocument.body);
    const dialog = within(await c.findByRole("dialog", { name: "Input" }));
    const mapping = within(dialog.getByRole("listitem", { name: "Mapping 1" }));
    const modifiers = within(mapping.getByRole("group", { name: "Modifiers" }));
    await step("a value tried through the stack shows each step's output, from the engine's modifiers", async () => {
      const tryIt = modifiers.getByRole("spinbutton", { name: "Try a value" });
      await userEvent.clear(tryIt);
      await userEvent.type(tryIt, "0.6");
      await userEvent.tab();
      await waitFor(() => expect(modifiers.getByLabelText("Dead zone gives")).toHaveTextContent("0.50"));
      expect(modifiers.getByLabelText("Scale gives")).toHaveTextContent("1.00");
      expect(modifiers.getByLabelText("The action gets")).toHaveTextContent("1.00");
    });
    await step("⋯ › Move up runs scale first; the file has the new order and the trace follows it", async () => {
      await userEvent.click(modifiers.getByRole("button", { name: "More for Scale" }));
      await userEvent.click(await c.findByRole("menuitem", { name: "Move up" }));
      await waitFor(async () => expect((await fileJson<InputContextSpec>(PAD)).mappings[0].modifiers).toEqual([{ scale: 2 }, { deadzone: { min: 0.2 } }]));
      await waitFor(() => expect(modifiers.getByLabelText("Scale gives")).toHaveTextContent("1.20"));
      expect(modifiers.getByLabelText("The action gets")).toHaveTextContent("1.00");
    });
    await step("the keyboard moves a modifier too: Space lifts, ↓ moves, Space drops", async () => {
      modifiers.getByRole("button", { name: "Reorder Scale (modifier 1)" }).focus();
      await userEvent.keyboard(" ");
      await userEvent.keyboard("{ArrowDown}");
      await userEvent.keyboard(" ");
      await waitFor(async () => expect((await fileJson<InputContextSpec>(PAD)).mappings[0].modifiers).toEqual([{ deadzone: { min: 0.2 } }, { scale: 2 }]));
    });
    const triggers = within(mapping.getByRole("group", { name: "Triggers" }));
    await step("triggers are chips grouped by how they combine; one is added straight into Blocked by", async () => {
      expect(triggers.getByRole("group", { name: "Any of these" })).toHaveTextContent("hold 0.4s");
      await userEvent.selectOptions(triggers.getByRole("combobox", { name: "Add trigger to Blocked by" }), "tap");
      await waitFor(async () => expect((await fileJson<InputContextSpec>(PAD)).mappings[0].triggers).toEqual([{ hold: { min: 0.4 } }, { tap: { max: 0.2 }, type: "blocker" }]));
      expect(triggers.getByRole("group", { name: "Blocked by" })).toHaveTextContent("tap 0.2s");
    });
    await step("a chip's settings change its group and its parameters", async () => {
      await userEvent.click(triggers.getByRole("button", { name: "hold 0.4s trigger" }));
      const settings = within(triggers.getByRole("group", { name: "Hold trigger settings" }));
      await userEvent.selectOptions(settings.getByRole("combobox", { name: "Group" }), "implicit");
      await waitFor(async () => expect((await fileJson<InputContextSpec>(PAD)).mappings[0].triggers?.[0]).toEqual({ hold: { min: 0.4 }, type: "implicit" }));
      expect(triggers.getByRole("group", { name: "All of these" })).toHaveTextContent("hold 0.4s");
      await userEvent.click(settings.getByRole("button", { name: "Remove trigger" }));
      await waitFor(async () => expect((await fileJson<InputContextSpec>(PAD)).mappings[0].triggers).toEqual([{ tap: { max: 0.2 }, type: "blocker" }]));
    });
  },
};

export const NoteAndFolding: Story = {
  args: { file: PAD },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement.ownerDocument.body);
    const dialog = within(await c.findByRole("dialog", { name: "Input" }));
    const mapping = within(dialog.getByRole("listitem", { name: "Mapping 1" }));
    await userEvent.type(mapping.getByRole("textbox", { name: "Note" }), "Stick X jumps for the accessibility layout");
    await userEvent.tab();
    await waitFor(async () => expect((await fileJson<InputContextSpec>(PAD)).mappings[0].note).toBe("Stick X jumps for the accessibility layout"));
    // Folded, the card's head says its controls in one line; unfolded, the editors are back.
    await userEvent.click(mapping.getByRole("button", { name: "Fold Mapping 1" }));
    expect(dialog.getByRole("listitem", { name: "Mapping 1" })).toHaveTextContent(/Gamepad leftStickX · 2 modifiers · 1 trigger/);
    expect(mapping.queryByRole("group", { name: "Modifiers" })).toBeNull();
    await userEvent.click(mapping.getByRole("button", { name: "Unfold Mapping 1" }));
    expect(mapping.getByRole("group", { name: "Modifiers" })).toBeVisible();
  },
};

export const DeleteUndoneFromToast: Story = {
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement.ownerDocument.body);
    const dialog = within(await c.findByRole("dialog", { name: "Input" }));
    const project = storyProject();
    await step("Delete removes the set's file and its input.actionSets entry, asking nothing", async () => {
      await userEvent.pointer({ keys: "[MouseRight]", target: within(dialog.getByRole("list", { name: "Action sets" })).getByRole("button", { name: /game\.Player/ }) });
      await userEvent.click(await c.findByRole("menuitem", { name: "Delete" }));
      await waitFor(() => expect(project.files).not.toContain(SET));
      await waitFor(async () => expect((await fileJson<{ input: { actionSets: string[] } }>("project.json")).input.actionSets).toEqual([]));
    });
    await step("the toast's Undo brings both back", async () => {
      await userEvent.click(await toastUndo(c, /Deleted input\/player\.actions\.json/));
      await waitFor(async () => expect(await fileJson<ActionSetFile>(SET)).toEqual(player));
      await waitFor(async () => expect((await fileJson<{ input: { actionSets: string[] } }>("project.json")).input.actionSets).toEqual([SET]));
    });
  },
};

export const NewContextIsAStep: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement.ownerDocument.body);
    const dialog = within(await c.findByRole("dialog", { name: "Input" }));
    const project = storyProject();
    await userEvent.click(dialog.getByRole("button", { name: "New context" }));
    const name = await dialog.findByRole("textbox", { name: "Rename New Input Context" });
    await waitFor(() => expect(project.files).toContain("input/New Input Context.input.json"));
    await userEvent.clear(name);
    await userEvent.type(name, "menu{Enter}");
    // Naming it moves the file to the name, in one step.
    await waitFor(async () => expect(await fileJson<InputContextSpec>("input/menu.input.json")).toEqual({ name: "menu", mappings: [] }));
    expect(project.files).not.toContain("input/New Input Context.input.json");
    await userEvent.click(dialog.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(project.files).toContain("input/New Input Context.input.json"));
    expect(project.files).not.toContain("input/menu.input.json");
    await userEvent.click(dialog.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(project.files).not.toContain("input/New Input Context.input.json"));
  },
};
