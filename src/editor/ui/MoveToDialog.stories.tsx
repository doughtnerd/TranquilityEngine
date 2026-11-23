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
    const c = within(canvasElement.ownerDocument.body); // menus and dialogs float at the page root (FloatingPortal)
    const dialog = await c.findByRole("dialog", { name: "Move “horn.wav” to" });
    const sfx = within(dialog).getByText("sfx");
    await expect(sfx.parentElement!).toHaveTextContent("here now");
    await userEvent.click(sfx); // the folder it is in: nothing happens
    await expect(within(dialog).getByRole("button", { name: "Move" })).toBeDisabled();
    await expect(within(dialog).getByRole("heading", { name: "Move “horn.wav” to" })).toHaveStyle({ textTransform: "none" });
    await userEvent.click(within(dialog).getByText("music")); // one click on an allowed folder moves
    await expect(c.getByLabelText("Result")).toHaveTextContent("moved to audio/music");
  },
};

export const CloseButton: StoryObj = {
  render: () => <MoveDemo items={[{ path: "audio/sfx/horn.wav", folder: false }]} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement.ownerDocument.body); // menus and dialogs float at the page root (FloatingPortal)
    await userEvent.click(await c.findByRole("button", { name: "Close" }));
    await expect(c.getByLabelText("Result")).toHaveTextContent("cancelled");
  },
};

export const MoveAFolder: StoryObj = {
  render: () => <MoveDemo items={[{ path: "audio/sfx", folder: true }]} />,
};

export const Search: StoryObj = {
  render: () => <MoveDemo items={[{ path: "audio/sfx/horn.wav", folder: false }, { path: "audio/music/theme.ogg", folder: false }]} />,
  play: async ({ canvasElement }) => {
    // The dialog floats at the page root (FloatingPortal).
    const d = within((await within(canvasElement.ownerDocument.body).findAllByRole("dialog", { name: /^Move / })).at(-1)!);
    await userEvent.type(d.getByRole("searchbox", { name: "Search folders" }), "play");
    await expect(d.getAllByRole("option").map((o) => o.textContent)).toEqual(["Racer", "takes/playtests"]); // the top level is always listed
    await userEvent.click(d.getByRole("option", { name: "takes/playtests" }));
    await expect(within(canvasElement).getByLabelText("Result")).toHaveTextContent("moved to takes/playtests");
  },
};
