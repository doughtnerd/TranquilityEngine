// Stories (ADR 0219, 0335) for the kit's context menu: a tree item's menu (Rename, Move to…, Duplicate, Delete) with a
// disabled item and separators; the arrows skip what can't be picked, a letter jumps, Enter runs and closes.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { ContextMenu, SEPARATOR, tidyEntries } from "./ContextMenu";

function MenuDemo() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const run = (what: string) => () => setLog((l) => [...l, what]);
  const entries = tidyEntries([
    { id: "rename", label: "Rename", hint: "F2", run: run("rename") },
    { id: "move", label: "Move to…", run: run("move") },
    { id: "dup", label: "Duplicate", disabled: true, title: "Read-only project", run: run("dup") },
    SEPARATOR,
    { id: "delete", label: "Delete", hint: "Del", danger: true, run: run("delete") },
  ]);
  return (
    <div>
      <button
        onContextMenu={(e) => {
          e.preventDefault();
          setAt({ x: e.clientX, y: e.clientY });
        }}
        onClick={(e) => setAt({ x: (e.currentTarget as HTMLElement).getBoundingClientRect().left, y: (e.currentTarget as HTMLElement).getBoundingClientRect().bottom })}
      >
        Engine loop.wav
      </button>
      {at && <ContextMenu entries={entries} at={at} label="Sample menu" onClose={() => setAt(null)} />}
      <ol aria-label="Log">
        {log.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ol>
    </div>
  );
}

const meta: Meta = { title: "Kit/ContextMenu", component: ContextMenu };
export default meta;

export const Keyboard: StoryObj = {
  render: () => <MenuDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Engine loop.wav" }));
    const menu = await c.findByRole("menu", { name: "Sample menu" });
    await expect(within(menu).getByRole("menuitem", { name: /Rename/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}"); // Move to…, then over the disabled Duplicate to Delete
    await expect(within(menu).getByRole("menuitem", { name: /Delete/ })).toHaveFocus();
    await userEvent.keyboard("m{Enter}");
    await expect(c.getByRole("list", { name: "Log" })).toHaveTextContent("move");
    await expect(c.queryByRole("menu")).toBeNull();
  },
};
