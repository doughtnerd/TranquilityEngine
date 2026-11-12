import { expect, openTestProject, type Page, test } from "./fixtures";
import { event, segment } from "./audioMusic";
import { menu } from "./menus";
import { pickCategory } from "./projectCategory";
import { showTab } from "./tabs";

// Interactive music, the editor tools (ADR 0166/0167, M4c; api-and-models §10, task Ed11): Project Settings > Audio's Music block
// (Ed10), the segment view and panel (Ed3, Ed4), the rules table and transition audition (Ed6, Ed7) and music import (Ed9).
test.describe.configure({ timeout: 150_000 });

type Hooks = { testFolder: { read(path: string): string | undefined } };
type SavedAudio = { music?: { rings?: number }; rhythmMode?: boolean };

const panel = (page: Page) => page.locator(".panel.project");
const audio = (page: Page) => panel(page).getByRole("group", { name: "Audio settings" });
const projectText = (page: Page) => page.evaluate(() => (window as unknown as Hooks).testFolder.read("project.json")!);
const saved = async (page: Page): Promise<SavedAudio> => (JSON.parse(await projectText(page)).audio ?? {}) as SavedAudio;

async function openAudio(page: Page, extra: Record<string, string> = {}): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openTestProject(page, extra);
  await showTab(page, /^Project/);
  await pickCategory(page, "Audio");
  await expect(audio(page)).toBeVisible();
}

test("Project Settings > Audio > Music: rings and rhythm mode persist across a reload, the preset reads custom after a ring edit and returns with a preset, and each edit undoes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" || (m.type() === "warning" && /audio|music/i.test(m.text()))) errors.push(m.text()); });
  await openAudio(page);
  const rings = () => audio(page).getByLabel("Music rings", { exact: true });
  const rhythm = () => audio(page).getByLabel("Rhythm mode", { exact: true });
  const preset = () => audio(page).getByLabel("Voices preset", { exact: true });
  const undo = () => panel(page).getByRole("button", { name: "Undo" });
  await expect(audio(page).locator(".project-settings-list-head", { hasText: /^Music/ })).toBeVisible();

  // The defaults: the default preset's 12 rings, rhythm mode off.
  await expect(preset()).toHaveValue("default");
  await expect(rings()).toHaveValue("12");
  await expect(rhythm()).not.toBeChecked();

  // A ring edit: saved, the preset reads custom, one undo step with its label.
  await rings().fill("10");
  await rings().press("Enter");
  await expect.poll(async () => (await saved(page)).music?.rings).toBe(10);
  await expect(preset()).toHaveValue("custom");
  await expect(undo()).toHaveAttribute("title", /^Undo Set music rings/);

  // Rhythm mode on: saved, labelled.
  await rhythm().check();
  await expect.poll(async () => (await saved(page)).rhythmMode).toBe(true);
  await expect(undo()).toHaveAttribute("title", /^Undo Enable rhythm mode/);

  // A reload on the saved file shows both, and the preset still reads custom.
  await openAudio(page, { "project.json": await projectText(page) });
  await expect(rings()).toHaveValue("10");
  await expect(rhythm()).toBeChecked();
  await expect(preset()).toHaveValue("custom");

  // A preset puts its rings back (high: 16) and a reload keeps them, the preset named again.
  await preset().selectOption("high");
  await expect.poll(async () => (await saved(page)).music?.rings).toBe(16);
  await expect(preset()).toHaveValue("high");
  await expect(rings()).toHaveValue("16");
  await openAudio(page, { "project.json": await projectText(page) });
  await expect(preset()).toHaveValue("high");
  await expect(rings()).toHaveValue("16");
  expect((await saved(page)).rhythmMode).toBe(true); // a preset leaves rhythm mode alone

  // The range: past the top clamps to 16 (typing 99 over a saved 16 changes nothing, so the box keeps its text: the same for every number in this form), 0 is allowed.
  await rings().fill("14");
  await rings().press("Enter");
  await expect.poll(async () => (await saved(page)).music?.rings).toBe(14);
  await rings().fill("99");
  await rings().press("Enter");
  await expect.poll(async () => (await saved(page)).music?.rings).toBe(16);
  await expect(rings()).toHaveValue("16");
  await rings().fill("0");
  await rings().press("Enter");
  await expect.poll(async () => (await saved(page)).music?.rings).toBe(0);
  await expect(preset()).toHaveValue("custom");

  // Undo: rings 0 back to 16 (the preset reads high again).
  await undo().click();
  await expect.poll(async () => (await saved(page)).music?.rings).toBe(16);
  await expect(rings()).toHaveValue("16");
  await expect(preset()).toHaveValue("high");

  // Disable rhythm mode and undo it: the label names the step, the file follows.
  await rhythm().uncheck();
  await expect.poll(async () => (await saved(page)).rhythmMode).toBe(false);
  await expect(undo()).toHaveAttribute("title", /^Undo Disable rhythm mode/);
  await undo().click();
  await expect.poll(async () => (await saved(page)).rhythmMode).toBe(true);
  await expect(rhythm()).toBeChecked();
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// The music editors, on a writable copy of the Flappy sample with one music switch (A and B, both over the sample's foo.mp3,
// one rule A to B) added to the project. The event file on disk is read back after each edit: it is what the panels wrote.

