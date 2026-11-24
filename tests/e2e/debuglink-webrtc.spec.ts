import { expect, test, openEditor } from "./fixtures";
import { exportAndServe, stopServed, type Served } from "./audioExport";
import { createServer } from "node:net";

// Room codes over WebRTC in real browsers (ADR 0403 "Pairing code", 0404; plan task R6). Page A is a debug web export of
// samples/flappy that listens (`--debug-listen`): a page can't listen, so it opens a rendezvous room on its own origin and shows the
// room code in its overlay. Page B is the browser editor from the e2e server, which can't listen either: Studio's
// builds menu > "Connect to a build…" takes the code, joins the room, and the two pages connect over a WebRTC data channel.
//
// Everything is read the way a person would: the code from page A's visible overlay text, the pairing from page B's builds menu (and
// from A's overlay hiding once a tool is connected). Page A is opened from `localhost`, so (R5) its code names 0.1 and the editor
// falls back to 127.0.0.1 for the rendezvous; the notice under the code says so.
//
// Not covered here: recording and uploading a take over this link. S1 (`debuglink-audio.spec.ts`) does that over a WebSocket with a
// Node tool, and Node has no RTCPeerConnection, so a Node tool can't join a room; the editor's UI has no take control that works
// without the audio plugin's own panel. The WebRTC transport carries the same session as a WebSocket does (unit tests of `rooms.ts`,
// `webrtc.ts` and the editor link).
//
// Chromium only: Playwright's WebKit on Windows has no RTCPeerConnection.

test.describe.configure({ timeout: 240_000 });

test.describe("room codes over WebRTC in real browsers", { tag: "@slow" }, () => {
  let served: Served | undefined;
  test.afterEach(() => {
    stopServed(served);
    served = undefined;
  });

  test("a browser editor connects to a debug web export by its room code; a wrong code is refused", async ({ page: game, context, browserName }) => {
    test.skip(browserName !== "chromium", "WebRTC needs RTCPeerConnection, which Playwright's WebKit on Windows lacks; this runs in Chromium only.");
    const errors: string[] = [];
    game.on("pageerror", (err) => errors.push(err.message));

    // The export's own serve.mjs hosts the rendezvous at /myco-rendezvous (R4), on a port a room code can name (0404).
    served = await exportAndServe("flappy", ["--debug-listen"], await freeRoomPort());
    await game.goto(served.url);

    // Page A shows a room code and says it pairs only with tools on this machine (it was opened from localhost).
    const overlay = game.getByText(/Debug pairing code: [0-9A-Z]{5}-[0-9A-Z]{5}/i);
    await expect(overlay).toBeVisible({ timeout: 60_000 });
    await expect(overlay).toContainText("network address");
    const code = /([0-9A-Z]{5}-[0-9A-Z]{5})/i.exec(await overlay.innerText())![1]!;

    // Page B: the browser editor. It lists no builds until it connects.
    const editor = await context.newPage();
    await openEditor(editor, { sample: "flappy" });
    const builds = editor.locator("button.debug-link-button");
    await expect(builds).not.toHaveText(/\d+ builds?/);
    const connect = async (typed: string) => {
      await builds.click();
      await editor.getByRole("menuitem", { name: "Connect to a build…" }).click();
      const dialog = editor.getByRole("dialog", { name: "Connect to a build" });
      await dialog.getByPlaceholder("3F9QK-7KD2X").fill(typed);
      await dialog.getByRole("button", { name: "Connect", exact: true }).click();
      return dialog;
    };

    // A wrong code (the right room, the last character of the token changed) is refused, and the dialog says so and stays open.
    const last = code.slice(-1);
    const wrong = code.slice(0, -1) + (last === "2" ? "3" : "2");
    const dialog = await connect(wrong);
    const failure = dialog.getByRole("alert");
    await expect(failure).toBeVisible({ timeout: 60_000 });
    await expect(failure).not.toHaveText("");
    await expect(dialog).toBeVisible();
    await expect(builds).not.toHaveText(/\d+ builds?/);

    // The right code connects: the dialog closes, the builds menu lists the game, and page A's overlay hides (a tool is connected).
    await dialog.getByPlaceholder("3F9QK-7KD2X").fill(code);
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 90_000 });
    await expect(builds).toHaveText("1 build", { timeout: 30_000 });
    await builds.click();
    await expect(editor.getByRole("menuitemradio", { name: /\(web, / })).toBeVisible();
    await expect(overlay).toBeHidden({ timeout: 30_000 });
    expect(errors).toEqual([]);
  });
});

/** The first free port of 7790..7799, the native range a room code can name (`RENDEZVOUS_PORTS`, ADR 0404). */
async function freeRoomPort(): Promise<number> {
  for (let port = 7790; port <= 7799; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error("no port of 7790..7799 is free for the export's rendezvous");
}
