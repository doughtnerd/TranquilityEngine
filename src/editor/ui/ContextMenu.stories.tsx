// Stories (ADR 0219, 0349) for the kit's context menu: a tree item's menu (Rename, Move to…, Duplicate, Delete) with a
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
    const c = within(canvasElement.ownerDocument.body); // menus and dialogs float at the page root (FloatingPortal)
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

/** The prototype's play-mode menu: a caps group, ✓ on the current mode, muted notes on the right, a submenu. */
function ModeMenuDemo() {
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState("whole");
  const pick = (id: string) => () => setMode(id);
  return (
    <div>
      <output aria-label="Mode">{mode}</output>
      <button onClick={() => setOpen(true)}>Play mode</button>
      {open && (
        <ContextMenu
          label="Play mode"
          at={{ x: 20, y: 40 }}
          onClose={() => setOpen(false)}
          entries={[
            { kind: "group", label: "Play mode" },
            { id: "whole", label: "Whole", checked: mode === "whole", run: pick("whole") },
            { id: "loop", label: "Pickup → loop", checked: mode === "loop", disabled: true, note: "no loops", run: pick("loop") },
            { id: "exit", label: "To next exit", checked: mode === "exit", disabled: true, note: "no exits", run: pick("exit") },
            SEPARATOR,
            { id: "more", label: "Scope", run: () => {}, submenu: [{ id: "trim", label: "Trim", hint: "T", run: pick("trim") }, { id: "sel", label: "Selection", run: pick("selection") }] },
          ]}
        />
      )}
    </div>
  );
}

export const ChecksNotesSubmenu: StoryObj = {
  render: () => <ModeMenuDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement.ownerDocument.body); // menus and dialogs float at the page root (FloatingPortal)
    const menu = await c.findByRole("menu", { name: "Play mode" });
    const whole = within(menu).getByRole("menuitemradio", { name: /Whole/ });
    await expect(whole).toHaveAttribute("aria-checked", "true");
    await expect(whole).toHaveStyle({ justifyContent: "flex-start" }); // labels left, not pushed right
    await expect(within(menu).getByRole("menuitemradio", { name: /To next exit/ })).toHaveTextContent("no exits");
    await userEvent.keyboard("{ArrowDown}");
    const scope = within(menu).getByRole("menuitem", { name: /Scope/ });
    await expect(scope).toHaveFocus(); // the disabled modes are skipped
    await userEvent.keyboard("{ArrowRight}");
    const sub = await c.findByRole("menu", { name: "Scope" });
    await expect(within(sub).getByRole("menuitem", { name: /Trim/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect(scope).toHaveFocus();
    await expect(c.queryByRole("menu", { name: "Scope" })).toBeNull();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(within(await c.findByRole("menu", { name: "Scope" })).getByRole("menuitem", { name: /Selection/ }));
    await expect(c.getByLabelText("Mode")).toHaveTextContent("selection");
    await expect(c.queryByRole("menu")).toBeNull();
  },
};
