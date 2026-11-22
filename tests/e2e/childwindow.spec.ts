import { expect, test, type Page, openEditor } from "./fixtures";
import { menu } from "./menus";

// Detached panel windows' groundwork (ADR 0174, src/editor/windows/childWindow.ts): a same-origin child
// page the main window renders into, with the editor's stylesheets and theme copied in and kept in step,
// the shell's shortcuts and the menu bar's Alt key working from it, and closing with the main window.
// Each test detaches the Inspector from its tab's menu, as a user does; panels.spec.ts covers what the
// layout does with detached windows.

const tab = (page: Page, name: string) => page.locator(".dock-tab", { has: page.locator(".dock-tab-label", { hasText: new RegExp(`^${name}$`) }) });

/** Detach the Inspector into a window of its own; resolves with the window once its panel shows. */
async function detachInspector(page: Page): Promise<Page> {
  await tab(page, "Inspector").click({ button: "right" });
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.getByRole("menu", { name: "Panel menu" }).getByRole("menuitem", { name: "Detach" }).click()]);
  await popup.waitForLoadState();
  await expect(popup.locator(".panel.inspector")).toBeVisible();
  return popup;
}

test("a detached window copies the editor's stylesheets and theme, and keeps them in step", async ({ page }) => {
  await openEditor(page, { sample: "flappy" });
  const popup = await detachInspector(page);
  expect(popup.url()).toMatch(/\/panel-window\.html$/);
  await expect.poll(() => popup.title()).toBe("Inspector · Myco Engine");

  // Every stylesheet in the main <head>, in order.
  const sheets = () => page.evaluate(() => document.head.querySelectorAll('style, link[rel~="stylesheet"]').length);
  const copies = () => popup.evaluate(() => document.head.querySelectorAll("[data-myco-copied]").length);
  expect(await sheets()).toBeGreaterThan(0);
  await expect.poll(copies).toBe(await sheets());
  // ...so the panel is styled as in the main window, with the theme's tokens.
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  expect(accent).not.toBe("");
  expect(await popup.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())).toBe(accent);
  const panelBg = await page.evaluate(() => getComputedStyle(document.querySelector(".panel")!).backgroundColor);
  expect(await popup.evaluate(() => getComputedStyle(document.querySelector(".panel.inspector")!).backgroundColor)).toBe(panelBg);

  // A stylesheet added, rewritten (as Vite's HMR does) and removed follows.
  await page.evaluate(() => {
    const style = Object.assign(document.createElement("style"), { id: "probe-style", textContent: ".panel.inspector { outline: 3px solid rgb(1, 2, 3); }" });
    document.head.append(style);
  });
  const outline = () => popup.evaluate(() => getComputedStyle(document.querySelector(".panel.inspector")!).outlineColor);
  await expect.poll(outline).toBe("rgb(1, 2, 3)");
  await page.evaluate(() => (document.getElementById("probe-style")!.textContent = ".panel.inspector { outline: 3px solid rgb(4, 5, 6); }"));
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
  await openEditor(page, { sample: "flappy" });
  const popup = await detachInspector(page);
  await page.locator(".hierarchy-view .tree .row", { hasText: "Bird" }).first().click();
  const rotate = page.getByRole("button", { name: "Rotate", exact: true });
  const scale = page.getByRole("button", { name: "Scale", exact: true });
  await expect(rotate).toHaveAttribute("aria-pressed", "false");

  // Typing in the detached Inspector's Name field is typing, not the E (rotate) tool; Escape drops it.
  const field = popup.getByRole("textbox", { name: "Name" });
  await expect(field).toHaveValue("Bird");
  await field.click();
  await popup.keyboard.press("End");
  await popup.keyboard.type("e");
  await expect(field).toHaveValue("Birde");
  await expect(rotate).toHaveAttribute("aria-pressed", "false");
  await popup.keyboard.press("Escape");
  await expect(field).toHaveValue("Bird");

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

test("a detached window remembers its size, reports being closed by the user, and closes with the main window", async ({ page }) => {
  await openEditor(page, { sample: "flappy" });
  const first = await detachInspector(page);
  // Resized, the layout saves the window's new size.
  await first.setViewportSize({ width: 520, height: 410 });
  const saved = () => page.evaluate(() => (JSON.parse(localStorage.getItem("myco.editor.layout") ?? "{}").windows ?? [])[0]?.bounds ?? null);
  await expect.poll(saved).toMatchObject({ w: 520, h: 410 });
  await first.close(); // as the user would: its panel closes with it
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("myco.editor.layout")!).windows ?? null)).toBeNull();
  await expect(tab(page, "Inspector")).toHaveCount(0);

  // Back in the main window (Window menu), detached again, and the editor's page goes away (pagehide).
  await menu(page, "Window", "Inspector");
  await expect(tab(page, "Inspector")).toHaveCount(1);
  const second = await detachInspector(page);
  await page.goto("about:blank");
  await expect.poll(() => second.isClosed()).toBe(true);
});