const SONG = "music/song.audioevent.json";
const RULE_AB = { from: "A", to: "B", exit: "bar", enter: "entryCue", fadeOut: { beats: 1, curve: "equalPower" }, fadeIn: { beats: 1, curve: "equalPower" } };
const songEvent = () =>
  event(
    {
      type: "musicSwitch",
      id: "world",
      parameter: "State",
      default: "A",
      children: [
        { ...segment("A", [{ name: "foo", clip: "music/foo.mp3", volume: 0.3 }], true), value: "A" },
        { ...segment("B", [{ name: "foo", clip: "music/foo.mp3", volume: 0.3 }], true), value: "B" },
      ],
      transitions: [RULE_AB],
    },
    { bus: "Music", parameters: [{ name: "State", labels: ["A", "B"], default: "A" }] },
  );

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const readSong = async (page: Page): Promise<Json> => JSON.parse(await page.evaluate((p) => (window as unknown as Hooks).testFolder.read(p) ?? "null", SONG));

/** Segment A's first tempo marker; the writer omits a default grid, so the defaults fill in. */
const tempoA = async (page: Page) => ({ bpm: 120, beatsPerBar: 4, beatUnit: 4, ...((await readSong(page)).root.children[0].tempo?.[0] ?? {}) }) as { bpm: number; beatsPerBar: number; beatUnit: number };

const watch = (page: Page): string[] => {
  const seen: string[] = [];
  page.on("pageerror", (e) => seen.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" || (m.type() === "warning" && /audio|music|stream|stem|segment|rule/i.test(m.text()) && !/shader|Emitter/i.test(m.text()))) seen.push(m.text());
  });
  return seen;
};

/** Open the project with the song event, open it in the Event editor and select the node at `node` ("" is the root). */
async function openSong(page: Page, node: string, extra: Record<string, string> = {}): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openTestProject(page, { [SONG]: JSON.stringify(songEvent()), ...extra });
  const assets = page.locator(".panel.assets");
  await page.locator(".dock-tab", { hasText: "Assets" }).click();
  await assets.locator(".asset-folder", { hasText: /^music$/ }).click();
  await assets.locator(".asset-item", { has: page.locator(".asset-name", { hasText: "song.audioevent.json" }) }).dblclick();
  await expect(page.getByTestId("event-editor")).toHaveAttribute("data-asset-document", SONG);
  await page.locator(`[data-testid="event-tree-row"][data-event-path="${node}"]`).click();
}

const field = (page: Page, label: string) => page.getByRole("textbox", { name: label, exact: true });

async function commitText(page: Page, label: string, value: string): Promise<void> {
  await field(page, label).fill(value);
  await field(page, label).press("Enter");
}

