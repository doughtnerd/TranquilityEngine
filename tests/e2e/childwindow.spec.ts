import { expect, test, type Page } from "./fixtures";

// Detached panel windows' groundwork (ADR 0174, src/editor/windows/childWindow.ts): a same-origin child
// page the main window renders into, with the editor's stylesheets and theme copied in and kept in step,
// the shell's shortcuts and the menu bar's Alt key working from it, and closing with the main window.
// The `childWindows` hook (childWindowHook.ts) opens one with a probe inside, before the layout uses it.

const EDITOR = "/editor.html?sample=flappy";

type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  childWindows: { open(title: string): Promise<boolean>; last: { closed: { value: boolean }; close(): void; bounds(): { x: number; y: number; w: number; h: number } } | null; refused: string | null };
};

async function openEditor(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

async function openChild(page: Page, title = "Probe") {
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.evaluate((t) => (window as unknown as Hooks).childWindows.open(t), title).then((ok) => expect(ok).toBe(true))]);
  await popup.waitForLoadState();
  await expect(popup.locator(".child-window-probe-input")).toBeVisible();
  return popup;
}

test("a detached window copies the editor's stylesheets and theme, and keeps them in step", async ({ page }) => {
  await openEditor(page);
  const popup = await openChild(page, "Inspector");
  expect(popup.url()).toMatch(/\/panel-window\.html$/);
  await expect(popup).toHaveTitle("Inspector");

  // Every stylesheet in the main <head>, in order.
  const sheets = () => page.evaluate(() => document.head.querySelectorAll('style, link[rel~="stylesheet"]').length);
  const copies = () => popup.evaluate(() => document.head.querySelectorAll("[data-myco-copied]").length);
  expect(await sheets()).toBeGreaterThan(0);
  await expect.poll(copies).toBe(await sheets());
  // ...so the probe is styled as a panel, with the theme's tokens.
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  expect(accent).not.toBe("");
  expect(await popup.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())).toBe(accent);
  const panelBg = await page.evaluate(() => {
    const twin = Object.assign(document.createElement("div"), { className: "panel child-window-probe" });
    document.body.append(twin);
    const bg = getComputedStyle(twin).backgroundColor;
    twin.remove();
    return bg;
  });
  expect(await popup.evaluate(() => getComputedStyle(document.querySelector(".child-window-probe")!).backgroundColor)).toBe(panelBg);

  // A stylesheet added, rewritten (as Vite's HMR does) and removed follows.
  await page.evaluate(() => {
    const style = Object.assign(document.createElement("style"), { id: "probe-style", textContent: ".child-window-probe { outline: 3px solid rgb(1, 2, 3); }" });
    document.head.append(style);
  });
  const outline = () => popup.evaluate(() => getComputedStyle(document.querySelector(".child-window-probe")!).outlineColor);
  await expect.poll(outline).toBe("rgb(1, 2, 3)");
  await page.evaluate(() => (document.getElementById("probe-style")!.textContent = ".child-window-probe { outline: 3px solid rgb(4, 5, 6); }"));
  await expect.poll(outline).toBe("rgb(4, 5, 6)");
  await page.evaluate(() => document.getElementById("probe-style")!.remove());
  await expect.poll(copies).toBe(await sheets());

  // The theme and UI scale (custom properties on <html>) and data-theme follow.
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--accent", "rgb(10, 20, 30)");
    document.documentElement.style.setProperty("--ui-scale", "1.25");
    document.documentElement.dataset.theme = "light";
  });
  await expect.poll(() => popup.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())).toBe("rgb(10, 20, 30)");
  expect(await popup.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim())).toBe("1.25");
  expect(await popup.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
});

test("the shell's shortcuts and the menu bar's Alt key work from a detached window, and text fields keep their keys", async ({ page }) => {
  await openEditor(page);
  const popup = await openChild(page);
  const rotate = page.getByRole("button", { name: "Rotate", exact: true });
  const scale = page.getByRole("button", { name: "Scale", exact: true });
  await expect(rotate).toHaveAttribute("aria-pressed", "false");

  // Typing in the child's text field is typing, not the E (rotate) tool.
  const field = popup.locator(".child-window-probe-input");
  await field.click();
  await popup.keyboard.type("e");
  await expect(field).toHaveValue("e");
  await expect(rotate).toHaveAttribute("aria-pressed", "false");

  // Outside the field, E picks the rotate tool in the main window, once.
  await popup.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await popup.keyboard.press("e");
  await expect(rotate).toHaveAttribute("aria-pressed", "true");
  await popup.keyboard.press("r");
  await expect(scale).toHaveAttribute("aria-pressed", "true");

  // A bare Alt focuses the main window's menu bar.
  await popup.keyboard.press("Alt");
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains("menubar-title") ?? false)).toBe(true);
});

test("a detached window reports being closed by the user, and closes with the main window", async ({ page }) => {
  await openEditor(page);
  const first = await openChild(page);
  const bounds = await page.evaluate(() => (window as unknown as Hooks).childWindows.last!.bounds());
  expect(bounds.w).toBeGreaterThan(0);
  expect(bounds.h).toBeGreaterThan(0);
  await first.close(); // as the user would
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).childWindows.last!.closed.value)).toBe(true);

  const second = await openChild(page);
  await page.goto("about:blank"); // the editor's page goes away (pagehide)
  await expect.poll(() => second.isClosed()).toBe(true);
});
