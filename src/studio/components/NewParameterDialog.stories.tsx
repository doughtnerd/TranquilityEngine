// Stories (ADR 0219) for the New parameter dialog ("+ New parameter…" in a parameter select, UI pass J4.1/J5.1/J6.5):
// a number with its range, labels for a state (a Switch's parameter), and a taken name.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { ParameterDef } from "../../engine/audio/parameters";
import { NewParameterDialog } from "./NewParameterDialog";

function Demo(props: { existing?: string[]; kind?: "numeric" | "labelled"; note?: string }) {
  const [made, setMade] = useState<ParameterDef | null>(null);
  return (
    <div style={{ height: "320px" }}>
      <p data-testid="made">{made ? JSON.stringify(made) : "nothing"}</p>
      {!made && <NewParameterDialog existing={props.existing ?? []} kind={props.kind} note={props.note} onCreate={setMade} onCancel={() => {}} />}
    </div>
  );
}

const meta: Meta = { title: "Studio/NewParameterDialog", component: NewParameterDialog };
export default meta;

const body = (el: HTMLElement) => within(el.ownerDocument.body);

export const Number: StoryObj = {
  render: () => <Demo note="A global parameter: the game sets it, and any playlist, bus or snapshot can read it." />,
  play: async ({ canvasElement }) => {
    const c = body(canvasElement);
    const name = c.getByRole("textbox", { name: "Name" });
    await userEvent.clear(name);
    await userEvent.type(name, "rpm");
    await userEvent.clear(c.getByRole("spinbutton", { name: "Max" }));
    await userEvent.type(c.getByRole("spinbutton", { name: "Max" }), "8000");
    await userEvent.click(c.getByRole("button", { name: "Create" }));
    await expect(within(canvasElement).getByTestId("made")).toHaveTextContent('{"name":"rpm","min":0,"max":8000,"default":0,"seekSpeed":0}');
  },
};

/** A Switch reads labels: the kind is fixed. */
export const Labels: StoryObj = {
  render: () => <Demo kind="labelled" />,
  play: async ({ canvasElement }) => {
    const c = body(canvasElement);
    await expect(c.queryByRole("radiogroup", { name: "Kind" })).toBeNull();
    const labels = c.getByRole("textbox", { name: "Labels" });
    await userEvent.clear(labels);
    await userEvent.type(labels, "Wood, Metal, Water");
    await userEvent.click(c.getByRole("button", { name: "Create" }));
    await expect(within(canvasElement).getByTestId("made")).toHaveTextContent('"labels":["Wood","Metal","Water"],"default":"Wood"');
  },
};

export const NameTaken: StoryObj = {
  render: () => <Demo existing={["Parameter", "Parameter 2"]} />,
  play: async ({ canvasElement }) => {
    const c = body(canvasElement);
    const name = c.getByRole("textbox", { name: "Name" });
    await expect(name).toHaveValue("Parameter 3");
    await waitFor(() => expect(name).toHaveFocus());
    await userEvent.clear(name);
    await userEvent.type(name, "Parameter");
    await expect(c.getByRole("button", { name: "Create" })).toBeDisabled();
  },
};
