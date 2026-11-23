// Stories (ADR 0219, 0349) for toasts with an Undo: a delete with Undo (10 s), a plain note, an error, and the
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
    await expect(c.getByRole("status")).toHaveTextContent("Saved mix");
    // One at a time (the prototype): the error takes the note's place.
    await userEvent.click(c.getByRole("button", { name: "Fail" }));
    await expect(c.getByText(/Couldn't move Horn.wav/)).toBeInTheDocument();
    await expect(c.queryByText("Saved mix")).toBeNull();
  },
};

/** Journeys walk 2, V15: three deletes in a row are one toast, and its Undo undoes all three. */
export const ARunMerges: StoryObj = {
  render: () => <ToastDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    for (let i = 0; i < 3; i++) await userEvent.click(c.getByRole("button", { name: "Delete" }));
    await expect(c.getByText("Deleted Engine loop · and 2 more")).toBeInTheDocument();
    await expect(c.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
    await userEvent.click(c.getByRole("button", { name: "Undo" }));
    await expect(c.getAllByRole("listitem")).toHaveLength(3);
  },
};
