// Stories (ADR 0219, 0278) for the editor's one tree view, over a small item set whose adapter keeps its rows in
// component state: the ARIA tree pattern with one tab stop, the keys (Up/Down/Home/End select, Right opens or steps
// in, Left closes or steps out, F2 renames, Delete removes), renaming in place (Enter commits, Escape cancels, leaving
// commits), the caret, and the drop indicator an adapter asks for. The Hierarchy, live Hierarchy and folder tree
// adapters are covered by their own stories and e2e specs.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { TreeView, renameRow, type TreeRow } from "./TreeView";

interface Item {
  readonly key: string;
  readonly name: string;
  readonly children: readonly Item[];
}

const ITEMS: readonly Item[] = [
  {
    key: "world",
    name: "World",
    children: [
      { key: "player", name: "Player", children: [{ key: "camera", name: "Camera", children: [] }] },
      { key: "enemy", name: "Enemy", children: [] },
    ],
  },
  { key: "ui", name: "UI", children: [{ key: "score", name: "Score", children: [] }] },
  { key: "music", name: "Music", children: [] },
];

const renamed = (items: readonly Item[], key: string, name: string): Item[] => items.map((i) => (i.key === key ? { ...i, name } : { ...i, children: renamed(i.children, key, name) }));
const without = (items: readonly Item[], key: string): Item[] => items.filter((i) => i.key !== key).map((i) => ({ ...i, children: without(i.children, key) }));

/** A tree over `ITEMS` with an adapter that keeps selection, open rows and names in state; `dropOn` marks a row as a drop target. */
function TreeDemo(props: { dropOn?: string; startClosed?: readonly string[] }) {
  const [items, setItems] = useState<readonly Item[]>(ITEMS);
  const [selected, setSelected] = useState<string | null>(null);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set(props.startClosed ?? []));
  const [log, setLog] = useState<string[]>([]);
  const note = (line: string) => setLog((l) => [...l, line]);
  const row = (item: Item): TreeRow => ({
    key: item.key,
    label: item.name,
    expandable: item.children.length > 0,
    open: !closed.has(item.key),
    children: item.children.map(row),
    selected: selected === item.key,
    attrs: { "data-item": item.key },
    drop: props.dropOn === item.key ? "into" : null,
    setOpen: (open) => {
      const next = new Set(closed);
      if (open) next.delete(item.key);
      else next.add(item.key);
      setClosed(next);
    },
    select: () => setSelected(item.key),
    menu: () => note(`menu ${item.key}`),
    activate: () => renameRow("demo", item.key),
    rename:
      item.key === "music"
        ? null // this row can't be renamed
        : {
            value: item.name,
            label: "Item name",
            commit: (value) => {
              note(`rename ${item.key} ${value}`);
              setItems((all) => renamed(all, item.key, value));
            },
          },
    remove: () => {
      note(`remove ${item.key}`);
      setItems((all) => without(all, item.key));
    },
  });
  return (
    <div style={{ width: "260px" }}>
      <TreeView tree="demo" label="Demo items" rows={items.map(row)} />
      <output aria-label="Log">{log.join("; ")}</output>
    </div>
  );
}

const meta = {
  title: "Editor/Tree view",
  component: TreeDemo,
} satisfies Meta<typeof TreeDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

const item = (root: HTMLElement, name: string) => within(root).getByRole("treeitem", { name: new RegExp(`^${name}`) });
/** The tree item a row's name belongs to (its accessible name includes its children's). */
const itemOf = (root: HTMLElement, name: string) => within(root).getByText(name, { selector: ".name" }).closest<HTMLElement>("[role=treeitem]")!;

export const AriaTree: Story = {
  play: async ({ canvasElement }) => {
    const tree = within(canvasElement).getByRole("tree", { name: "Demo items" });
    expect(tree).toBeInTheDocument();
    const world = itemOf(canvasElement, "World"), camera = itemOf(canvasElement, "Camera"), music = itemOf(canvasElement, "Music");
    expect(world).toHaveAttribute("aria-level", "1");
    expect(camera).toHaveAttribute("aria-level", "3");
    expect(world).toHaveAttribute("aria-expanded", "true");
    expect(music).not.toHaveAttribute("aria-expanded");
    expect(world).toHaveAttribute("aria-selected", "false");
    expect(world.querySelector(":scope > [role=group]")).not.toBeNull();
    // One tab stop: the first row until something is selected or focused.
    expect([...canvasElement.querySelectorAll("[role=treeitem][tabindex='0']")]).toEqual([world]);
    expect(item(canvasElement, "Player")).toHaveAttribute("tabindex", "-1");
    // A row's text is its name: the caret is drawn, not text.
    expect(world.querySelector(":scope > .row")!.textContent).toBe("World");
  },
};

