// Stories (ADR 0219, 0335) for the send row: closed with its level, open with the level row, and automated.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import type { Send } from "../../engine/audio/project/types";
import { SendRow } from "./SendRow";

function Demo(props: { open?: boolean; automated?: string }) {
  const [send, setSend] = useState<Send>({ to: "Reverb", levelDb: -12 });
  const [open, setOpen] = useState(!!props.open);
  return (
    <div style={{ width: "340px" }}>
      <SendRow send={send} open={open} automated={props.automated} onOpen={setOpen} onEdit={(r) => "next" in r && setSend(r.next)} onRemove={() => {}} onAutomate={() => {}} />
    </div>
  );
}

const meta: Meta = { title: "Studio/SendRow", component: SendRow };
export default meta;

export const Closed: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("−12.0 dB")).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: "Expand send to Reverb" }));
    const box = c.getByLabelText("Level value");
    await userEvent.clear(box);
    await userEvent.type(box, "-7.3");
    await userEvent.tab();
    await expect(box).toHaveValue("-7.5");
  },
};

export const Open: StoryObj = { render: () => <Demo open /> };

export const Automated: StoryObj = { render: () => <Demo open automated="−9.0 dB" /> };
