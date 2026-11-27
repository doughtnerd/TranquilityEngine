// Stories (ADR 0219, 0235) for the Input dialog (ADR 0417): a project with an action set, the default context and a
// vehicle context. Each story works through what a user sees (the list, the set view's rows, the action picker) and
// checks the files written, across files where an edit reaches several, and Undo.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useLayoutEffect } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { ActionSetFile } from "../../../engine/input/actionAssets";
import type { InputContextSpec } from "../../../engine";
import { fileJson, withEditor, type EditorStoryParameters } from "../../stories/editorStory";
import { inputDialog } from "../dialogState";
import { InputDialog } from "./InputDialog";

const SET = "input/player.actions.json";
const DEFAULT = "input/default.input.json";
const VEHICLE = "input/vehicle.input.json";
const player: ActionSetFile = { id: "game.Player", actions: [{ name: "jump", type: "button" }, { name: "steer", type: "axis" }, { name: "dash", type: "button" }] };
const def: InputContextSpec = { name: "default", mappings: [{ action: "jump", control: "<Keyboard>/space" }] };
const vehicle: InputContextSpec = { name: "vehicle", mappings: [{ action: "steer", composite: "axis", negative: "<Keyboard>/a", positive: "<Keyboard>/d" }] };

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
  parameters: { editor: { files: { "project.json": { input: { actionSets: [SET] } }, [SET]: player, [DEFAULT]: def, [VEHICLE]: vehicle } } satisfies EditorStoryParameters },
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
    expect(await c.findByText(/Axis to D-pad/)).toBeVisible();
    await userEvent.click(dialog.getByRole("button", { name: "Undo" }));
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
    expect(await c.findByText(/Added horn \(axis\)/)).toBeVisible();
  },
};
