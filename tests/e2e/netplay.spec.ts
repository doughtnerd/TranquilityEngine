import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

// Multiplayer play mode and the Network panel (ADR 0033 §9): a client/server project plays with
// N clients plus thin clients chosen in the panel (project.json unchanged), the panel lists each
// networked World's connections with RTT and traffic, and the latency slider applies live.
const EDITOR = "/editor.html?sample=flappy"; // relative to baseURL (E2E_PORT)

type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  playEngine?: { worlds(): { name: string }[] } | null;
  openTestProject(extra: Record<string, string>): Promise<void>;
  testFolder: { read(path: string): string | undefined };
};

/** The Flappy sample with two client Worlds linked to a headless server over loopback. */
const PROJECT = JSON.stringify({
  ...JSON.parse(readFileSync(join(process.cwd(), "samples/flappy/project.json"), "utf8")),
  bootstrap: {
    worlds: [
      { name: "P1", tags: ["client"] },
      { name: "P2", tags: ["client"] },
      { name: "Server", tags: ["server"] },
    ],
    links: [
      { from: "P1", to: "Server", transport: "loopback" },
      { from: "P2", to: "Server", transport: "loopback" },
    ],
  },
});

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

/** A client World's RTT as the panel shows it, in ms (NaN while it isn't listed). */
const shownRtt = async (panel: Locator, world: string) => parseInt((await panel.locator(`.network-world[data-world="${world}"] .network-rtt`).first().textContent()) ?? "", 10);

/** Set a range input as dragging it would. */
const slide = (slider: Locator, value: number) =>
  slider.evaluate((el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);

test("multiplayer play: 2 clients + 1 thin client, live stats, latency raises the RTT, Stop", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await page.evaluate((project) => (window as unknown as Hooks).openTestProject({ "project.json": project }), PROJECT);
  await expect(page.locator(".tree .row .name", { hasText: /^Bird$/ })).toHaveCount(1);

  // The Network panel is a tab beside Worlds; not playing, it explains itself and offers the setup.
  await page.getByRole("tab", { name: /^Network/ }).click();
  const panel = page.locator(".panel.network");
  await expect(panel.locator(".network-empty")).toContainText("Play to see");
  await panel.getByRole("checkbox", { name: "Multiplayer play" }).check();
  await panel.getByRole("combobox", { name: "Clients", exact: true }).selectOption("2");
  await panel.getByRole("combobox", { name: "Thin clients", exact: true }).selectOption("1");
  await expect(panel.locator(".network-note")).toContainText('copies the client World "P1" as Client 1–2 and Thin 1,');

  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();

  // Two rendering clients tiled; the strip lists all three clients and the server.
  const tiles = page.locator("#game-view .game-tile");
  await expect(tiles).toHaveCount(2);
  await expect(tiles.locator(".game-tile-label")).toHaveText(["Client 1", "Client 2"]);
  const strip = page.getByRole("toolbar", { name: "Worlds" });
  await expect(strip.locator(".world-name")).toHaveText(["Client 1", "Client 2", "Thin 1", "Server"]);
  await expect(strip.locator('.world-item[data-world="Thin 1"]')).toContainText("thin client");
  expect(await page.evaluate(() => (window as unknown as Hooks).playEngine!.worlds().map((w) => w.name))).toEqual(["Client 1", "Client 2", "Thin 1", "Server"]);
  // project.json is untouched.
  expect(JSON.parse((await page.evaluate(() => (window as unknown as Hooks).testFolder.read("project.json")))!).bootstrap.worlds.map((w: { name: string }) => w.name)).toEqual(["P1", "P2", "Server"]);

  // The panel lists every networked World; the server has three open connections with traffic.
  await expect(panel.locator(".network-world .network-world-name")).toHaveText(["Client 1", "Client 2", "Thin 1", "Server"]);
  const serverRows = panel.locator('.network-world[data-world="Server"] .network-peer');
  await expect(serverRows).toHaveCount(3);
  await expect(panel.locator('.network-world[data-world="Server"] .network-peer.open')).toHaveCount(3);
  await expect(panel.locator('.network-world[data-world="Client 1"] .network-peer .network-in')).toHaveText(/^(?!0 B\/s)[\d.]+ (B|KB|MB)\/s$/);
  await expect(serverRows.first().locator(".network-out")).toHaveText(/^(?!0 B\/s)[\d.]+ (B|KB|MB)\/s$/);
  // Expanding a connection shows its traffic by kind.
  await panel.getByRole("button", { name: "Show traffic by kind for Client 1 Server" }).click();
  await expect(panel.locator('.network-kinds tr[data-kind="pings"]')).toBeVisible();

  // Latency raises the round trip: 150 ms each way.
  await expect.poll(() => shownRtt(panel, "Client 1")).toBeLessThan(100);
  await slide(panel.getByRole("slider", { name: "Latency" }), 150);
  await expect(panel.locator(".network-slider-value").first()).toHaveText("150 ms");
  await expect.poll(() => shownRtt(panel, "Client 1"), { timeout: 15_000 }).toBeGreaterThan(250);
  await expect.poll(() => shownRtt(panel, "Thin 1"), { timeout: 15_000 }).toBeGreaterThan(250);

  // Stop returns to editing; the panel explains itself again, and the slider keeps its value.
  await page.getByRole("button", { name: /Stop/ }).click();
  await expect(page.getByRole("button", { name: "▶ Play" })).toBeVisible();
  await expect(tiles).toHaveCount(0);
  await expect(panel.locator(".network-empty")).toContainText("Play to see");
  await expect(panel.getByRole("slider", { name: "Latency" })).toHaveValue("150");
  expect(errors).toEqual([]);
});
