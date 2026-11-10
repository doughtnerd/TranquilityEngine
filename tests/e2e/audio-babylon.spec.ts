import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, openTestProject, type Page, play, test } from "./fixtures";

// The audio plugin's "babylon" backend (ADR 0157 BB1/BB2) in a real browser. The default `audio.backend` is the core
// (B7), so this opens the Flappy sample as a project folder with `audio.backend: "babylon"` set explicitly. Its music
// prefab plays on awake, a click is the user gesture that unlocks the context, and `Audio.debug()` (the engine module
// project scripts import as "myco", `globalThis.__myco`) reports the backend, the running context and a voice.
const FLAPPY_BABYLON = JSON.stringify({
  ...JSON.parse(readFileSync(join(process.cwd(), "samples/flappy/project.json"), "utf8")),
  audio: { backend: "babylon" },
});

test.describe.configure({ timeout: 120_000 });

type Debug = { status: string; core: Record<string, number | string | boolean>; buses: { name: string; voices: number }[] };

const audioDebug = (page: Page) =>
  page.evaluate(() => {
    const myco = (globalThis as unknown as { __myco?: { Audio: { debug(): Debug } } }).__myco;
    return myco ? myco.Audio.debug() : null;
  });

test("the babylon backend plays the sample's music after a user gesture", { tag: "@slow" }, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await openTestProject(page, { "project.json": FLAPPY_BABYLON });
  await play(page);

  // The gesture: a click inside the game view.
  await page.mouse.click(400, 200);

  await expect.poll(async () => (await audioDebug(page))?.status, { timeout: 30_000 }).toBe("running");
  const info = (await audioDebug(page))!;
  expect(info.core.backend).toBe("babylon");
  expect(info.core.context).toBe("running");
  await expect.poll(async () => Number((await audioDebug(page))?.core.voices ?? 0), { timeout: 30_000 }).toBeGreaterThan(0);
  expect((await audioDebug(page))!.buses.some((b) => b.voices > 0)).toBe(true); // the music voice counts on its bus
  expect(errors).toEqual([]);
});
