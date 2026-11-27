// Stories (ADR 0219, 0417) for the sortable list: rows reordered by their handles from the keyboard (Space lifts, arrows
// move, Space drops, Escape puts back) with the live region's announcements.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { moveItem } from "./sortableListLogic";
import { SortableList } from "./SortableList";

const meta: Meta = { title: "Kit/Sortable list", component: SortableList };
export default meta;

function Demo(props: { initial: string[] }) {
  const [items, setItems] = useState(props.initial);
  return (
    <div style={{ width: "320px" }}>
      <SortableList
        label="Action sets"
        items={items}
        itemKey={(p) => p}
        itemLabel={(p) => p}
        renderItem={(p, i) => (
          <>
            <span style={{ color: "var(--muted)" }}>{i + 1}</span>
            <span>{p}</span>
          </>
        )}
        onMove={(from, to) => setItems(moveItem(items, from, to))}
      />
    </div>
  );
}

const names = (c: ReturnType<typeof within>) => c.getAllByRole("listitem").map((li: HTMLElement) => li.textContent?.replace("⠿", "").replace(/^\d+/, ""));

export const Reorder: StoryObj = {
  render: () => <Demo initial={["input/player.actions.json", "input/ui.actions.json", "input/vehicle.actions.json"]} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const handle = (name: string) => c.getByRole("button", { name: `Reorder ${name}` });
    handle("input/player.actions.json").focus();
    await userEvent.keyboard(" ");
    await expect(c.getByRole("status")).toHaveTextContent(/lifted, position 1 of 3/);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await expect(c.getByRole("status")).toHaveTextContent("moved to position 3 of 3");
    await userEvent.keyboard(" ");
    await expect(names(c)).toEqual(["input/ui.actions.json", "input/vehicle.actions.json", "input/player.actions.json"]);
    await expect(handle("input/player.actions.json")).toHaveFocus();

    // Escape puts a lifted row back.
    await userEvent.keyboard(" {ArrowUp}{Escape}");
    await expect(names(c)).toEqual(["input/ui.actions.json", "input/vehicle.actions.json", "input/player.actions.json"]);
    await expect(c.getByRole("status")).toHaveTextContent(/Move cancelled/);
  },
};