test("segment view: a tempo, metre and grid-offset edit in the segment panel is written to the event, shown by the view, and undone and redone", async ({ page }) => {
  const problems = watch(page);
  await openSong(page, "0");
  await page.getByTestId("open-segment-view").click();
  const readout = async () => {
    const box = (await page.locator(".segment-canvas").boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.6, box.y + 40);
    await page.mouse.move(box.x + box.width * 0.6 + 1, box.y + 40);
    await expect(page.locator(".segment-readout")).toContainText(" s");
    return ((await page.locator(".segment-readout").textContent()) ?? "").trim().split(/\s+/)[0];
  };
  const before = await readout();
  await showTab(page, /^Segment Properties/); // "Open segment view" shows the properties panel beside the view
  await expect(page.getByRole("region", { name: "Tempo" })).toBeVisible();
  await expect(field(page, "Tempo")).toHaveValue("120");
  expect((await readSong(page)).root.children[0].tempo).toEqual([{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }]);

  // Tempo 100: the file holds it, the segment B beside it is untouched.
  await commitText(page, "Tempo", "100");
  await expect.poll(async () => (await tempoA(page)).bpm).toBe(100);
  // Metre 3/8 and a grid offset.
  await commitText(page, "Beats per bar", "3");
  await page.getByRole("combobox", { name: "Beat unit", exact: true }).selectOption("8");
  await commitText(page, "Grid offset", "0.25");
  await expect.poll(async () => (await readSong(page)).root.children[0].gridOffset).toBe(0.25);
  const a = (await readSong(page)).root.children[0];
  expect(a.tempo).toEqual([{ at: "1:1:0", bpm: 100, beatsPerBar: 3, beatUnit: 8 }]);
  expect((await readSong(page)).root.children[1].tempo).toBeUndefined(); // B keeps the default grid (the writer omits it)

  // The view follows the panel: the same spot of the ruler now reads another bar:beat:tick (the grid moved).
  await showTab(page, /^Segment$/);
  await expect.poll(readout).not.toBe(before);
  await showTab(page, /^Segment Properties/);

  // A refused value says why and writes nothing.
  await commitText(page, "Tempo", "5000");
  await expect(page.getByRole("alert")).toHaveText("tempo must be 1..1000 bpm");
  expect((await tempoA(page)).bpm).toBe(100);

  // Undo, one step per edit, the file following; redo brings the tempo back.
  const undo = async () => { await menu(page, "Edit", /^Undo/); };
  await undo();
  await expect.poll(async () => (await readSong(page)).root.children[0].gridOffset ?? 0).toBe(0);
  await undo();
  await expect.poll(async () => (await tempoA(page)).beatUnit).toBe(4);
  await undo();
  await expect.poll(async () => (await tempoA(page)).beatsPerBar).toBe(4);
  await undo();
  await expect.poll(async () => (await tempoA(page)).bpm).toBe(120);
  await menu(page, "Edit", /^Redo/);
  await expect.poll(async () => (await tempoA(page)).bpm).toBe(100);
  // Ctrl+Z with the segment view focused reaches the same document.
  await showTab(page, /^Segment$/);
  await page.locator(".segment-toolbar").click({ position: { x: 2, y: 2 } });
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await tempoA(page)).bpm).toBe(120);
  expect(problems).toEqual([]);
});

type MusicRow = { asset: string; state: string; segment: string | null; pending: { to: string; rule: number; tier: number; exit: string; enter: string; ruleKey: string } | null };
type Sample = { segment: string | null; state: string; pending: MusicRow["pending"] };

/** Samples the event's music row every 25 ms into `window.__rows`, so a short-lived pending change can't be missed between polls. */
const record = (page: Page) =>
  page.evaluate((asset) => {
    const g = globalThis as unknown as { __myco: { Audio: { debug(): { music?: MusicRow[] } } }; __rows: Sample[] };
    g.__rows = [];
    setInterval(() => {
      const row = g.__myco.Audio.debug().music?.find((r) => r.asset === asset);
      if (row) g.__rows.push({ segment: row.segment, state: row.state, pending: row.pending });
    }, 25);
  }, SONG);
const rows = (page: Page) => page.evaluate(() => (globalThis as unknown as { __rows: Sample[] }).__rows);

