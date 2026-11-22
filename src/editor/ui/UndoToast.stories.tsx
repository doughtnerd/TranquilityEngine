// Stories (ADR 0219, 0335) for toasts with an Undo: a delete with Undo (10 s), a plain note, an error, and the
// Undo running once and removing its toast.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useMemo, useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { UndoToasts, createToastQueue } from "./UndoToast";

function ToastDemo() {
  const queue = useMemo(() => createToastQueue(), []);
  const [log, setLog] = useState<string[]>([]);
  return (
    <div>
      <button onClick={() => queue.show({ text: "Deleted Engine loop", undo: () => setLog((l) => [...l, "undone"]) })}>Delete</button>
      <button onClick={() => queue.show({ text: "Saved mix" })}>Save</button>
      <button onClick={() => queue.show({ text: "Couldn't move Horn.wav: the folder is read-only", kind: "error" })}>Fail</button>
      <ol aria-label="Log">
        {log.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ol>
      <UndoToasts queue={queue} />
    </div>
  );
}

const meta: Meta = { title: "Kit/UndoToast", component: UndoToasts };
export default meta;

export const UndoOnce: StoryObj = {
  render: () => <ToastDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Delete" }));
    await userEvent.click(c.getByRole("button", { name: "Undo" }));
    await expect(c.getByRole("list", { name: "Log" })).toHaveTextContent("undone");
    await waitFor(() => expect(c.queryByText("Deleted Engine loop")).toBeNull());
  },
};

export const Kinds: StoryObj = {
  render: () => <ToastDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Save" }));
    await userEvent.click(c.getByRole("button", { name: "Fail" }));
    await expect(c.getByRole("status")).toHaveTextContent("Saved mix");
  },
};
