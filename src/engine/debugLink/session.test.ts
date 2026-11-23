// A build's debug link session and the tool's listener and peer (ADR 0376), over the loopback transport on one clock:
// the hello and the tool's accept, pulled subscriptions (nothing sent without one, rate-limited, stopped by
// unsubscribing), requests and errors, commands applied at the frame start after they arrive, and closing.
import { afterEach, describe, expect, it } from "vitest";
import { createTransport, type Transport } from "../net/Transport";
import "../net/transport/loopback";
import { DebugLinkListener, type DebugLinkPeer } from "./client";
import type { LinkRecord } from "./records";
import { DebugLinkSession, RELIABLE_SAMPLES_PER_FRAME } from "./session";
import type { DebugTopic } from "./topics";

let address = 0;
const open: { close(): void }[] = [];
afterEach(() => {
  for (const o of open.splice(0)) o.close();
});

/** A topic that logs what the link asks of it; each sample writes one record numbering the samples. */
function testTopic(log: string[], rate = 10): DebugTopic & { samples: number } {
  const topic = {
    samples: 0,
    rate,
    subscribe(params: unknown) {
      const p = params as { refuse?: boolean; what?: string };
      if (p?.refuse) return { refused: "not that one" };
      log.push(`subscribe ${p?.what}`);
      return {
        sample: (out: { write(type: number, seq: number, frame: number, payload: Uint8Array): void }, frame: number) => {
          topic.samples++;
          out.write(0x41, topic.samples, frame, new Uint8Array([topic.samples]));
        },
        close: () => log.push(`close ${p?.what}`),
      };
    },
    request(method: string, params: unknown) {
      log.push(`request ${method}`);
      if (method === "fail") throw new Error("it failed");
      if (method === "later") return Promise.resolve({ later: params });
      return { echo: params };
    },
    command(name: string, params: unknown) {
      if (name === "bad") throw new Error("bad command");
      log.push(`command ${name} ${JSON.stringify(params)}`);
    },
  };
  return topic;
}

async function link(topic: DebugTopic, buildConditions: { loss?: number } = {}) {
  let t = 0;
  const now = () => t;
  const tool: Transport = createTransport("loopback", { now });
  const peers: DebugLinkPeer[] = [];
  const closed: DebugLinkPeer[] = [];
  const listener = new DebugLinkListener(tool, { onPeer: (p) => peers.push(p), onClose: (p) => closed.push(p) });
  const at = `debug-session-${++address}`;
  await listener.listen(at);
  const build: Transport = createTransport("loopback", { now, random: () => 0.5, ...buildConditions });
  const logged: string[] = [];
  const session = new DebugLinkSession({ transport: build, connection: build.connect(at), hello: { name: "Game", platform: "web", topics: ["test"] }, topics: new Map([["test", topic]]), log: (l) => logged.push(l) });
  open.push(listener, build);
  /** One build frame of `dt`, then the tool's poll. */
  const frame = (dt = 1 / 60) => {
    t += dt * 1000;
    session.frameStart();
    session.frameEnd(dt);
    listener.poll();
  };
  return { session, listener, peers, closed, frame, logged };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the build's session and the tool's peer", () => {
  it("says hello, then waits for the tool to accept it", async () => {
    const log: string[] = [];
    const { session, peers, frame } = await link(testTopic(log));
    expect(session.state).toBe("connecting");
    frame();
    expect(session.state).toBe("waiting");
    expect(peers).toHaveLength(1);
    expect(peers[0]!.hello).toEqual({ name: "Game", platform: "web", topics: ["test"] });
    expect(peers[0]!.state).toBe("pending");
    // Before the accept, a request isn't sent, and a subscription is refused by the build.
    await expect(peers[0]!.request("test", "x")).rejects.toThrow(/hasn't been accepted/);
    const errors: string[] = [];
    peers[0]!.subscribe("test", { what: "early" }, () => {}, (m) => errors.push(m));
    frame();
    frame();
    expect(errors).toEqual(["the tool hasn't accepted this build yet"]);
    expect(log).toEqual([]);
    peers[0]!.accept();
    frame();
    expect(session.state).toBe("accepted");
  });

  it("sends nothing without a subscriber, samples at the topic's rate while subscribed, and stops when unsubscribed", async () => {
    const log: string[] = [];
    const topic = testTopic(log, 10);
    const { session, peers, frame } = await link(topic);
    frame();
    peers[0]!.accept();
    for (let i = 0; i < 30; i++) frame();
    expect(topic.samples).toBe(0); // pulled: no subscription, no samples
    const got: LinkRecord[] = [];
    const sub = peers[0]!.subscribe("test", { what: "meters" }, (records) => got.push(...records));
    for (let i = 0; i < 60; i++) frame(); // one second at 60 Hz
    expect(log).toEqual(["subscribe meters"]);
    expect(session.subscriptionCount).toBe(1);
    // The first frame after subscribing samples, then one per tenth of a second.
    expect(topic.samples).toBeGreaterThanOrEqual(10);
    expect(topic.samples).toBeLessThanOrEqual(11);
    expect(got.map((r) => r.payload[0])).toEqual(Array.from({ length: topic.samples }, (_, i) => i + 1));
    expect(got.every((r) => r.type === 0x41)).toBe(true);
    sub.unsubscribe();
    const before = topic.samples;
    for (let i = 0; i < 60; i++) frame();
    expect(log).toEqual(["subscribe meters", "close meters"]);
    expect(session.subscriptionCount).toBe(0);
    expect(topic.samples).toBe(before);
  });

  it("refuses a subscription the topic refuses, or to a topic the build doesn't have", async () => {
    const { peers, frame } = await link(testTopic([]));
    frame();
    peers[0]!.accept();
    const errors: string[] = [];
    peers[0]!.subscribe("test", { refuse: true }, () => {}, (m) => errors.push(m));
    peers[0]!.subscribe("nope", {}, () => {}, (m) => errors.push(m));
    frame();
    frame();
    expect(errors).toEqual(["not that one", 'this build has no "nope" topic']);
  });

  it("answers requests (now or later) and rejects with the build's error", async () => {
    const log: string[] = [];
    const { peers, frame } = await link(testTopic(log));
    frame();
    peers[0]!.accept();
    const echo = expect(peers[0]!.request("test", "echo", { a: 1 })).resolves.toEqual({ echo: { a: 1 } });
    const later = expect(peers[0]!.request("test", "later", 2)).resolves.toEqual({ later: 2 });
    const fail = expect(peers[0]!.request("test", "fail")).rejects.toThrow("it failed");
    const missing = expect(peers[0]!.request("other", "x")).rejects.toThrow('this build has no "other" topic');
    frame();
    await flush();
    frame();
    await Promise.all([echo, later, fail, missing]);
  });

  it("applies commands at the frame start after they arrive, after that poll's requests", async () => {
    const log: string[] = [];
    const { session, listener, peers, frame } = await link(testTopic(log));
    frame();
    peers[0]!.accept();
    frame();
    expect(peers[0]!.command("test", "set", { v: 1 })).toBe(true);
    const echo = peers[0]!.request("test", "echo");
    const errors: string[] = [];
    peers[0]!.onError = (m) => errors.push(m);
    peers[0]!.command("test", "bad");
    // Delivered, but not applied until the build's next frame start.
    session.frameEnd(1 / 60);
    expect(log).toEqual([]);
    session.frameStart();
    expect(log).toEqual(["request echo", 'command set {"v":1}']);
    listener.poll();
    expect(errors).toEqual(["bad command"]);
    await expect(echo).resolves.toEqual({}); // { echo: undefined } as JSON
    frame();
    expect(log).toHaveLength(2); // once
  });

  it("closes both ends: the build's subscriptions end, pending requests reject, and the listener says so", async () => {
    const log: string[] = [];
    const { session, peers, closed, frame } = await link(testTopic(log));
    frame();
    const peer = peers[0]!;
    peer.accept();
    peer.subscribe("test", { what: "x" }, () => {});
    frame();
    const pending = expect(peer.request("test", "later")).rejects.toThrow(/gone/);
    peer.close("done");
    expect(peer.state).toBe("closed");
    await pending;
    expect(peer.command("test", "set")).toBe(false);
    frame();
    frame();
    expect(session.state).toBe("closed");
    expect(session.closedReason).toMatch(/done/);
    expect(log).toEqual(["subscribe x", "request later", "close x"]); // the request went before the close
    expect(closed).toEqual([peer]);
  });

  it("the build closing ends the tool's peer", async () => {
    const { session, peers, frame, logged } = await link(testTopic([]));
    frame();
    peers[0]!.accept();
    frame();
    session.close("bye");
    frame();
    expect(peers[0]!.state).toBe("closed");
    expect(logged).toEqual([]);
  });
});