test("rules table: a rule added and edited is written to the event, and auditioning it plays the transition through that rule", async ({ page }) => {
  const problems = watch(page);
  await openSong(page, "");
  await page.getByTestId("open-rules-table").click();
  const grid = page.getByRole("grid", { name: "Transition rules, from by to" });
  const cell = (from: string, to: string) => grid.locator(`td[data-from="${from}"][data-to="${to}"]`);
  await expect(page.getByRole("heading", { name: "world: transitions" })).toBeVisible();

  // The authored rule wins A to B (tier and number shown); B to A has none, so it is the default.
  await expect(cell("A", "B")).toHaveText("#0");
  await expect(cell("B", "A")).toHaveText("default");
  await cell("B", "A").click();
  await expect(page.locator(".rt-why")).toContainText("B to A");

  // Add rule: made for the chosen pair, written to the file, now winning that cell; one undo step.
  await page.getByRole("button", { name: "Add rule", exact: true }).click();
  await expect.poll(async () => (await readSong(page)).root.transitions.length).toBe(2);
  expect((await readSong(page)).root.transitions[1]).toMatchObject({ from: "B", to: "A" });
  await expect(cell("B", "A")).toHaveText("#1");
  await expect(page.getByRole("region", { name: "Rule 1" })).toBeVisible();

  // Edit it: exit every 2 bars, enter at the same musical time.
  const editor = page.getByRole("region", { name: "Rule 1" });
  await editor.getByRole("textbox", { name: "Exit every", exact: true }).fill("2");
  await editor.getByRole("textbox", { name: "Exit every", exact: true }).press("Enter");
  await editor.getByRole("combobox", { name: "Enter", exact: true }).selectOption("sameTime");
  await expect.poll(async () => (await readSong(page)).root.transitions[1].enter).toBe("sameTime");

  // Audition rule 1: B is started and the switch asked for A.
  // "Audition from bar" stays blank: the default start, bar 1.
  await record(page);
  await editor.getByRole("button", { name: "Audition this transition" }).click();
  await expect(editor.locator(".re-hint")).toContainText("Starts in B, then sets State to “A”. Playing from the start.");
  await expect.poll(async () => (await rows(page)).some((r) => r.segment === "B"), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await rows(page)).some((r) => r.pending?.to === "A"), { timeout: 30_000 }).toBe(true);
  const pend = (await rows(page)).find((r) => r.pending?.to === "A")!.pending!;
  expect(pend).toMatchObject({ to: "A", rule: 1, ruleKey: "B>A", tier: 1, parent: "world", exit: "2 bars", enter: "sameTime" }); // the edited rule, as written

  await expect.poll(async () => (await rows(page)).some((r) => r.segment === "A" && r.pending === null), { timeout: 30_000 }).toBe(true);

  // Audition the authored rule 0 (A to B) too: a second run, another pending change, naming rule 0 with its own settings.
  await page.getByRole("listitem").filter({ hasText: "#0" }).first().click();
  const first = page.getByRole("region", { name: "Rule 0" });
  await record(page);
  await first.getByRole("button", { name: "Audition this transition" }).click();
  await expect(first.locator(".re-hint")).toContainText("Starts in A, then sets State to “B”");
  await expect.poll(async () => (await rows(page)).find((r) => r.pending?.to === "B")?.pending, { timeout: 30_000 }).toMatchObject({ to: "B", rule: 0, ruleKey: "A>B", exit: "bar", enter: "entryCue" });
  await expect.poll(async () => (await rows(page)).some((r) => r.segment === "B" && r.pending === null), { timeout: 30_000 }).toBe(true);

  // Undo, with the Rules panel focused: the enter edit, the exit edit and the add each go in one step; the grid shows B to A
  // back at the default rule.
  const undoInEditor = async () => {
    await page.getByRole("heading", { name: "world: transitions" }).click();
    await page.keyboard.press("Control+z");
  };
  await undoInEditor();
  await expect.poll(async () => (await readSong(page)).root.transitions[1].enter).toBeUndefined();
  await undoInEditor();
  await expect.poll(async () => (await readSong(page)).root.transitions[1].exit).toBeUndefined();
  await undoInEditor();
  await expect.poll(async () => (await readSong(page)).root.transitions.length).toBe(1);
  await expect(cell("B", "A")).toHaveText("default");
  expect(problems).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Music import (Ed9 through Ed4's stem list): a WAV with an ACID tempo, a labelled cue and a loop chunk dropped on the Assets
// panel from the OS, then dragged onto a segment's stem list.

const EMPTY_SEGMENT_EVENT = () =>
  event({ type: "musicSwitch", id: "world", parameter: "State", default: "C", children: [{ type: "segment", id: "C", value: "C" }] }, { bus: "Music", parameters: [{ name: "State", labels: ["C"], default: "C" }] });

/** Drop a generated 6 s mono WAV named `riff.wav` on the Assets panel as the OS would: 90 bpm 4/4 `acid`, a cue "verse" at 2 s (beat 4), one forward loop over the whole file. */
async function dropRiff(page: Page): Promise<void> {
  await page.evaluate(() => {
    const rate = 24_000, frames = rate * 6;
    const u16 = (n: number) => [n & 255, (n >> 8) & 255];
    const u32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
    const f32 = (n: number) => [...new Uint8Array(new Float32Array([n]).buffer)];
    const ascii = (t: string) => [...t].map((c) => c.charCodeAt(0));
    const chunk = (id: string, body: number[] | Uint8Array) => [...ascii(id), ...u32(body.length), ...body, ...(body.length % 2 ? [0] : [])];
    const pcm = new Uint8Array(frames * 2);
    const dv = new DataView(pcm.buffer);
    for (let i = 0; i < frames; i++) dv.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 0.2 * 32767), true);
    const parts = [
      ...ascii("WAVE"),
      ...chunk("fmt ", [...u16(1), ...u16(1), ...u32(rate), ...u32(rate * 2), ...u16(2), ...u16(16)]),
      ...chunk("data", pcm),
      ...chunk("acid", [...u32(0x10), ...u16(60), ...u16(0), ...f32(0), ...u32(8), ...u16(4), ...u16(4), ...f32(90)]),
      ...chunk("cue ", [...u32(1), ...u32(1), ...u32(0), ...ascii("data"), ...u32(0), ...u32(0), ...u32(rate * 2)]),
      ...chunk("LIST", [...ascii("adtl"), ...chunk("labl", [...u32(1), ...ascii("verse"), 0])]),
      ...chunk("smpl", [...u32(0), ...u32(0), ...u32(41667), ...u32(60), ...u32(0), ...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(frames - 1), ...u32(0), ...u32(0)]),
    ];
    const bytes = new Uint8Array([...ascii("RIFF"), ...u32(parts.length), ...parts]);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "riff.wav", { type: "audio/wav" }));
    const target = document.querySelector(".panel.assets .asset-items")!;
    const fire = (type: string) => target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    fire("dragenter");
    fire("dragover");
    fire("drop");
  });
}

