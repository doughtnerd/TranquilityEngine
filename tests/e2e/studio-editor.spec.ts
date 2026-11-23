import { expect, play, test } from "./fixtures";
import { installFakeFolders, listFolder, nextFolder, readFileBytes } from "./fakeFolders";
import { openStudioFolder, showPanel, startStudioAudio, studioScreen, studioStatus, trackErrors, type StudioFiles } from "./studio";

// The editor and the Audio Studio together (ADR 0341, 0348): the editor's Record take and Record capture on the Play
// toolbar save a take and a capture into the project folder; the Assets panel's Open in Audio Studio opens the Studio's
// page on the project and the file; and the Studio, on that project, opens the take on the Take screen and replays it
// (its requests drive the Studio's audio, read in the status bar's voice count) and opens the capture on the Profiler.

test.describe.configure({ timeout: 150_000 });

test("Record take and capture from Play, Open in Audio Studio, then the Studio replays the take and opens the capture", async ({ page, context }) => {
  const errors = trackErrors(page);
  await installFakeFolders(page);
  await page.goto("/editor.html");
  // A writable copy of the Sound Lab sample (its key 1 plays two one-shots).
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

  // Play, start the audio with a click in the game view, record a take and a capture for a few seconds, then stop both.
  await play(page);
  await page.mouse.click(480, 250);
  const take = page.getByRole("button", { name: /Record take/ });
  const capture = page.getByRole("button", { name: /Record capture/ });
  await expect(take).toBeEnabled({ timeout: 15_000 }); // the toolbar follows the play state a moment after Stop shows (seconds under load)
  await take.click();
  await capture.click();
  await expect(take).toHaveAttribute("aria-pressed", "true");
  // A take records what the game asks while it runs: key 1 plays the click and the beep (playOneShot) on the UI bus.
  // Pressed every quarter second, the beeps (0.25 s each) cover the take, so the replay's voices show in the Studio's
  // status bar, which reads the voice count twice a second.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("1");
    await page.waitForTimeout(250);
  }
  await take.click();
  await capture.click();
  await expect.poll(async () => (await listFolder(page, "MyLab")).filter((f) => /^takes\/.+\.mycotake$/.test(f) || /^captures\/.+\.mycap$/.test(f)).length, { timeout: 30_000 }).toBe(2);
  const files = await listFolder(page, "MyLab");
  const takePath = files.find((f) => f.startsWith("takes/") && f.endsWith(".mycotake"))!;
  const capturePath = files.find((f) => f.startsWith("captures/") && f.endsWith(".mycap"))!;
  const project: StudioFiles = {};
  for (const f of files) if (!f.startsWith(".myco/") && !f.startsWith("takes/") && !f.startsWith("captures/")) project[f] = (await readFileBytes(page, `MyLab/${f}`))!;
  const takeBytes = (await readFileBytes(page, `MyLab/${takePath}`))!;
  const captureBytes = (await readFileBytes(page, `MyLab/${capturePath}`))!;
  expect(errors).toEqual([]);

  // The Studio on the same project, in a page of its own: Open take file… copies the take in; it opens and replays.
  const studio = await context.newPage();
  const studioErrors = trackErrors(studio);
  await openStudioFolder(studio, "MyLab", project);
  await startStudioAudio(studio);
  await studioScreen(studio, "Take");
  const takeName = takePath.split("/").pop()!;
  const chooser = studio.waitForEvent("filechooser");
  await studio.getByRole("button", { name: "Open take file…" }).click();
  await (await chooser).setFiles({ name: takeName, mimeType: "application/octet-stream", buffer: Buffer.from(takeBytes) });
  await studio.getByRole("treeitem", { name: new RegExp(takeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  await showPanel(studio, "Playlists in this take");
  await expect(studio.getByRole("list", { name: "Playlists in this take" })).toContainText("click");
  await studio.getByRole("button", { name: "Replay", exact: true }).click();
  await expect(studio.getByRole("button", { name: "Pause", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(studioStatus(studio)).toContainText(/Voices [1-9]/, { timeout: 15_000 });
  // The replay's picks match the recording: no "picked X, recorded Y" anywhere.
  await expect(studio.getByText(/recorded .*picked|picked .*recorded/)).toHaveCount(0);
  await studio.getByRole("button", { name: "Pause", exact: true }).click();

  // The Profiler opens the capture.
  await studioScreen(studio, "Profiler");
  const captureName = capturePath.split("/").pop()!;
  const capChooser = studio.waitForEvent("filechooser");
  await studio.getByRole("button", { name: "Open capture file…" }).click();
  await (await capChooser).setFiles({ name: captureName, mimeType: "application/octet-stream", buffer: Buffer.from(captureBytes) });
  await studio.getByRole("treeitem", { name: new RegExp(captureName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  await expect(studio.locator(".pf-counts")).toBeVisible({ timeout: 15_000 });
  await expect(studio.getByRole("alert")).toHaveCount(0);
  expect(studioErrors).toEqual([]);
});
