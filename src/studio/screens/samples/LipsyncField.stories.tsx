// Stories (ADR 0219, 0340 §7) for the Samples Inspector's Lip-sync row: none yet, importing Rhubarb Lip Sync's TSV
// output (the keys counted), a file with a bad row (imported, the skip reported), and Clear.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { defaultSampleEdits } from "../../../engine/audio/sample/format";
import type { SampleEdits } from "../../../engine/audio/sample/types";
import { LipsyncField } from "./LipsyncField";
import "./samples.css";

const meta: Meta = { title: "Studio/Samples/Lip-sync" };
export default meta;

function Demo() {
  const [e, setE] = useState<SampleEdits>(defaultSampleEdits("oneshot"));
  const [message, setMessage] = useState("");
  return (
    <div class="smp-insp" style={{ width: "320px" }}>
      <LipsyncField e={e} ro={false} commit={(r) => ("next" in r ? setE(r.next) : setMessage(r.refused))} onProblem={setMessage} />
      <output aria-label="Message">{message}</output>
    </div>
  );
}

export const ImportAndClear: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText(/None/)).toBeInTheDocument();
    const input = c.getByLabelText("Import Rhubarb lip-sync output");
    await userEvent.upload(input, new File(["0.00\tX\n0.05\tB\noops\n0.27\tE\n0.62\tX\n"], "intro_01.txt", { type: "text/plain" }));
    await waitFor(() => expect(c.getByText(/4 keys \(rhubarb\)/)).toBeInTheDocument());
    await expect(c.getByLabelText("Message")).toHaveTextContent("1 row skipped");
    await userEvent.click(c.getByRole("button", { name: "Clear" }));
    await expect(c.getByText(/None/)).toBeInTheDocument();
  },
};