test("music import: a clip dropped on the Assets panel and onto a segment's stem list becomes a stem, and its tempo, cue and loop hints are written once, in one undo step", async ({ page }) => {
  const problems = watch(page);
  await openSong(page, "0", { [SONG]: JSON.stringify(EMPTY_SEGMENT_EVENT()) });
  const assets = page.locator(".panel.assets");
  const tile = assets.locator(".asset-item", { has: page.locator(".asset-name", { hasText: "riff.wav" }) });
  await expect(tile).toHaveCount(0);
  await dropRiff(page);
  await expect(tile).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { testFolder: { read(p: string): unknown } }).testFolder.read("music/riff.wav") instanceof Uint8Array)).toBe(true);

  // The segment is empty, on the default grid.
  await page.getByTestId("open-segment-view").click();
  await showTab(page, /^Segment Properties/);
  const stems = page.getByRole("region", { name: "Stems" });
  await expect(stems.locator(".sp-stem")).toHaveCount(0);
  await expect(field(page, "Tempo")).toHaveValue("120");

  // Drag the clip from the Assets panel onto the stem list.
  const t = (await tile.boundingBox())!;
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2 + 20, t.y - 20, { steps: 3 });
  const list = (await stems.locator("ul.sp-list").boundingBox())!;
  await page.mouse.move(list.x + list.width / 2, list.y + list.height / 2, { steps: 8 });
  await expect(page.locator(".asset-drag-ghost")).toHaveText("Add 1 stem");
  await page.mouse.up();

  // The file: a stem named after the clip, the ACID tempo, the cue named by its label on beat 4, the loop region.
  await expect.poll(async () => (await readSong(page)).root.children[0].tracks?.length).toBe(1);
  const seg = (await readSong(page)).root.children[0];
  expect(seg.tracks[0]).toMatchObject({ name: "riff", clip: "music/riff.wav" });
  expect(seg.tempo).toEqual([{ at: "1:1:0", bpm: 90, beatsPerBar: 4, beatUnit: 4 }]);
  expect(seg.cues).toEqual([{ name: "verse", at: "1:4:0" }]);
  expect(seg.regions).toMatchObject([{ id: "loop", count: 0 }]);
  // The panel shows what was written.
  await expect(stems.locator(".sp-stem")).toHaveCount(1);
  await expect(field(page, "Name of riff")).toHaveValue("riff");
  await expect(field(page, "Tempo")).toHaveValue("90");
  await expect(field(page, "Name of cue verse")).toHaveValue("verse");

  // One undo step takes the whole import back (stem, tempo, cue and region).
  await showTab(page, /^Audio Event/);
  await page.getByTestId("event-tree").focus();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await readSong(page)).root.children[0].tracks?.length ?? 0).toBe(0);
  const back = (await readSong(page)).root.children[0];
  expect(back.cues ?? []).toEqual([]);
  expect(back.regions ?? []).toEqual([]);
  expect(back.tempo).toBeUndefined();
  expect(problems).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// The segment view's transport (F-14, F-15): stem solo and mute, starting at a later playlist segment, and the Event editor's
