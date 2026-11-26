// Stories (ADR 0219, 0417) for the shared foundations: the type scale, the spacing tokens and list row height, and
// how a choice differs from an on/off toggle. They draw the tokens from editor.css, so a theme or the UI size
// setting changes them here as it does in the apps.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { Fragment } from "preact";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";

const meta: Meta = { title: "Kit/Foundations" };
export default meta;

const SIZES = [
  { token: "--fs-xl", use: "A full empty state's title" },
  { token: "--fs-lg", use: "Inspector and dialog titles" },
  { token: "--fs-md", use: "Body: rows, fields, buttons, panel headings" },
  { token: "--fs-sm", use: "Secondary text, status bar, dock tabs" },
  { token: "--fs-xs", use: "Type badges and unit suffixes" },
];

export const TypeScale: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "var(--sp-3) var(--sp-5)", alignItems: "baseline", color: "var(--text)" }}>
      {SIZES.map((s) => (
        <Fragment key={s.token}>
          <code style={{ color: "var(--muted)", fontSize: "var(--fs-sm)" }}>{s.token}</code>
          <span style={{ fontSize: `var(${s.token})` }}>{s.use}</span>
        </Fragment>
      ))}
    </div>
  ),
};

export const SpacingAndRows: StoryObj = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)", color: "var(--text)", fontSize: "var(--fs-md)" }}>
      {["--sp-1", "--sp-2", "--sp-3", "--sp-4", "--sp-5"].map((t) => (
        <div key={t} style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
          <code style={{ width: "6em", color: "var(--muted)", fontSize: "var(--fs-sm)" }}>{t}</code>
          <span style={{ width: `var(${t})`, height: "12px", background: "var(--accent)" }} />
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
        <code style={{ width: "6em", color: "var(--muted)", fontSize: "var(--fs-sm)" }}>--row-h</code>
        <span style={{ height: "var(--row-h)", width: "160px", background: "var(--hover)", display: "flex", alignItems: "center", padding: "0 var(--sp-2)" }}>One list row</span>
      </div>
    </div>
  ),
};

function ChoiceAndToggle() {
  const [mode, setMode] = useState<"3d" | "2d">("2d");
  const [preview, setPreview] = useState(true);
  return (
    <div style={{ display: "flex", gap: "var(--sp-4)" }}>
      <div role="group" aria-label="View mode" style={{ display: "flex" }}>
        {(["3d", "2d"] as const).map((m) => (
          <button key={m} class={mode === m ? "active" : ""} aria-pressed={mode === m} onClick={() => setMode(m)}>
            {m.toUpperCase()}
          </button>
        ))}
      </div>
      <button class={`toggle${preview ? " active" : ""}`} aria-pressed={preview} onClick={() => setPreview(!preview)}>
        Preview
      </button>
    </div>
  );
}

/** The current option of a choice keeps the solid accent fill; a toggle that is on is drawn quietly. */
export const ChoiceVersusToggle: StoryObj = {
  render: () => <ChoiceAndToggle />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const toggle = c.getByRole("button", { name: "Preview" });
    const choice = c.getByRole("button", { name: "2D" });
    await expect(getComputedStyle(toggle).backgroundColor).not.toBe(getComputedStyle(choice).backgroundColor);
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  },
};
