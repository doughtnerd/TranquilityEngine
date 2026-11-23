// Stories (ADR 0219, 0376) for the debug link's accept prompt: a build from another machine asks to connect; Allow,
// Don't allow, Escape (refuses), and the note when more builds are waiting.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { AcceptPrompt } from "./AcceptPrompt";
import type { BuildEntry } from "./debugLinkLogic";

const BUILD: BuildEntry = { id: 1, name: "Racer", platform: "desktop", remote: "192.168.1.30:51234" };

function Demo(props: { more: number }) {
  const [result, setResult] = useState("asking");
  return (
    <div>
      <output aria-label="Result">{result}</output>
      {result === "asking" && <AcceptPrompt build={BUILD} more={props.more} onAccept={() => setResult("allowed")} onRefuse={() => setResult("refused")} />}
    </div>
  );
}

const meta = { title: "Editor/Debug link/Accept prompt", render: (args: { more: number }) => <Demo more={args.more} />, args: { more: 0 } } satisfies Meta<{ more: number }>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Allow: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const dialog = await c.findByRole("alertdialog", { name: "Allow Racer to connect?" });
    expect(within(dialog).getByText(/"Racer" \(desktop\) on 192\.168\.1\.30 wants to connect/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Don't allow" })).toHaveFocus(); // refusing is the default
    expect(within(dialog).queryByText(/waiting/)).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Allow" }));
    expect(c.getByLabelText("Result").textContent).toBe("allowed");
  },
};

export const DontAllow: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByRole("button", { name: "Don't allow" }));
    expect(c.getByLabelText("Result").textContent).toBe("refused");
  },
};

export const EscapeRefuses: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await c.findByRole("alertdialog");
    await userEvent.keyboard("{Escape}");
    expect(c.getByLabelText("Result").textContent).toBe("refused");
  },
};

export const MoreWaiting: Story = {
  args: { more: 2 },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(await c.findByText("2 more builds are waiting.")).toBeTruthy();
  },
};