// parameter values, on a playlist of A (one stem) and B (two stems on different clips) that loop, so none advances by itself.

const LIST = "music/list.audioevent.json";
const listEvent = () =>
  event(
    {
      type: "playlist",
      id: "list",
      mode: "sequence",
      rounds: 0,
      children: [
        segment("A", [{ name: "foo", clip: "music/foo.mp3", volume: 0.3 }], true),
        segment("B", [{ name: "town", clip: "music/town.mp3", volume: 0.3 }, { name: "bell", clip: "music/foo.mp3", volume: 0.3 }], true),
      ],
    },
    { bus: "Music", parameters: [{ name: "Intensity", min: 0, max: 1, default: 0.2 }] },
  );

type VoiceRow = { clip: string; gain: number; state: string };
const voiceRows = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __myco: { Audio: { debug(): { voices: VoiceRow[] } } } }).__myco.Audio.debug().voices.filter((v) => /music\/(foo|town)\.mp3/.test(v.clip)).map((v) => ({ clip: v.clip, gain: v.gain, state: v.state })));
const musicRow = (page: Page) =>
  page.evaluate((asset) => (globalThis as unknown as { __myco: { Audio: { debug(): { music?: { asset: string; segment: string | null; state: string }[] } } } }).__myco.Audio.debug().music?.find((r) => r.asset === asset) ?? null, LIST);
const eventRows = (page: Page) =>
  page.evaluate((asset) => (globalThis as unknown as { __myco: { Audio: { debug(): { events: { asset: string; parameters: Record<string, number | string> }[] } } } }).__myco.Audio.debug().events.filter((e) => e.asset === asset), LIST);

/** Open the list event in the Event editor, select its item `index` and open that segment in the segment view. */
async function openListSegment(page: Page, index: number, beforeOpen?: () => Promise<void>): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openTestProject(page, { [LIST]: JSON.stringify(listEvent()) });
  await page.locator(".dock-tab", { hasText: "Assets" }).click();
  const assets = page.locator(".panel.assets");
  await assets.locator(".asset-folder", { hasText: /^music$/ }).click();
  await assets.locator(".asset-item", { has: page.locator(".asset-name", { hasText: "list.audioevent.json" }) }).dblclick();
  await expect(page.getByTestId("event-editor")).toHaveAttribute("data-asset-document", LIST);
  await page.locator(`[data-testid="event-tree-row"][data-event-path="${index}"]`).click();
  await beforeOpen?.();
  await page.getByTestId("open-segment-view").click();
}

test("segment view transport: solo and mute of the stem list are audible in the played segment, and are never written to the event", async ({ page }) => {
  const problems = watch(page);
  await openListSegment(page, 1);
  const before = await page.evaluate((p) => (window as unknown as Hooks).testFolder.read(p), LIST);
  const gainOf = async (clip: string) => Math.max(0, ...(await voiceRows(page)).filter((v) => v.clip.includes(clip)).map((v) => v.gain));
  const stem = (name: string, kind: "Solo" | "Mute") => page.locator(`.sp-stem[data-stem="${name}"] button[title="${kind} (audition only)"]`);
  // The stem list and the view share one dock here and hiding the view closes its sound, so set the buttons, then play.
  const playB = async () => {
    await showTab(page, /^Segment$/);
    await page.getByTestId("transport-play").click();
    await expect.poll(async () => (await musicRow(page))?.segment, { timeout: 30_000 }).toBe("B");
  };

  // Solo "town": only its voice is audible; the other stem of B (the foo clip) is silent.
  await showTab(page, /^Segment Properties/);
  await stem("town", "Solo").click();
  await playB();
  await expect.poll(async () => [(await gainOf("town")) > 0, (await gainOf("foo")) === 0], { timeout: 15_000 }).toEqual([true, true]);

  // Clear it and mute "town": now the foo clip is the audible one.
  await showTab(page, /^Segment Properties/);
  await stem("town", "Solo").click();
  await stem("town", "Mute").click();
  await playB();
  await expect.poll(async () => [(await gainOf("foo")) > 0, (await gainOf("town")) === 0], { timeout: 15_000 }).toEqual([true, true]);

  // Neither wrote to the event.
  expect(await page.evaluate((p) => (window as unknown as Hooks).testFolder.read(p), LIST)).toBe(before);
  expect(problems.filter((p) => !/prime lead/.test(p))).toEqual([]); // the lead warning depends on the CPU the software GL leaves
});

