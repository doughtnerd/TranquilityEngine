import { expect, test } from "./fixtures";
import { exportAndServe, stopServed, type Served } from "./audioExport";
import { startDebugLinkTool, type DebugLinkTool } from "./debugLinkFixture";
import { openTakeFile } from "../../src/plugins/audio/runtime/capture/takeFile";
import { createTakeReceiver, type TakeReceiveResult } from "../../src/plugins/audio/editor/debugLink/takeReceiver";
import { AudioRequest, decodeTakeChunk, type TakeStateReply, type TakeUploadReply } from "../../src/plugins/audio/runtime/debugLink/schema";

// The debug link in a real exported game (plan task S1, ADR 0376, 0380): samples/flappy is exported for the web with debugging
// on, pointing at a Node tool listener (`debugLinkFixture.ts`); Chromium opens it, the build connects and says hello, and the
// tool records a take over the link (`take.start`, `take.mark`, `take.stop`), uploads it (`take.upload`, the `upload`
// subscription, `createTakeReceiver`) and opens the bytes as a take file. The game's own save isn't reachable without internals,
// so the check is on what the take says: it opens, its duration matches what the link reported, it holds the tool's mark.

test.describe.configure({ timeout: 180_000 });

test.describe("the debug link in an exported game", { tag: "@slow" }, () => {
  let tool: DebugLinkTool | undefined;
  let served: Served | undefined;
  test.afterEach(() => {
    tool?.close();
    stopServed(served);
    tool = served = undefined;
  });

  test("a take recorded over the link uploads into a take file the reader opens", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    tool = await startDebugLinkTool();
    served = await exportAndServe("flappy", ["--debug-link", tool.address]);

    await page.goto(served.url);
    const peer = await tool.nextPeer();
    expect(peer.hello.topics).toContain("audio");
    expect(peer.state).toBe("accepted");
    await page.locator("#game canvas").click(); // the first gesture starts the audio core, as a player's would

    // The core may still be starting: ask again until the build records.
    await expect
      .poll(
        async () => {
          try {
            return ((await peer.request("audio", AudioRequest.start)) as TakeStateReply).state;
          } catch {
            return "refused";
          }
        },
        { message: "take.start is answered with a recording take", timeout: 30_000, intervals: [250, 500, 1000] },
      )
      .toBe("recording");

    const MARK = "e2e mark";
    const marked = (await peer.request("audio", AudioRequest.mark, { text: MARK })) as TakeStateReply;
    expect(marked.state).toBe("recording");
    // Play a few seconds of the take: the bound is the take's own clock (its seconds), polled over the link.
    await page.locator("#game canvas").click();
    await expect
      .poll(async () => ((await peer.request("audio", AudioRequest.mark, { text: "tick" })) as TakeStateReply).seconds, { timeout: 40_000, intervals: [500] })
      .toBeGreaterThanOrEqual(2);

    const stopped = (await peer.request("audio", AudioRequest.stop)) as TakeStateReply;
    expect(stopped.state).toBe("stopped");
    expect(stopped.seconds).toBeGreaterThanOrEqual(2);

    const reply = (await peer.request("audio", AudioRequest.upload)) as TakeUploadReply;
    expect(reply.bytes).toBeGreaterThan(0);
    expect(reply.seconds).toBeCloseTo(stopped.seconds, 1);
    const rx = createTakeReceiver(reply);
    const result = await new Promise<TakeReceiveResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the upload didn't finish (${rx.received} of ${reply.bytes} bytes)`)), 30_000);
      const sub = peer.subscribe(
        "audio",
        { kind: "upload", upload: reply.upload },
        (records) => {
          for (const r of records) {
            const chunk = decodeTakeChunk(r.payload);
            const got: TakeReceiveResult = "refused" in chunk ? { status: "error", error: chunk.refused } : rx.push(chunk);
            if (got.status !== "more") {
              clearTimeout(timer);
              sub.unsubscribe();
              resolve(got);
              return;
            }
          }
        },
        (message) => (clearTimeout(timer), reject(new Error(message))),
      );
    });
    if (result.status !== "done") throw new Error(`upload failed: ${result.status === "error" ? result.error : "incomplete"}`);
    expect(result.bytes.byteLength).toBe(reply.bytes);

    // The bytes open as a take file, whose length and requests are what the link said.
    const opened = await openTakeFile(result.bytes);
    expect(opened.take.duration).toBeGreaterThanOrEqual(2);
    expect(opened.take.duration).toBeCloseTo(reply.seconds, 0);
    expect(opened.take.requests.length).toBeGreaterThanOrEqual(1);
    expect(opened.take.marks().map((m) => m.text)).toContain(MARK);
    expect(errors).toEqual([]);
  });
});
