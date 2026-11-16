import { describe, expect, it } from "vitest";
import tauriConfig from "../../../src-tauri/tauri.conf.json";

describe("the editor window's start (ADR 0082)", () => {
  it("is not created by Tauri at start-up: the Projects window creates it", () => {
    const windows = tauriConfig.app.windows as { label: string; create?: boolean }[];
    expect(windows.find((w) => w.label === "projects")?.create ?? true).toBe(true);
    expect(windows.find((w) => w.label === "main")?.create).toBe(false);
  });
});