// F-33: Segment and Segment Properties share a dock tab group; the tab switch unmounts the view and must not stop the audition.
test("segment view transport: the audition keeps playing across a switch to Segment Properties, and a solo there is heard at once", async ({ page }) => {
  const problems = watch(page);
  await openListSegment(page, 1);
  const gainOf = async (clip: string) => Math.max(0, ...(await voiceRows(page)).filter((v) => v.clip.includes(clip)).map((v) => v.gain));
  await page.getByTestId("transport-play").click();
  await expect.poll(async () => (await musicRow(page))?.segment, { timeout: 30_000 }).toBe("B");
  await expect.poll(async () => [(await gainOf("town")) > 0, (await gainOf("foo")) > 0], { timeout: 15_000 }).toEqual([true, true]);

  await showTab(page, /^Segment Properties/);
  await page.locator('.sp-stem[data-stem="town"] button[title="Solo (audition only)"]').click();
  // Still the same running music (not restarted), and now only "town" sounds.
  await expect.poll(async () => [(await gainOf("town")) > 0, (await gainOf("foo")) === 0], { timeout: 15_000 }).toEqual([true, true]);
  expect((await musicRow(page))?.segment).toBe("B");
  expect(await eventRows(page)).toHaveLength(1);

  // Back to the view: the transport still shows playing, and Stop ends it.
  await showTab(page, /^Segment$/);
  await expect(page.getByTestId("transport-stop")).toBeEnabled();
  await page.getByTestId("transport-stop").click();
  await expect.poll(async () => (await eventRows(page)).length, { timeout: 15_000 }).toBe(0);
  expect(problems.filter((p) => !/prime lead/.test(p))).toEqual([]);
});

test("segment view transport: Play starts the playlist at the open segment, and the Event editor's parameter values reach the instance", async ({ page }) => {
  const problems = watch(page);
  // The Event editor's slider (not saved) is read by the transport when it plays.
  await openListSegment(page, 1, () => page.getByLabel("Audition Intensity").fill("0.8"));
  await showTab(page, /^Segment$/);
  await page.getByTestId("transport-play").click();
  // The second item plays first: its clips sound, the segment row says B.
  await expect.poll(async () => (await musicRow(page))?.segment, { timeout: 30_000 }).toBe("B");
  await expect.poll(async () => (await voiceRows(page)).some((v) => v.clip.includes("town")), { timeout: 15_000 }).toBe(true);
  await expect.poll(async () => (await eventRows(page))[0]?.parameters.Intensity, { timeout: 15_000 }).toBeCloseTo(0.8, 5);
  expect(problems.filter((p) => !/prime lead/.test(p))).toEqual([]); // the lead warning depends on the CPU the software GL leaves
});

// F-41: "start from" anything but Start used to start the music at the file's start and seek a moment later, so the playhead
// jumped back (or restarted its voices) right after Play. Every choice now starts at its position once. A single segment as in
// the Sound Lab's rhythm game (cues entry and exit, a forever loop over the whole file), 120 bpm 4/4 over a 16 s clip.
const ONE = "music/one.audioevent.json";
const oneEvent = (entry: string) =>
  event(
    segment("one", [{ name: "foo", clip: "music/foo.mp3", volume: 0.3 }], false, {
      cues: [{ name: "entry", at: entry }, { name: "mid", at: "3:1:0" }, { name: "exit", at: "end" }],
      entry: "entry",
      exit: "exit",
      regions: [{ id: "loop", from: "1:1:0", to: "end", count: 0 }],
    }),
    { bus: "Music" },
  );

