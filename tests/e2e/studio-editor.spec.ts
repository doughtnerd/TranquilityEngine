import { expect, test } from "./fixtures";
import { installFakeFolders, nextFolder } from "./fakeFolders";
import { trackErrors } from "./studio";

// The editor and the Audio Studio together (ADR 0341): the Assets panel's Open in Audio Studio opens the Studio's page on
// the project and the file. (ADR 0416 removed the editor's Record take and Record capture; the Studio records takes.)

test.describe.configure({ timeout: 150_000 });

test("Open in Audio Studio opens the Studio on the project and the file", async ({ page, context }) => {
  const errors = trackErrors(page);
  await installFakeFolders(page);
  await page.goto("/editor.html");
  // A writable copy of the Sound Lab sample.
  await nextFolder(page, "MyLab");
  await page.getByRole("dialog", { name: "Start" }).locator(".sample", { hasText: "Sound Lab" }).getByRole("button", { name: "Make a Copy…" }).click();
  const migrate = page.getByRole("alertdialog");
  const opened = page.locator(".project-name", { hasText: "sound-lab" });
  await expect(migrate.or(opened).first()).toBeVisible({ timeout: 30_000 });
  if (await migrate.isVisible()) await migrate.getByRole("button", { name: "Migrate" }).click();
  await expect(opened).toBeVisible({ timeout: 30_000 });

  // Open in Audio Studio on a sound: the Studio's page opens on the project, the Samples screen and the file.
  await page.locator(".dock-tab", { hasText: "Assets" }).click();
  const assets = page.locator(".panel.assets");
  await assets.locator(".asset-folder", { hasText: /^audio$/ }).first().click();
  await assets.locator(".asset-item", { has: page.locator(".asset-name", { hasText: /^click\.wav$/ }) }).click({ button: "right" });
  const popup = context.waitForEvent("page");
  await page.getByRole("menuitem", { name: "Open in Audio Studio" }).click();
  const studioTab = await popup;
  await studioTab.waitForLoadState();
  expect(decodeURIComponent(studioTab.url())).toMatch(/\/studio\.html\?project=\/MyLab#\/samples.*audio\/click\.wav/);
  await studioTab.close();

  // The Play toolbar no longer offers recording (ADR 0416).
  await expect(page.getByRole("button", { name: /Record take|Record capture/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});
