// Stories (ADR 0219, 0349) for the kit's dialog frame and info tips: a header band with the title and × close, a footer
// with a summary and Cancel before the primary, a title that keeps its case inside a dock panel; and an explanation
// that lives in an ⓘ tooltip (spec §1.3), readable by a press for touch and keyboard users.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { InfoTip } from "./InfoTip";
import { KitDialog } from "./KitDialog";
import { Section } from "./PanelFields";

const meta: Meta = { title: "Kit/KitDialog", component: KitDialog };
export default meta;

function DialogDemo() {
  const [state, setState] = useState("open");
  return (
    <div class="panel" style={{ height: "300px" }}>
      <output aria-label="State">{state}</output>
      {state === "open" && (
        <KitDialog
          title="Import samples"
          onClose={() => setState("closed")}
          summary="3 files · 12.4 MB"
          buttons={
            <>
              <button onClick={() => setState("closed")}>Cancel</button>
              <button class="primary" onClick={() => setState("imported")}>
                Import 3
              </button>
            </>
          }
        >
          <p>Into GameSFX/Footsteps.</p>
        </KitDialog>
      )}
    </div>
  );
}

export const HeaderAndFooter: StoryObj = {
  render: () => <DialogDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement.ownerDocument.body); // menus and dialogs float at the page root (FloatingPortal)
    const dialog = c.getByRole("dialog", { name: "Import samples" });
    // Inside a `.panel`, the title still isn't a caps panel caption.
    await expect(within(dialog).getByRole("heading", { name: "Import samples" })).toHaveStyle({ textTransform: "none" });
    await expect(within(dialog).getByText("3 files · 12.4 MB")).toBeVisible();
    const close = within(dialog).getByRole("button", { name: "Close" });
    await expect(close).toHaveAttribute("title", "Close (Esc)");
    await userEvent.click(close);
    await expect(c.getByLabelText("State")).toHaveTextContent("closed");
  },
};

export const InfoTips: StoryObj = {
  render: () => (
    <div style={{ width: "320px" }}>
      <Section title="Playback" hint="When a trigger plays, how often, and what happens at the voice limit.">
        <span>Max instances 4</span>
      </Section>
      <p>
        Bus effects <InfoTip text="Runs on everything routed here, before the fader." />
      </p>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement.ownerDocument.body); // menus and dialogs float at the page root (FloatingPortal)
    const tip = c.getByRole("button", { name: "About Playback" });
    await expect(tip).toHaveAttribute("title", "When a trigger plays, how often, and what happens at the voice limit.");
    await expect(c.queryByText("When a trigger plays", { selector: "p" })).toBeNull(); // no helper paragraph
    await userEvent.click(tip);
    await expect(await within(document.body).findByRole("tooltip")).toHaveTextContent("voice limit");
    await expect(c.getByText("Max instances 4")).toBeVisible(); // pressing the tip doesn't fold the section
    await userEvent.keyboard("{Escape}");
    await expect(within(document.body).queryByRole("tooltip")).toBeNull();
  },
};