describe("a topic's channel", () => {
  /** A topic whose subscription has `chunks` records to send, one per sample call (as the take upload's chunks). */
  function queueTopic(chunks: number, channel?: "reliable" | "unreliable"): DebugTopic {
    return {
      rate: 60,
      channel,
      subscribe: () => {
        let next = 0;
        return {
          sample: (out, frame) => {
            if (next < chunks) out.write(0x42, next, frame, new Uint8Array([next++]));
          },
          close: () => {},
        };
      },
    };
  }

  async function subscribed(topic: DebugTopic, loss: number) {
    const l = await link(topic, { loss });
    l.frame();
    l.peers[0]!.accept();
    l.frame();
    const perFrame: number[][] = [];
    l.peers[0]!.subscribe("test", null, (records) => perFrame[perFrame.length - 1]!.push(...records.map((r) => r.seq)));
    const frame = () => {
      perFrame.push([]);
      l.frame();
    };
    return { frame, perFrame };
  }

  it("sends a reliable topic's samples on the reliable channel, several messages a due frame up to the bound, in order", async () => {
    // Every unreliable message is lost on this link; reliable ones still arrive.
    const { frame, perFrame } = await subscribed(queueTopic(20, "reliable"), 1);
    frame(); // the subscribe reaches the build; its first due frame samples
    frame();
    frame();
    frame();
    const sent = perFrame.flat();
    expect(sent).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(Math.max(...perFrame.map((f) => f.length))).toBe(RELIABLE_SAMPLES_PER_FRAME);
  });

  it("sends an unreliable topic's samples once a due frame, on the unreliable channel (the default)", async () => {
    const kept = await subscribed(queueTopic(20), 0);
    for (let i = 0; i < 4; i++) kept.frame();
    expect(kept.perFrame.map((f) => f.length)).toEqual([1, 1, 1, 1]);
    const lost = await subscribed(queueTopic(20), 1);
    for (let i = 0; i < 4; i++) lost.frame();
    expect(lost.perFrame.flat()).toEqual([]);
  });
});
