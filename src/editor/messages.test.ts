import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOG_LIMIT, clearLog, describeError, errorStatus, installMessageLog, logMessage, logOpen, logText, messageLog, unseenErrors } from "./messages";
import { status } from "./state";

beforeEach(() => {
  clearLog();
  logOpen.value = false;
  status.value = null;
});

describe("error statuses", () => {
  it("keep the stack as the detail", () => {
    const err = new Error("disk full");
    expect(errorStatus("Couldn't save scenes/main.scene.json", err)).toEqual({ kind: "error", text: "Couldn't save scenes/main.scene.json: disk full", detail: err.stack });
    expect(errorStatus(null, "plain text")).toEqual({ kind: "error", text: "plain text" });
    expect(describeError({ code: 7 })).toEqual({ message: '{"code":7}' });
  });
});

describe("the log", () => {
  it("counts errors while it's closed, and keeps the newest entries", () => {
    logMessage("info", "hello");
    logMessage("error", "oops", "stack…");
    expect(unseenErrors.value).toBe(1);
    logOpen.value = true;
    logMessage("error", "seen");
    expect(unseenErrors.value).toBe(1);
    for (let i = 0; i < LOG_LIMIT + 5; i++) logMessage("info", `n${i}`);
    expect(messageLog.value).toHaveLength(LOG_LIMIT);
    expect(messageLog.value.at(-1)!.text).toBe(`n${LOG_LIMIT + 4}`);
  });

  it("copies as plain text with details", () => {
    logMessage("error", "oops", "at line 3");
    expect(logText()).toMatch(/\] ERROR oops\nat line 3$/);
  });
});

describe("installed", () => {
  let target: EventTarget;
  let uninstall: () => void;
  const quiet = { error: console.error, warn: console.warn };

  beforeEach(() => {
    console.error = vi.fn();
    console.warn = vi.fn();
    target = new EventTarget();
    uninstall = installMessageLog(target as unknown as Window);
  });

  afterEach(() => {
    uninstall();
    console.error = quiet.error;
    console.warn = quiet.warn;
  });

  it("logs every status message once", () => {
    status.value = { kind: "info", text: "Saved." };
    status.value = { kind: "error", text: "Nope", detail: "why" };
    expect(messageLog.value.map((e) => [e.kind, e.text, e.detail])).toEqual([
      ["info", "Saved.", undefined],
      ["error", "Nope", "why"],
    ]);
  });

  it("catches uncaught errors and rejections, with their stacks, and says so in the status bar", () => {
    const err = new Error("boom");
    const event = Object.assign(new Event("error"), { error: err, message: "boom" });
    target.dispatchEvent(event);
    const rejection = Object.assign(new Event("unhandledrejection"), { reason: new TypeError("bad thing") });
    target.dispatchEvent(rejection);
    const errors = messageLog.value.filter((e) => e.text.startsWith("Uncaught") || e.text.startsWith("Unhandled"));
    expect(errors.map((e) => e.text)).toEqual(["Uncaught error: boom", "Unhandled promise rejection: bad thing"]);
    expect(errors[0].detail).toBe(err.stack);
    expect(status.value?.text).toMatch(/Something went wrong: bad thing\. Click the status bar for details\./);
  });

  it("logs console errors and warnings, still passing them to the console", () => {
    const err = new Error("texture failed");
    console.error("[myco] failed to load texture:", err);
    console.warn("[editor] careful");
    expect(messageLog.value.map((e) => [e.kind, e.text])).toEqual([
      ["error", "[myco] failed to load texture: texture failed"],
      ["warning", "[editor] careful"],
    ]);
    expect(messageLog.value[0].detail).toBe(err.stack);
  });
});