type PosSample = { pos: number | null; ids: number[] };
const sampleFor = (page: Page, ms: number): Promise<PosSample[]> =>
  page.evaluate(
    ([asset, span]) =>
      new Promise<PosSample[]>((resolve) => {
        type Dbg = { music?: { asset: string; segment: string | null; state: string; bar: number; beat: number; tick: number }[]; voices: { id: number; clip: string; state: string }[] };
        const out: PosSample[] = [];
        const t0 = performance.now();
        const timer = setInterval(() => {
          const d = (globalThis as unknown as { __myco: { Audio: { debug(): Dbg } } }).__myco.Audio.debug();
          const row = d.music?.find((r) => r.asset === asset);
          const playing = row && row.segment !== null && row.state === "playing";
          out.push({
            pos: playing ? ((row.bar - 1) * 4 + (row.beat - 1) + row.tick / 960) * 0.5 : null,
            ids: d.voices.filter((v) => /music\/foo\.mp3/.test(v.clip)).map((v) => v.id).sort((a, b) => a - b),
          });
          if (performance.now() - t0 >= (span as number)) { clearInterval(timer); resolve(out); }
        }, 40);
      }),
    [ONE, ms] as const,
  );
const eventRowsOf = (page: Page, asset: string) =>
  page.evaluate((a) => (globalThis as unknown as { __myco: { Audio: { debug(): { events: { asset: string }[] } } } }).__myco.Audio.debug().events.filter((e) => e.asset === a), asset);

for (const entry of ["1:1:0", "2:1:0"]) {
  test(`segment view transport: every "start from" choice starts there once, with no jump back or voice restart (entry cue at ${entry})`, async ({ page }) => {
    const problems = watch(page);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await openTestProject(page, { [ONE]: JSON.stringify(oneEvent(entry)) });
    await page.locator(".dock-tab", { hasText: "Assets" }).click();
    const assets = page.locator(".panel.assets");
    await assets.locator(".asset-folder", { hasText: /^music$/ }).click();
    await assets.locator(".asset-item", { has: page.locator(".asset-name", { hasText: "one.audioevent.json" }) }).dblclick();
    await expect(page.getByTestId("event-editor")).toHaveAttribute("data-asset-document", ONE);
    await page.locator('[data-testid="event-tree-row"][data-event-path=""]').click();
    await page.getByTestId("open-segment-view").click();

    const entrySeconds = (Number(entry.split(":")[0]) - 1) * 2;
    const choices: { label: string; bar?: string; at: number }[] = [
      { label: "start", at: 0 },
      { label: "cue:entry", at: entrySeconds },
      { label: "cue:mid", at: 4 },
      { label: "bar", bar: "1", at: 0 },
      { label: "bar", bar: "2", at: 2 },
      { label: "bar", bar: "4", at: 6 },
    ];
    for (const c of choices) {
      await page.getByTestId("transport-from").selectOption(c.label);
      if (c.bar) await page.getByTestId("transport-bar").fill(c.bar);
      const sampling = sampleFor(page, 1800);
      await page.getByTestId("transport-play").click();
      const samples = await sampling;
      const at = `${c.label}${c.bar ?? ""}`;
      const heard = samples.filter((s) => s.pos !== null) as { pos: number; ids: number[] }[];
      expect(heard.length, `${at}: the music sounds`).toBeGreaterThan(5);
      // Starts at its position (a little past it: the first sample is a frame or two late), never behind it.
      expect(heard[0]!.pos, at).toBeGreaterThanOrEqual(c.at - 0.05);
      expect(heard[0]!.pos, at).toBeLessThan(c.at + 0.6);
      // The playhead never goes backwards (no jump to the clip's start, no restart), and the voices are the same ones throughout.
      for (let i = 1; i < heard.length; i++) expect(heard[i]!.pos, `${at} sample ${i}`).toBeGreaterThanOrEqual(heard[i - 1]!.pos - 0.03);
      expect(new Set(heard.map((s) => s.ids.join(","))).size, `${at}: voice ids stable`).toBe(1);
      expect((await eventRowsOf(page, ONE)).length).toBe(1);
      await page.getByTestId("transport-stop").click();
      await expect.poll(async () => (await eventRowsOf(page, ONE)).length, { timeout: 15_000 }).toBe(0);
    }
    expect(problems.filter((p) => !/prime lead/.test(p))).toEqual([]);
  });
}
