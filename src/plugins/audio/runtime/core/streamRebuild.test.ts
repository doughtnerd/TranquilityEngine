// B3 across a hard rebuild (architecture §7: "Streams reopen with a new epoch"): a real trap in the test-hooks core, the
// real `AudioHost` respawning its node, and the core backend reopening the stream voice on the new core with a new
// stream id, from its playhead, on a new channel to the new worklet. The old stream is closed on the worker. ADR 0223:
// the stream rig (the production assembly on the loopback, which serves each `streamPort` the backend connects); what the
// core received is read off the loopback's watch.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeWav, signal } from "../decoder/testWav";
import { Op, readPlay } from "../wire.generated";
import { closeLoopbackAudio } from "../testing";
import { RATE, rig } from "../../testing/streamRig";

afterEach(async () => {
  await closeLoopbackAudio();
  vi.restoreAllMocks();
});

describe("a stream across a hard rebuild (B3)", () => {
  it("reopens on the new core with a new stream id, from where it was, and plays on", async (ctx) => {
    const r = await rig({ "music/long.wav": makeWav(6 * RATE, 2, RATE, signal) });
    if (!r) return ctx.skip();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { backend } = r;
    const health = r.audio.host.health;
    const out = r.left;
    // Frames until the work is done. (`vi.waitFor` is a 1 s wall-clock budget polled every 50 ms: it fails on a busy
    // machine. Here the budget counts frames; a real millisecond between them gives the worker and the respawn CPU.
    // FU2: 1 ms, not 50: how many frames render before the worker's chunks land must not move the result.)
    const until = async (done: () => boolean, what: string) => {
      for (let k = 0; k < 20_000 && !done(); k++) {
        await r.step(1);
        if (!done()) await new Promise((res) => setTimeout(res, 1));
      }
      if (!done()) throw new Error(`gave up waiting for ${what}`);
    };
    const received = r.audio.watch();
    /** The stream ids the voice's PLAYs carried to the core (the first, then the replay's). */
    const streamsOf = (id: number) => received.pending.flatMap((b) => b.records.filter((x) => x.opcode === Op.PLAY && x.voiceId === id).map((x) => readPlay(x.view, x.off).clip));
    const voice = backend.play({ path: "music/long.wav", url: "", loop: false, stream: true, bus: "Music" })!;
    await until(() => r.worklet().frames > 0, "the stream's first frames");
    await r.step(73);
    expect(voice.reason).toBeNull();
    const oldStream = streamsOf(voice.id).at(-1)!;
    const connections = backend.streams.stats.connections;

    r.audio.trap();
    await r.step(2);
    expect(health.traps).toBe(1);
    expect(voice.playing).toBe(true);
    // The new core answers; the stream reopens on it (new id, new channel) and sounds again.
    const restartAt = out.length;
    await until(() => out.slice(restartAt).some((s) => s !== 0), "the reopened stream to sound");
    await r.step(20);
    expect(health.recoveries).toBe(1);
    expect(streamsOf(voice.id).at(-1)).not.toBe(oldStream);
    expect(backend.streams.stats.connections).toBe(connections + 1);
    expect(voice.playing).toBe(true);
    expect(voice.reason).toBeNull();
    // From its playhead: the new core's output is the file from some frame on (exactly, once the voice sounds).
    let on = restartAt;
    while (out[on] === 0) on++;
    const want = (k: number) => signal(k, 0) / 32768;
    let pos = -1;
    for (let p = 0; p < 6 * RATE - 64 && pos < 0; p++) {
      let ok = true;
      for (let k = 0; k < 64 && ok; k++) ok = out[on + k] === want(p + k);
      if (ok) pos = p;
    }
    expect(pos).toBeGreaterThan(0);
    // Where it would have been: the output frames since the file's frame 0 sounded (its first sample is 0, so the
    // first non-zero output is file frame 1), the gap and the reopen's wait included.
    const firstSound = out.findIndex((s) => s !== 0);
    const origin = firstSound - [0, 1, 2, 3].find((p) => [0, 1, 2, 3].every((k) => out[firstSound + k] === want(p + k)))!;
    const expected = on - origin;
    // FU2: frame-driven, so exact: the reopen resumes from the stream's own position (its STATUS playhead, not counting
    // the frames it waited for its first chunks) at a stamp ahead of the worker's first chunks. Before FU2 it resumed
    // from an estimate anchored at its first PLAY and waited for the worker on the new core, and the error moved with
    // how many frames rendered while the worker ran (1, 513, 1,025… frames). Bound: under a quantum.
    expect(Math.abs(pos - expected)).toBeLessThan(128);
    for (let k = 0; k < 4_000; k++) if (out[on + k] !== want(pos + k)) expect.fail(`frame ${k} after the reopen`);
    // Every assertion above is on frames rendered, stream ids and counters; the timeout is the harness's patience.
  }, 120_000);
});
