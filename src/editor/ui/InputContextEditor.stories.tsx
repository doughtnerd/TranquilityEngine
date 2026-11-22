// Stories (ADR 0219, 0235) for the input context editor (ADR 0336): a `*.input.json` file in the Inspector's view of
// it. Each story edits through what a user sees (the action and composite dropdowns, typed control paths, Bind, the
// Add… menus and parameter boxes) and checks the file written, the evaluator's problems under the mapping, and Undo.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { button, defineActions, vec2, type InputContextSpec } from "../../engine";
import { fileJson, withEditor, type EditorStoryParameters } from "../stories/editorStory";
import { InputContextInspector } from "./InputContextEditor";

defineActions("story.inputContext.Vehicle", { steer: vec2(), honk: button(), boost: button() });

const FILE = "input/vehicle.input.json";
const vehicle: InputContextSpec = { name: "vehicle", mappings: [{ action: "honk", control: "<Keyboard>/h" }] };

const meta = {
  title: "Editor/Input context editor",
  component: InputContextInspector,
  beforeEach: withEditor,
  parameters: { editor: { files: { [FILE]: vehicle } } satisfies EditorStoryParameters },
  args: { path: FILE },
} satisfies Meta<typeof InputContextInspector>;
export default meta;
type Story = StoryObj<typeof meta>;

const saved = () => fileJson<InputContextSpec>(FILE);

export const EditMappings: Story = {
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    const first = () => within(c.getByRole("listitem", { name: "Mapping 1" }));
    await step("the mapping's action and control show", async () => {
      expect(first().getByRole("combobox", { name: "Action" })).toHaveValue("honk");
      expect(first().getByRole("combobox", { name: "Control" })).toHaveValue("<Keyboard>/h");
    });
    await step("a control path the evaluator rejects is reported under its mapping", async () => {
      const box = first().getByRole("combobox", { name: "Control" });
      await userEvent.clear(box);
      await userEvent.type(box, "<Gamepad>/buttonNorthEast{Enter}");
      await waitFor(async () => expect((await saved()).mappings[0].control).toBe("<Gamepad>/buttonNorthEast"));
      expect(c.getByRole("list", { name: "Mapping 1 problems" })).toHaveTextContent("isn't a control path");
    });
    await step("a typed path is written in its canonical form, and the problem goes", async () => {
      const box = first().getByRole("combobox", { name: "Control" });
      await userEvent.clear(box);
      await userEvent.type(box, "<gamepad>/buttonNorth{Enter}");
      await waitFor(async () => expect((await saved()).mappings[0].control).toBe("<Gamepad>/buttonNorth"));
      expect(c.queryByRole("list", { name: "Mapping 1 problems" })).toBeNull();
    });
    await step("a second mapping as a d-pad composite with its four parts", async () => {
      await userEvent.click(c.getByRole("button", { name: "Add mapping" }));
      const second = within(await c.findByRole("listitem", { name: "Mapping 2" }));
      await userEvent.selectOptions(second.getByRole("combobox", { name: "Action" }), "steer");
      await userEvent.selectOptions(second.getByRole("combobox", { name: "Composite" }), "dpad");
      for (const [part, key] of [["Up", "w"], ["Down", "s"], ["Left", "a"], ["Right", "d"]]) {
        await userEvent.selectOptions(second.getByRole("combobox", { name: `Pick ${part.toLowerCase()}` }), `<Keyboard>/${key}`);
      }
      await waitFor(async () => expect((await saved()).mappings[1]).toEqual({ action: "steer", composite: "dpad", up: "<Keyboard>/w", down: "<Keyboard>/s", left: "<Keyboard>/a", right: "<Keyboard>/d" }));
    });
    await step("Undo takes the last edit back", async () => {
      await userEvent.click(c.getByRole("button", { name: "Undo" }));
      await waitFor(async () => expect((await saved()).mappings[1].right).toBe(""));
    });
  },
};

export const TriggersAndModifiers: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const card = within(c.getByRole("listitem", { name: "Mapping 1" }));
    await userEvent.selectOptions(card.getByRole("combobox", { name: "Add trigger" }), "hold");
    await waitFor(async () => expect((await saved()).mappings[0].triggers).toEqual([{ hold: { min: 0.4 } }]));
    const seconds = within(card.getByRole("group", { name: "Triggers" })).getByRole("spinbutton", { name: "Seconds" });
    await userEvent.clear(seconds);
    await userEvent.type(seconds, "0.8{Enter}");
    await userEvent.selectOptions(card.getByRole("combobox", { name: "Trigger type" }), "implicit");
    await waitFor(async () => expect((await saved()).mappings[0].triggers).toEqual([{ hold: { min: 0.8 }, type: "implicit" }]));
    await userEvent.selectOptions(card.getByRole("combobox", { name: "Add modifier" }), "scale");
    const x = within(card.getByRole("group", { name: "Modifiers" })).getByRole("spinbutton", { name: "x" });
    await userEvent.clear(x);
    await userEvent.type(x, "2{Enter}");
    await waitFor(async () => expect((await saved()).mappings[0].modifiers).toEqual([{ scale: { x: 2, y: 1, z: 1 } }]));
    await userEvent.selectOptions(card.getByRole("combobox", { name: "Consume" }), "false");
    await waitFor(async () => expect((await saved()).mappings[0].consume).toBe(false));
  },
};

export const PressToBind: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const card = within(c.getByRole("listitem", { name: "Mapping 1" }));
    await userEvent.click(card.getByRole("button", { name: "Bind" }));
    await waitFor(() => expect(card.getByRole("button", { name: "Cancel" })).toHaveAttribute("aria-pressed", "true"));
    await userEvent.keyboard("k");
    await waitFor(async () => expect((await saved()).mappings[0].control).toBe("<Keyboard>/k"));
    // Escape cancels and keeps the control.
    await userEvent.click(card.getByRole("button", { name: "Bind" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(card.getByRole("button", { name: "Bind" })).toBeVisible());
    expect((await saved()).mappings[0].control).toBe("<Keyboard>/k");
    // A key pressed in the same task as the click is taken too: capture starts with the click (the browser runs
    // input before timers, so a busy page would hand a press made right after the click to the page instead).
    const bind = card.getByRole("button", { name: "Bind" });
    bind.click();
    bind.dispatchEvent(new KeyboardEvent("keydown", { key: "m", bubbles: true, cancelable: true }));
    await waitFor(async () => expect((await saved()).mappings[0].control).toBe("<Keyboard>/m"));
    // Clicking Cancel with the mouse cancels; it doesn't bind the mouse button.
    await userEvent.click(card.getByRole("button", { name: "Bind" }));
    await userEvent.click(card.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(card.getByRole("button", { name: "Bind" })).toBeVisible());
    expect((await saved()).mappings[0].control).toBe("<Keyboard>/m");
  },
};

export const RenameContext: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const name = c.getByRole("textbox", { name: "Context name" });
    await userEvent.clear(name);
    await userEvent.type(name, "car{Enter}");
    await waitFor(async () => expect((await saved()).name).toBe("car"));
  },
};
