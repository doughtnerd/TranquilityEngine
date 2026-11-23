import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page } from "./fixtures";
import { binarySeed, installFakeFolders, nextFolder } from "./fakeFolders";

// Opening the Audio Studio (studio.html, ADR 0341) in a spec, the way a user does: a read-only sample by `?sample=`, or a
// project folder through the start screen's Open Project… (the folder picker is faked, fakeFolders.ts, so what the Studio
// writes can be read back). The Studio is checked only through its UI and the files it writes (CLAUDE.md, ADR 0330).

/** A project folder's files: path → text, or bytes (a WAV, a take, a capture). */
export type StudioFiles = Record<string, string | Uint8Array>;

/** The smallest project folder the Studio opens: a project.json and an empty mix. */
export const MINIMAL_PROJECT: StudioFiles = {
  "project.json": '{ "name": "Studio Test" }\n',
  "scenes/main.scene.json": '{ "format": "myco.scene@1", "nodes": [] }\n',
  "audio.json": '{ "format": "myco.audio@1", "buses": [{ "name": "Master", "parent": null }] }\n',
};

/** Every file of a folder on disk (a sample under `samples/`), as a project's files. */
export function filesOnDisk(dir: string, base = dir): StudioFiles {
  const out: StudioFiles = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, filesOnDisk(full, base));
    else out[full.slice(base.length + 1).replace(/\\/g, "/")] = new Uint8Array(readFileSync(full));
  }
  return out;
}

/** The header of the Studio with a project open. */
export const studioHeader = (page: Page): Locator => page.locator(".studio-header");
/** The Studio's status bar (the audio core's state, its voice count, the last message). */
export const studioStatus = (page: Page): Locator => page.locator(".studio-status");
/** The start screen (no project open). */
export const studioStart = (page: Page): Locator => page.getByRole("dialog", { name: "Start" });

/** Open the Studio on a read-only sample and wait for its header. */
export async function openStudioSample(page: Page, sample: string, hash = ""): Promise<void> {
  await page.goto(`/studio.html?sample=${sample}${hash}`);
  await expect(studioHeader(page)).toBeVisible({ timeout: 30_000 });
}

/**
 * Open the Studio on a writable project folder named `folder` holding `files`: the folder picker is faked with it, then the
 * start screen's Open Project… picks it. Waits for the header with the project's name.
 */
export async function openStudioFolder(page: Page, folder: string, files: StudioFiles): Promise<void> {
  const seed: Record<string, string> = {};
  for (const [path, v] of Object.entries(files)) seed[path] = typeof v === "string" ? v : binarySeed(v);
  await installFakeFolders(page, { [folder]: seed });
  await page.goto("/studio.html");
  await nextFolder(page, folder);
  await studioStart(page).getByRole("button", { name: "Open Project…" }).click();
  await expect(studioHeader(page)).toBeVisible({ timeout: 30_000 });
}

/** Go to a Studio screen by its header tab. */
export async function studioScreen(page: Page, title: string): Promise<void> {
  const tab = page.getByRole("navigation", { name: "Studio screens" }).getByRole("link", { name: title, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-current", "page");
}

/** Bring a dock panel to the front by its tab, or through a header's "More tabs" menu when its tab doesn't fit. */
export async function showPanel(page: Page, title: string): Promise<void> {
  const tab = page.getByRole("tab", { name: title, exact: true });
  if ((await tab.count()) > 0) return void (await tab.first().click());
  const more = page.getByRole("button", { name: "More tabs" });
  for (let i = 0; i < (await more.count()); i++) {
    await more.nth(i).click();
    const item = page.getByRole("menu", { name: "Hidden tabs" }).getByRole("menuitem", { name: title, exact: true });
    if ((await item.count()) > 0) return void (await item.click());
    await page.keyboard.press("Escape");
  }
  throw new Error(`no panel tab "${title}"`);
}

/** Start the Studio's audio (browsers start it after a gesture) and wait until the core runs (its voice count shows). */
export async function startStudioAudio(page: Page): Promise<void> {
  await page.locator(".studio-status").click();
  await expect(studioStatus(page)).toContainText(/Voices \d+/, { timeout: 30_000 });
}

/** A mono 16-bit PCM WAV of a sine: `seconds` long at `rate`. */
export function sineWav(seconds = 1, hz = 440, rate = 48_000): Uint8Array {
  const frames = Math.round(seconds * rate);
  const bytes = new Uint8Array(44 + frames * 2);
  const v = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + frames * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 0.5 * 32767), true);
  return bytes;
}

/** Collect page errors and console errors (a spec expects none). */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}
