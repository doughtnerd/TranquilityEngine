// Stories (ADR 0219, 0349) for the Move to… dialog: moving a file (its folder disabled), moving a folder (itself and
// its subfolders disabled), and searching folders by path.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { MoveToDialog, type MovingItem } from "./MoveToDialog";

const FOLDERS = ["audio/sfx/cars", "audio/sfx/ui", "audio/music", "takes/playtests"];

function MoveDemo(props: { items: readonly MovingItem[] }) {
  const [result, setResult] = useState("open");
  return (
    <div>
      <output aria-label="Result">{result}</output>
      {result === "open" && <MoveToDialog items={props.items} folders={FOLDERS} noun="sample" rootName="Racer" onMove={(f) => setResult(`moved to ${f || "(root)"}`)} onCancel={() => setResult("cancelled")} />}
    </div>
  );
}

const meta: Meta = { title: "Kit/MoveToDialog", component: MoveToDialog };
export default meta;

export const MoveAFile: StoryObj = {
  render: () => <MoveDemo items={[{ path: "audio/sfx/horn.wav", folder: false }]} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const dialog = await c.findByRole("dialog", { name: "Move horn.wav to…" });
    await userEvent.click(within(within(dialog).getByRole("treeitem", { name: "sfx" })).getByText("sfx"));
    await expect(within(dialog).getByRole("button", { name: "Move" })).toBeDisabled();
    await userEvent.click(within(within(dialog).getByRole("treeitem", { name: "music" })).getByText("music"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    await expect(c.getByLabelText("Result")).toHaveTextContent("moved to audio/music");
  },
};

export const MoveAFolder: StoryObj = {
  render: () => <MoveDemo items={[{ path: "audio/sfx", folder: true }]} />,
};

export const Search: StoryObj = {
  render: () => <MoveDemo items={[{ path: "audio/sfx/horn.wav", folder: false }, { path: "audio/music/theme.ogg", folder: false }]} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.type(c.getByRole("searchbox", { name: "Search folders" }), "play");
    await userEvent.dblClick(c.getByRole("option", { name: "takes/playtests" }));
    await expect(c.getByLabelText("Result")).toHaveTextContent("moved to takes/playtests");
  },
};
