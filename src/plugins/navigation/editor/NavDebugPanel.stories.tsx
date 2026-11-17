// Stories (ADR 0219, 0235) for the Navigation debug panel (ADR 0065), the Worlds panel's extension: it shows nothing
// while editing, and during Play reads the session's Worlds from `editor.scene.playWorlds` (ADR 0232) and shows the
// first navigation runtime's counters, refreshed every 250 ms. The session is a real one (`startPlaying`, as the play
// bar's Play runs it), whose Engine the story steps by hand; the navigation runtime is the real WebAssembly one.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, waitFor, within } from "storybook/test";
import { editor } from "../../../editor/sdk";
import { startPlaying, stopPlaying, withEditor, type EditorStoryParameters } from "../../../editor/stories/editorStory";
import { NavDebugPanel } from "./NavDebugPanel";

/** Two agents (no navmesh to walk on; the runtime still counts them). */
const scene = {
  format: "myco.scene@4",
  nodes: ["a", "b"].map((id, i) => ({
    id,
    name: `Agent ${id}`,
    components: [
      { type: "engine.Transform", data: { position: [i * 2, 0, 0] } },
      { type: "engine.NavAgent", data: {} },
    ],
  })),
};

const meta = {
  title: "Navigation/Debug panel",
  component: NavDebugPanel,
  beforeEach: withEditor,
  parameters: { editor: { files: { "scenes/main.scene.json": scene }, scene: "scenes/main.scene.json" } satisfies EditorStoryParameters },
} satisfies Meta<typeof NavDebugPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A counter's value cell, by its row name. */
const counter = (root: HTMLElement, name: string) => [...root.querySelectorAll(".nav-counters tr")].find((r) => r.firstElementChild?.textContent === name)?.lastElementChild?.textContent ?? null;

export const EditingShowsNothing: Story = {
  play: async ({ canvasElement }) => {
    expect(editor.scene.playState).toBe("edit");
    expect(editor.scene.playWorlds).toEqual([]);
    expect(canvasElement.querySelector(".nav-debug")).toBeNull();
  },
};

export const CountersDuringPlay: Story = {
  play: async ({ canvasElement, step }) => {
    const e = await startPlaying();
    await step("Play: the panel finds the World running navigation", async () => {
      expect(editor.scene.playWorlds.map((w) => w.name)).toEqual(e.worlds().map((w) => w.name));
      for (let i = 0; i < 3; i++) e.step(1 / 60);
      const panel = await within(canvasElement).findByRole("region", { name: "Navigation" }, { timeout: 15000 });
      expect(panel.querySelector(".nav-world")).toHaveTextContent(editor.scene.playWorlds[0].name);
      await waitFor(() => expect(counter(canvasElement, "agents")).toBe("2"), { timeout: 5000 });
    });
    await step("the counters follow the runtime as it steps", async () => {
      const before = Number(counter(canvasElement, "tick"));
      for (let i = 0; i < 5; i++) e.step(1 / 60);
      await waitFor(() => expect(Number(counter(canvasElement, "tick"))).toBeGreaterThan(before), { timeout: 2000 });
    });
    await step("Stop: the session's Worlds go and so does the panel", async () => {
      stopPlaying();
      expect(editor.scene.playWorlds).toEqual([]);
      await waitFor(() => expect(canvasElement.querySelector(".nav-debug")).toBeNull());
    });
  },
};
