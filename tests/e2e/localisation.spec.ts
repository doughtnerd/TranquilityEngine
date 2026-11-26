import { readFileSync } from "node:fs";
import { expect, openEditor, play, test, type Hooks } from "./fixtures";
import { inLiveWorld } from "./liveWorld";
import { menu } from "./menus";

// Localisation in the editor (ADR 0354 §1, 0356 §4, §9): the Localisation panel adds a key and its French translation to a
// string table, and a Svelte component's text bound to the key (`t()` from "myco", ADR 0419) shows it in Play; switching the
// Play toolbar's preview language to French switches the running game's text. The text is read through the public `myco`
// API (`UIView.query`, `UIText`); what the panel wrote is read back from the project's files.

const PROJECT = JSON.stringify({
  ...JSON.parse(readFileSync("samples/flappy/project.json", "utf8")),
  autoload: [],
  languages: { list: [{ code: "en", name: "English" }, { code: "fr", name: "French" }], reference: "en", default: "en", useSystemLanguage: false, remember: false },
});

const TABLE = JSON.stringify({ format: "myco.strings@1", language: "en", strings: [] });

const GREETING_UI = `<script lang="ts">
  import { t } from "myco";
</script>

<div width="100%" height="100%" justify-content="center" align-items="center">
  <p id="hello">{t("menu.greeting")}</p>
</div>
`;

const SCENE = JSON.stringify({
  format: "myco.scene@4",
  settings: { physics: "2d" },
  nodes: [
    { id: "camera", name: "Camera", components: [{ type: "engine.Transform", data: { position: [0, 0, -10] } }, { type: "engine.Camera", data: { projection: "orthographic", orthographicSize: 10 } }] },
    { id: "menu", name: "Menu", components: [{ type: "engine.Transform", data: {} }, { type: "engine.UIView", data: { component: "asset:ui/Greeting.svelte" } }] },
  ],
});

/** The bound text's current text in the running game. */
const greeting = (page: Parameters<typeof inLiveWorld>[0]) =>
  inLiveWorld(page, null, (w, { myco, componentsOf }) => {
    if (!w) return null;
    const view = componentsOf<{ query(s: string): { node: { getComponent(t: unknown): { text: string } | null } } | null }>(w.root, myco.UIView)[0];
    return view?.query("#hello")?.node.getComponent(myco.UIText)?.text ?? null;
  });

test("the Localisation panel adds a key and a translation; the preview language switches a bound UI text in Play", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await openEditor(page, { files: { "project.json": PROJECT, "strings/menu.strings.json": TABLE, "ui/Greeting.svelte": GREETING_UI, "scenes/main.scene.json": SCENE } });

  await menu(page, "Window", "Localisation");
  const panel = page.locator(".panel").filter({ has: page.getByRole("textbox", { name: "New key" }) });
  await panel.getByRole("textbox", { name: "New key" }).fill("menu.greeting");
  await panel.getByRole("button", { name: "+ Key" }).click();
  const reference = panel.getByRole("textbox", { name: "menu.greeting reference text" });
  await reference.fill("Hello");
  await reference.press("Enter");
  const french = panel.getByRole("textbox", { name: "menu.greeting in fr" });
  await french.fill("Bonjour");
  await french.press("Enter");
  const read = (path: string) => page.evaluate((p) => (window as unknown as Hooks).testFolder.read(p), path);
  await expect.poll(async () => JSON.parse((await read("strings/menu.strings.json")) ?? "{}").strings?.[0]?.text).toBe("Hello");
  await expect.poll(async () => (await read("strings/menu.fr.strings.json")) ?? "").toContain("Bonjour");

  await play(page);
  await expect.poll(() => greeting(page), { timeout: 15_000 }).toBe("Hello");
  await page.getByRole("combobox", { name: "Preview language" }).selectOption("fr");
  await expect.poll(() => greeting(page), { timeout: 15_000 }).toBe("Bonjour");
  expect(errors).toEqual([]);
});