export const Keyboard: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByText("World"));
    const world = itemOf(canvasElement, "World");
    expect(world).toHaveFocus();
    expect(world).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}");
    expect(itemOf(canvasElement, "Player")).toHaveFocus();
    expect(itemOf(canvasElement, "Player")).toHaveAttribute("aria-selected", "true");
    expect(itemOf(canvasElement, "Player")).toHaveAttribute("tabindex", "0");
    expect(world).toHaveAttribute("tabindex", "-1");
    // Left on an open row closes it; Left again steps out to its parent.
    await userEvent.keyboard("{ArrowLeft}");
    expect(itemOf(canvasElement, "Player")).toHaveAttribute("aria-expanded", "false");
    expect(within(canvasElement).queryByText("Camera")).toBeNull();
    await userEvent.keyboard("{ArrowLeft}");
    expect(world).toHaveFocus();
    // Right on an open row steps in; on a closed one opens it.
    await userEvent.keyboard("{ArrowRight}");
    expect(itemOf(canvasElement, "Player")).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(itemOf(canvasElement, "Player")).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{ArrowRight}");
    expect(itemOf(canvasElement, "Camera")).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(itemOf(canvasElement, "Music")).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}"); // past the end: stays
    expect(itemOf(canvasElement, "Music")).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(world).toHaveFocus();
    expect(world).toHaveAttribute("aria-selected", "true");
  },
};

export const RenameInPlace: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByText("Enemy"));
    await userEvent.keyboard("{F2}");
    const field = c.getByRole("textbox", { name: "Item name" }) as HTMLInputElement;
    expect(field).toHaveFocus();
    expect(field.value).toBe("Enemy");
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 5]);
    await userEvent.keyboard("Boss{Enter}");
    expect(c.queryByRole("textbox")).toBeNull();
    expect(c.getByText("Boss")).toBeInTheDocument();
    expect(itemOf(canvasElement, "Boss")).toHaveFocus(); // back on the row, so the keys go on
    // Escape cancels.
    await userEvent.keyboard("{F2}");
    await userEvent.keyboard("Nope{Escape}");
    expect(c.getByText("Boss")).toBeInTheDocument();
    // Leaving the field commits, once.
    await userEvent.dblClick(c.getByText("Score"));
    await userEvent.keyboard("Points");
    await userEvent.click(c.getByText("World"));
    await waitFor(() => expect(c.getByText("Points")).toBeInTheDocument());
    expect(c.getByLabelText("Log").textContent).toBe("rename enemy Boss; rename score Points");
    // A row the adapter can't rename ignores F2.
    await userEvent.click(c.getByText("Music"));
    await userEvent.keyboard("{F2}");
    expect(c.queryByRole("textbox")).toBeNull();
  },
};

export const DeleteAndCaret: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByText("Score"));
    await userEvent.keyboard("{Delete}");
    expect(c.queryByText("Score")).toBeNull();
    expect(c.getByLabelText("Log").textContent).toBe("remove score");
    // The caret opens and closes without selecting.
    const caret = itemOf(canvasElement, "World").querySelector<HTMLElement>(":scope > .row > .caret")!;
    await userEvent.click(caret);
    expect(itemOf(canvasElement, "World")).toHaveAttribute("aria-expanded", "false");
    expect(itemOf(canvasElement, "World")).toHaveAttribute("aria-selected", "false");
    await userEvent.click(caret);
    expect(c.getByText("Camera")).toBeInTheDocument();
    // A right-click goes to the adapter's menu.
    await userEvent.pointer({ keys: "[MouseRight]", target: c.getByText("Enemy") });
    expect(c.getByLabelText("Log").textContent).toBe("remove score; menu enemy");
  },
};

export const DropIndicator: Story = {
  args: { dropOn: "player", startClosed: ["ui"] },
  play: async ({ canvasElement }) => {
    const row = itemOf(canvasElement, "Player").querySelector(":scope > .row")!;
    expect(row).toHaveClass("drop-into");
    expect(row).toHaveAttribute("data-item", "player");
    expect(itemOf(canvasElement, "UI")).toHaveAttribute("aria-expanded", "false");
    expect(within(canvasElement).queryByText("Score")).toBeNull();
  },
};
