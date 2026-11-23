// Stories (ADR 0219; owner spec §3.12) for the shared colour picker: presets (theme tokens), the project's saved colours
// (right-click removes one), and Custom colour… with its square, hue strip, hex field, Save and Apply.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { ColourPicker } from "./ColourPicker";
import { hexToHsv, hsvToHex } from "./colourPickerModel";

const meta: Meta = { title: "Studio/ColourPicker", component: ColourPicker };
export default meta;

function Demo() {
  const [value, setValue] = useState<string | null>("var(--accent)");
  const [saved, setSaved] = useState<string[]>(["#e8907a"]);
  return (
    <div style={{ width: "260px", paddingTop: "8px" }}>
      <ColourPicker label="Marker colour" value={value} saved={saved} onChange={setValue} onSavedChange={setSaved} />
      <output aria-label="Value">{value}</output>
      <output aria-label="Palette">{saved.join(",")}</output>
    </div>
  );
}

export const PresetsAndCustom: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("button", { name: "Cyan" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(c.getByRole("button", { name: "Amber" }));
    await expect(c.getByLabelText("Value")).toHaveTextContent("var(--warning)");
    const saved = c.getByRole("button", { name: "Saved colour #e8907a" });
    await expect(saved).toHaveAttribute("title", "#e8907a · right-click to remove");
    fireEvent.contextMenu(saved);
    await waitFor(() => expect(c.getByLabelText("Palette").textContent).toBe(""));
    await userEvent.click(c.getByRole("button", { name: "Custom colour…" }));
    const picker = await within(document.body).findByRole("dialog", { name: "Custom colour" });
    const hex = within(picker).getByRole("textbox", { name: "Hex value" });
    await expect(hex).toHaveValue("#6aa8ff");
    within(picker).getByRole("slider", { name: "Hue" }).focus();
    await userEvent.keyboard("{Home}");
    await expect(hex).toHaveValue(hsvToHex({ ...hexToHsv("#6aa8ff"), h: 0 })); // Home: the hue strip's start
    await userEvent.click(within(picker).getByRole("button", { name: "Save to swatches" }));
    await waitFor(() => expect(c.getByLabelText("Palette").textContent).toMatch(/^#[0-9a-f]{6}$/));
    await userEvent.click(within(picker).getByRole("button", { name: "Apply" }));
    await expect(within(document.body).queryByRole("dialog", { name: "Custom colour" })).toBeNull();
    await expect(c.getByLabelText("Value").textContent).toBe(c.getByLabelText("Palette").textContent);
  },
};
