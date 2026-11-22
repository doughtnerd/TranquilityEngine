// Stories (ADR 0219, 0235) for the input overlay (ADR 0336, 0337): the Input debugger's Overlay toggle shows a compact
// block per player over the game view during Play. Here the overlay sits in a box standing in for the game view's
// overlay layer, under the Input debugger panel whose toggle drives it; the session is a real one (`startPlaying`),
// stepped by hand, with input through `Input.inject`.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { Input, button, defineActions, dpad, vec2 } from "../../engine";
import { inputOverlayShown } from "../inputDebugFeed";
import { PanelStory, startPlaying, stopPlaying, withEditor, type EditorStoryParameters } from "../stories/editorStory";
import { InputOverlay } from "./InputOverlay";

defineActions("story.inputOverlay.Player", {
  walk: vec2(dpad("<Keyboard>/w", "<Keyboard>/s", "<Keyboard>/a", "<Keyboard>/d")),
  hop: button("<Keyboard>/space"),
});

const scene = { format: "myco.scene@4", nodes: [{ id: "a", name: "Hero", components: [{ type: "engine.Transform", data: {} }] }] };

/** The Input debugger, and below it a stand-in for the game view with the overlay in its overlay layer. */
function OverlayStory() {
  return (
    <div>
      <PanelStory id="inputDebugger" height={180} />
      <div class="game-view-stand-in" aria-label="Game view" role="group" style={{ position: "relative", height: "260px", background: "var(--bg-sunken)", marginTop: "8px" }}>
        <div class="play-hud">
          <InputOverlay />
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: "Editor/Input overlay",
  component: OverlayStory,
  beforeEach: async (context) => {
    Input.reset();
    inputOverlayShown.value = false;
    const cleanup = await withEditor(context);
    return async () => {
      stopPlaying();
      inputOverlayShown.value = false;
      Input.inject.releaseAll();
      await cleanup();
    };
  },
  parameters: { editor: { files: { "scenes/main.scene.json": scene }, scene: "scenes/main.scene.json" } satisfies EditorStoryParameters },
} satisfies Meta<typeof OverlayStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DuringPlay: Story = {
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    const e = await startPlaying();
    const frames = (n: number) => {
      for (let i = 0; i < n; i++) e.step(1 / 60);
    };
    await step("off until the Input debugger's Overlay turns it on", async () => {
      const toggle = await c.findByRole("button", { name: "Overlay" }, { timeout: 15000 });
      expect(c.queryByRole("region", { name: "Input overlay" })).toBeNull();
      await userEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      await c.findByRole("region", { name: "Input overlay" });
    });
    await step("player 0: its contexts, walk's value bar and phases while D is held, and its recent presses", async () => {
      Input.inject.keyDown("w");
      frames(1);
      Input.inject.keyUp("w");
      frames(1);
      Input.inject.keyDown("d");
      frames(3);
      const player = await c.findByRole("region", { name: "Overlay player 0" });
      expect(within(player).getByLabelText("Contexts")).toHaveTextContent("default");
      const walk = () => player.querySelector('tr[data-action="walk"]');
      await waitFor(() => expect(walk()).toHaveTextContent("(1.00, 0)"), { timeout: 3000 });
      expect(walk()).toHaveTextContent("held");
      expect(walk()).toHaveClass("active");
      await waitFor(() => expect(within(player).getByLabelText("Recent presses")).toHaveTextContent("d · w"), { timeout: 3000 });
      Input.inject.keyUp("d");
      frames(1);
    });
    await step("the overlay's × turns it off, and the toggle follows", async () => {
      await userEvent.click(c.getByRole("button", { name: "Close input overlay" }));
      await waitFor(() => expect(c.queryByRole("region", { name: "Input overlay" })).toBeNull());
      expect(c.getByRole("button", { name: "Overlay" })).toHaveAttribute("aria-pressed", "false");
    });
  },
};
