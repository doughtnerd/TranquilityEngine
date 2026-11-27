import { afterEach, describe, expect, it, vi } from "vitest";
import { activeScript, closeAllScripts, revealAt } from "./code/codeBuffers";
import { checkScriptsBeforePlay } from "./preferences";
import type { EditorProject } from "./projects";
import { checkBeforePlay, type ScriptDiagnostic } from "./scriptCheck";
import { status } from "./state";
import type { ConfirmOptions } from "./ui/ConfirmDialog";

const project = (scripts: Record<string, string> = { "scripts/A.ts": "" }) => ({ scripts: new Map(Object.entries(scripts)) }) as unknown as EditorProject;
const errors: ScriptDiagnostic[] = [
  { path: "scripts/A.ts", line: 3, column: 5, message: "Property 'speeed' does not exist on type 'A'." },
  { path: "scripts/B.ts", line: 1, column: 1, message: "Cannot find module 'left-pad'." },
];

afterEach(() => {
  checkScriptsBeforePlay.value = true;
  closeAllScripts();
  revealAt.value = null;
});

describe("type-checking scripts before Play (ADR 0125)", () => {
  it("plays straight away without errors, and doesn't ask", async () => {
    const ask = vi.fn();
    expect(await checkBeforePlay(project(), { check: async () => [], ask })).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("lists the errors and plays only on Play anyway", async () => {
    let asked: ConfirmOptions | null = null;
    const ask = async (o: ConfirmOptions) => ((asked = o), { ok: false, option: false });
    expect(await checkBeforePlay(project(), { check: async () => errors, ask })).toBe(false);
    expect(asked!.items).toEqual(["scripts/A.ts:3: Property 'speeed' does not exist on type 'A'.", "scripts/B.ts:1: Cannot find module 'left-pad'."]);
    expect(asked!.message).toMatch(/^2 errors in 2 scripts/);
    expect(asked!.confirmLabel).toBe("Play anyway");
    expect(status.value?.text).toMatch(/Didn't play: 2 type errors/);
    expect(await checkBeforePlay(project(), { check: async () => errors, ask: async () => ({ ok: true, option: false }) })).toBe(true);
  });

  it("opens a clicked error's script at its line", async () => {
    await checkBeforePlay(project(), {
      check: async () => errors,
      ask: async (o) => {
        o.onItem!(0);
        return { ok: false, option: false };
      },
    });
    expect(activeScript.value).toBe("scripts/A.ts");
    expect(revealAt.value).toEqual({ path: "scripts/A.ts", line: 3, column: 5 });
  });

  it("can be turned off from the dialog, and is skipped when off or without scripts", async () => {
    expect(await checkBeforePlay(project(), { check: async () => errors, ask: async () => ({ ok: true, option: true }) })).toBe(true);
    expect(checkScriptsBeforePlay.value).toBe(false);
    const check = vi.fn(async () => errors);
    expect(await checkBeforePlay(project(), { check })).toBe(true);
    checkScriptsBeforePlay.value = true;
    expect(await checkBeforePlay(project({}), { check })).toBe(true);
    expect(check).not.toHaveBeenCalled();
  });

  it("checks a project whose only code is Svelte UI, and stops on a component's error (ADR 0432)", async () => {
    const ui = { scripts: new Map(), files: ["ui/Hud.svelte", "scenes/main.scene.json"] } as unknown as EditorProject;
    const found: ScriptDiagnostic[] = [{ path: "ui/Hud.svelte", line: 7, column: 9, message: "Type 'string' is not assignable to type 'number'." }];
    let asked: ConfirmOptions | null = null;
    expect(await checkBeforePlay(ui, { check: async () => found, ask: async (o) => ((asked = o), { ok: false, option: false }) })).toBe(false);
    expect(asked!.items).toEqual(["ui/Hud.svelte:7: Type 'string' is not assignable to type 'number'."]);
    const check = vi.fn(async () => found);
    expect(await checkBeforePlay({ scripts: new Map(), files: ["scenes/main.scene.json"] } as unknown as EditorProject, { check })).toBe(true);
    expect(check).not.toHaveBeenCalled();
  });

  it("plays when the check itself fails", async () => {
    expect(await checkBeforePlay(project(), { check: async () => Promise.reject(new Error("worker died")) })).toBe(true);
    expect(status.value?.text).toMatch(/Couldn't type-check/);
  });
});
