// Stories (ADR 0219, 0235) for the Input debugger panel (ADR 0336, 0337): it explains itself while editing, and during
// Play shows the session's World: its devices, player 0 with its active contexts, each action's value and phase, and
// the events it logged. The session is a real one (`startPlaying`, as Play runs it), stepped by hand, and input comes
// through `Input.inject`, the public end real adapters use.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { Input, button, defineActions, dpad, vec2 } from "../../engine";
import { editor } from "../sdk";
import { PanelStory, fileJson, startPlaying, stopPlaying, withEditor, type EditorStoryParameters } from "../stories/editorStory";

defineActions("story.inputDebugger.Player", {
  walk: vec2(dpad("<Keyboard>/w", "<Keyboard>/s", "<Keyboard>/a", "<Keyboard>/d")),
  hop: button("<Keyboard>/space"),
});

const scene = { format: "myco.scene@4", nodes: [{ id: "a", name: "Hero", components: [{ type: "engine.Transform", data: {} }] }] };

const meta = {
  title: "Editor/Input debugger",
  component: PanelStory,
  beforeEach: async (context) => {
    Input.reset();
    const cleanup = await withEditor(context);
    return async () => {
      stopPlaying();
      Input.inject.releaseAll();
      await cleanup();
    };
  },
  parameters: { editor: { files: { "scenes/main.scene.json": scene }, scene: "scenes/main.scene.json" } satisfies EditorStoryParameters },
  args: { id: "inputDebugger" },
} satisfies Meta<typeof PanelStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WhileEditing: Story = {
  play: async ({ canvasElement }) => {
    expect(editor.scene.playState).toBe("edit");
    await waitFor(() => expect(within(canvasElement).getByText(/Play to see a World's input here/)).toBeVisible(), { timeout: 10000 });
  },
};

/**
 * Record works while editing too: it records the controllers' raw input at the adapters until Stop, which saves a
 * `myco-input-recording` fixture in the project's `recordings/` folder. (The story's editor has no adapters running,
 * so the recording is empty; `src/engine/tests/inputRecording.test.ts` records and replays real adapter traffic.)
 */
export const RecordHardware: Story = {
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    await step("Record: the button becomes Stop, with the time and events so far", async () => {
      await userEvent.click(await c.findByRole("button", { name: "Record" }, { timeout: 10000 }));
      const stop = await c.findByRole("button", { name: /^Stop/ });
      expect(stop).toHaveAttribute("aria-pressed", "true");
      await waitFor(() => expect(stop).toHaveTextContent(/\d+\.\d s · 0 events/));
    });
    await step("Stop: saved in recordings/, as a version 1 recording", async () => {
      await userEvent.click(c.getByRole("button", { name: /^Stop/ }));
      const saved = await c.findByText(/^Saved recordings\/input-.*\.input-recording\.json: 0 events, \d+\.\d s\.$/);
      const path = /^Saved (\S+):/.exec(saved.textContent ?? "")![1];
      const file = await fileJson<{ format: string; version: number; events: unknown[]; hid: unknown[] }>(path);
      expect(file).toMatchObject({ format: "myco-input-recording", version: 1, events: [], hid: [] });
      expect(c.getByRole("button", { name: "Record" })).toHaveAttribute("aria-pressed", "false");
    });
  },
};

/** An action's row in a player's table. */
const actionRow = (root: HTMLElement, action: string) => root.querySelector<HTMLTableRowElement>(`tr[data-action="${action}"]`);

export const DuringPlay: Story = {
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    const e = await startPlaying();
    const frames = (n: number) => {
      for (let i = 0; i < n; i++) e.step(1 / 60);
    };
    await step("the World's devices and player 0 with the default context", async () => {
      Input.inject.keyDown("q");
      Input.inject.keyUp("q");
      frames(2);
      const devices = await c.findByRole("region", { name: "Devices" }, { timeout: 15000 });
      await waitFor(() => expect(devices.querySelector('tr[data-device="Keyboard"]')).not.toBeNull(), { timeout: 3000 });
      const player = c.getByRole("region", { name: "Player 0" });
      expect(within(player).getByRole("list", { name: "Active contexts" })).toHaveTextContent("default");
    });
    await step("holding D: walk's value, its flags and the d-pad mapping that produced it", async () => {
      Input.inject.keyDown("d");
      frames(3);
      await waitFor(() => expect(actionRow(canvasElement, "walk")).toHaveTextContent("(1.00, 0)"), { timeout: 3000 });
      const row = actionRow(canvasElement, "walk")!;
      expect(row).toHaveTextContent("held");
      expect(row).toHaveTextContent(/default #\d+ · w\/s\/a\/d \(dpad\)/);
      Input.inject.keyUp("d");
      frames(1);
    });
    await step("pressing Space is logged as a device event and hop's phases", async () => {
      Input.inject.keyDown("space");
      frames(1);
      Input.inject.keyUp("space");
      frames(1);
      const log = await c.findByRole("list", { name: "Recent events" });
      await waitFor(() => expect(log).toHaveTextContent("P0 hop performed"), { timeout: 3000 });
      expect(log).toHaveTextContent("Keyboard <Keyboard>/space 1.00");
      expect(log).toHaveTextContent("P0 hop completed");
      await userEvent.click(c.getByRole("button", { name: "Clear" }));
      await waitFor(() => expect(c.getByText("No events yet: press something.")).toBeVisible());
    });
    await step("Stop: back to the explanation", async () => {
      stopPlaying();
      await waitFor(() => expect(c.getByText(/Play to see a World's input here/)).toBeVisible());
    });
  },
};
