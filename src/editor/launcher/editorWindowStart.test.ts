import { describe, expect, it } from "vitest";
import tauriConfig from "../../../src-tauri/tauri.conf.json";
import { EDITOR_WINDOW, editorWindowOptions } from "./editorWindowStart";

describe("the editor window's start (ADR 0082)", () => {
  it("is not created by Tauri at start-up: the Projects window creates it", () => {
    const windows = tauriConfig.app.windows as { label: string; create?: boolean }[];
    expect(windows.find((w) => w.label === "projects")?.create ?? true).toBe(true);
    expect(windows.find((w) => w.label === EDITOR_WINDOW)?.create).toBe(false);
  });

  it("is created from its tauri.conf.json entry, hidden, without the config-only keys", () => {
    const options = editorWindowOptions();
    expect(options).toMatchObject({ url: "editor.html", visible: false });
    expect(options).not.toHaveProperty("label");
    expect(options).not.toHaveProperty("create");
  });

  it("says so when the config has no editor window", () => {
    expect(() => editorWindowOptions([{ label: "projects" }])).toThrow(/no "main" window/);
  });
});
