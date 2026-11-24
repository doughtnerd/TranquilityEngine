// Either side of the debug link listens (ADR 0403 "Roles", plan task L7), over the loopback transport on one clock:
// a build that listens (`startBuildListener`) and a tool that connects to it (`ToolConnector`); a build that connects out
// to a listening tool (`startDebugLink` with a code, `DebugLinkListener` with a gate). The accept rules: a valid token
// skips the prompt, a tokenless connection from another machine gets the prompt (or `no-token` on a build with nobody
// to ask), the same machine needs no code; refusals for a wrong, expired, used or locked code and for two of one role;
// the next code after a pairing; and the old hello-first build, still read as a tokenless one.
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../../myco";
import { createTransport, type Transport } from "../net/Transport";
import "../net/transport/loopback";
import { DebugLinkListener, ToolConnector, type DebugLinkPeer } from "./client";
import { startBuildListener, startDebugLink, RECONNECT_SECONDS, type BuildListenerOptions, type ToolAtTheDoor } from "./host";
import { decodePairCode, encodePairCode } from "./pairing/code";
import { LOCK_MS, MAX_FAILURES, TOKEN_EXPIRY_MS, TokenGate } from "./pairing/gate";
import type { LinkRecord } from "./records";
import { DebugLinkSession } from "./session";
import { registerDebugTopic, type DebugTopic } from "./topics";

const undo: (() => void)[] = [];
afterEach(() => {
  for (const u of undo.splice(0).reverse()) u();
});

/** A clock tests step, and a token source that never repeats. */
function clock() {
  let t = 1000;
  let seed = 0;
  return {
    now: () => t,
    step: (ms: number) => void (t += ms),
    randomToken: (bits: number) => (++seed * 104_729) % 2 ** bits,
  };
}

/** Lets settled promises (a prompt's answer) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** A topic counting what it sends; one record per sample. */
function counterTopic(log: string[]): DebugTopic {
  let n = 0;
  return {
    rate: 60,
    subscribe: () => ({
      sample: (out, frame) => out.write(0x41, ++n, frame, new Uint8Array([n])),
      close: () => void log.push("closed"),
    }),
    request: (method) => ({ method }),
    command: (name) => void log.push(`command ${name}`),
  };
}

const LAN = [{ address: "192.168.1.20", family: "IPv4" as const }];

/** A listening build on a headless Engine with one `counter` topic, and a tool connector on the same clock. */
async function listening(overrides: Partial<BuildListenerOptions> = {}, debug: Record<string, unknown> = { listen: true, lan: true }) {
  const c = clock();
  const log: string[] = [];
  undo.push(registerDebugTopic("counter", async () => () => counterTopic(log)));
  const engine = await Engine.create({ headless: true });
  undo.push(() => engine.dispose());
  const lines: string[] = [];
  const build = await startBuildListener(engine, {
    debug,
    name: "Listening game",
    transport: "loopback",
    transportOptions: { now: c.now },
    interfaces: () => LAN,
    sameMachine: () => false,
    now: c.now,
    randomToken: c.randomToken,
    log: (l) => lines.push(l),
    ...overrides,
  });
  if (build) undo.push(() => build.close());
  const peers: DebugLinkPeer[] = [];
  const closed: DebugLinkPeer[] = [];
  const tool = new ToolConnector(createTransport("loopback", { now: c.now }), { kind: "native", name: "Audio Studio on DESKTOP-1", events: { onPeer: (p) => peers.push(p), onClose: (p) => closed.push(p) } });
  undo.push(() => tool.close());
  /** One round: the tool polls, a frame runs, the tool polls. */
  const round = (n = 1) => {
    for (let i = 0; i < n; i++) {
      tool.poll();
      engine.step(1 / 60);
      tool.poll();
    }
  };
  return { c, engine, build, tool, peers, closed, log, lines, round };
}

/** The token in the code the build shows now. */
function shownToken(code: string | null): number {
  expect(code).not.toBeNull();
  const read = decodePairCode(code!);
  if (!("code" in read)) throw new Error(read.refused);
  return read.code.token;
}

describe("a build that listens", () => {
  it("doesn't listen unless debug.listen says so", async () => {
    const engine = await Engine.create({ headless: true });
    undo.push(() => engine.dispose());
    expect(await startBuildListener(engine, { debug: { link: "ws://localhost:7790/myco-debug" }, name: "x", transport: "loopback" })).toBeNull();
    expect(await startBuildListener(engine, { debug: undefined, name: "x", transport: "loopback" })).toBeNull();
  });

  it("listens on the LAN at the first port, and shows an address code for its private address and port", async () => {
    const { build } = await listening();
    expect(build!.address).toBe("ws://0.0.0.0:7790/myco-debug");
    expect(build!.port).toBe(7790);
    expect(build!.lan).toBe(true);
    const read = decodePairCode(build!.code!);
    expect(read).toEqual({ code: { kind: "address", octets: [1, 20], portOffset: 0, token: build!.token!.token } });
  });

  it("listens on loopback without debug.lan, and shows no code (same-machine tools need none)", async () => {
    const { build } = await listening({}, { listen: true });
    expect(build!.address).toBe("ws://127.0.0.1:7790/myco-debug");
    expect(build!.lan).toBe(false);
    expect(build!.code).toBeNull();
    expect(build!.token).toBeNull();
  });

  it("takes the next port when the first is taken, and its code says the offset; null when all ten are taken", async () => {
    const first = await listening();
    const engine = await Engine.create({ headless: true });
    undo.push(() => engine.dispose());
    const second = (await startBuildListener(engine, { debug: { listen: true, lan: true }, name: "Second", transport: "loopback", interfaces: () => LAN, now: first.c.now, randomToken: first.c.randomToken }))!;
    undo.push(() => second.close());
    expect(second.port).toBe(7791);
    expect(decodePairCode(second.code!)).toMatchObject({ code: { portOffset: 1 } });
    const blockers: Transport[] = [];
    for (let p = 7792; p <= 7799; p++) {
      const t = createTransport("loopback");
      await t.listen(`ws://0.0.0.0:${p}/myco-debug`);
      blockers.push(t);
    }
    undo.push(() => blockers.forEach((t) => t.close()));
    const lines: string[] = [];
    expect(await startBuildListener(engine, { debug: { listen: true, lan: true }, name: "Third", transport: "loopback", log: (l) => lines.push(l) })).toBeNull();
    expect(lines.join("\n")).toContain("7790..7799 are all taken");
  });

  it("pairs a tool by its token: no prompt, the build says hello, serves its topics, and shows the next code", async () => {
    const asked: ToolAtTheDoor[] = [];
    const { build, tool, peers, round } = await listening({ prompt: async (t) => (asked.push(t), false) });
    const before = build!.token!;
    const attempt = tool.connect(build!.address, shownToken(build!.code));
    expect(attempt.state).toBe("connecting");
    tool.poll();
    expect(attempt.state).toBe("pairing");
    round(2);
    expect(attempt.state).toBe("paired");
    expect(asked).toEqual([]);
    expect(peers).toHaveLength(1);
    expect(attempt.peer).toBe(peers[0]);
    expect(peers[0]!.state).toBe("accepted");
    expect(peers[0]!.hello).toEqual({ name: "Listening game", platform: "desktop", topics: expect.arrayContaining(["counter"]) });
    expect(build!.tools).toEqual([{ name: "Audio Studio on DESKTOP-1", kind: "native", remote: expect.any(String) }]);
    expect(build!.token!.serial).toBe(before.serial + 1);
    expect(build!.code).not.toBe(encodePairCode({ kind: "address", octets: [1, 20], portOffset: 0, token: before.token }));

    const got: LinkRecord[] = [];
    peers[0]!.subscribe("counter", null, (records) => got.push(...records));
    round(2);
    expect(got.length).toBeGreaterThan(0);
    const answer = peers[0]!.request("counter", "ping");
    round();
    await expect(answer).resolves.toEqual({ method: "ping" });
  });

  it("applies a tool's command at the frame start after it arrives", async () => {
    const { build, tool, peers, log, round } = await listening();
    tool.connect(build!.address, shownToken(build!.code));
    round(3);
    peers[0]!.command("counter", "go");
    tool.poll();
    expect(log).not.toContain("command go");
    round();
    expect(log).toContain("command go");
  });

  it("lets a same-machine tool in without a code or a prompt", async () => {
    const asked: ToolAtTheDoor[] = [];
    const { build, tool, peers, round } = await listening({ sameMachine: undefined, prompt: async (t) => (asked.push(t), false) }, { listen: true });
    const attempt = tool.connect(build!.address);
    round(2);
    expect(attempt.state).toBe("paired");
    expect(peers[0]!.state).toBe("accepted");
    expect(asked).toEqual([]);
  });

  it("asks about a tokenless tool from another machine: yes lets it in, no refuses it as declined", async () => {
    const answers = [true, false];
    const asked: ToolAtTheDoor[] = [];
    const { build, tool, round } = await listening({ prompt: async (t) => (asked.push(t), answers.shift()!) });
    const yes = tool.connect(build!.address);
    round();
    expect(yes.state).toBe("pairing");
    expect(asked).toEqual([{ role: "tool", kind: "native", name: "Audio Studio on DESKTOP-1", remote: expect.any(String), sameMachine: false }]);
    await settle();
    round(2);
    expect(yes.state).toBe("paired");
    const no = tool.connect(build!.address);
    round();
    await settle();
    round(2);
    expect(no.state).toBe("refused");
    expect(no.refusal).toEqual({ accepted: false, reason: "declined", message: expect.any(String) });
    expect(build!.tools).toHaveLength(1);
  });

  it("refuses a tokenless tool from another machine with no-token when nobody can be asked", async () => {
    const { build, tool, round } = await listening();
    const attempt = tool.connect(build!.address);
    round(2);
    expect(attempt.state).toBe("refused");
    expect(attempt.refusal?.reason).toBe("no-token");
    expect(attempt.peer).toBeNull();
  });

  it("refuses a wrong code, an expired one and a used one", async () => {
    const { c, build, tool, round } = await listening();
    const right = shownToken(build!.code);
    const bad = tool.connect(build!.address, (right + 1) % 2 ** 30);
    round(2);
    expect(bad.state).toBe("refused");
    expect(bad.refusal?.reason).toBe("bad-token");

    c.step(TOKEN_EXPIRY_MS + 1);
    const expired = tool.connect(build!.address, right);
    round(2);
    expect(expired.refusal?.reason).toBe("expired");

    const fresh = shownToken(build!.code);
    expect(fresh).not.toBe(right);
    const first = tool.connect(build!.address, fresh);
    round(2);
    expect(first.state).toBe("paired");
    const again = tool.connect(build!.address, fresh);
    round(2);
    expect(again.refusal?.reason).toBe("used");
  });

  it("locks LAN connections for a minute after five wrong codes, even for the right one", async () => {
    const { c, build, tool, round } = await listening();
    const right = shownToken(build!.code);
    for (let i = 1; i <= MAX_FAILURES; i++) {
      tool.connect(build!.address, (right + i) % 2 ** 30);
      round(2);
    }
    expect(build!.lockedUntil).not.toBeNull();
    const locked = tool.connect(build!.address, right);
    round(2);
    expect(locked.refusal?.reason).toBe("locked");
    c.step(LOCK_MS);
    expect(build!.lockedUntil).toBeNull();
    const open = tool.connect(build!.address, shownToken(build!.code));
    round(2);
    expect(open.state).toBe("paired");
  });

  it("refuses a build that connects to it (two builds) with role", async () => {
    const { c, build, round } = await listening();
    const t = createTransport("loopback", { now: c.now });
    undo.push(() => t.close());
    const lines: string[] = [];
    const other = new DebugLinkSession({ transport: t, connection: t.connect(build!.address), hello: { name: "Other build", platform: "web", topics: [] }, topics: new Map(), pair: { role: "build", kind: "native" }, log: (l) => lines.push(l) });
    other.frameStart();
    round();
    other.frameStart();
    expect(other.state).toBe("closed");
    expect(other.refusal?.reason).toBe("role");
    expect(lines.join("\n")).toContain("refused the pairing");
  });

  it("serves several tools at once, and closes with the Engine", async () => {
    const { engine, build, tool, peers, closed, round } = await listening({ sameMachine: undefined }, { listen: true });
    tool.connect(build!.address);
    tool.connect(build!.address);
    round(2);
    expect(peers).toHaveLength(2);
    expect(build!.tools).toHaveLength(2);
    peers[0]!.close();
    round();
    expect(build!.tools).toHaveLength(1);
    engine.dispose();
    tool.poll();
    expect(peers[1]!.state).toBe("closed");
    expect(closed).toHaveLength(2);
  });
});

describe("a tool that connects out", () => {
  it("fails an attempt to an address where nothing listens, and can cancel one", async () => {
    const tool = new ToolConnector(createTransport("loopback"), { kind: "page-http" });
    undo.push(() => tool.close());
    const nowhere = tool.connect("ws://nowhere:7790/myco-debug", 5);
    tool.poll();
    expect(nowhere.state).toBe("failed");
    expect(nowhere.reason).toContain("Nothing is listening");
    const { build } = await listening();
    const cancelled = tool.connect(build!.address, 1);
    cancelled.cancel();
    expect(cancelled.state).toBe("failed");
    expect(tool.peers).toEqual([]);
  });
});

/** A listening tool with a gate, and a build that connects out to it with `code`. */
async function toolListening(code: (gate: TokenGate) => string | null, sameMachine = false) {
  const c = clock();
  const gate = new TokenGate({ now: c.now, randomToken: c.randomToken });
  const peers: DebugLinkPeer[] = [];
  const listener = new DebugLinkListener(createTransport("loopback", { now: c.now }), { onPeer: (p) => peers.push(p) }, { gate, sameMachine: () => sameMachine });
  undo.push(() => listener.close());
  const address = `ws://studio-${Math.round(c.randomToken(20))}:7790/myco-debug`;
  await listener.listen(address);
  const engine = await Engine.create({ headless: true });
  undo.push(() => engine.dispose());
  const lines: string[] = [];
  const handle = (await startDebugLink(engine, { debug: { link: address }, name: "Phone game", platform: "android", kind: "native", code: code(gate), transport: "loopback", transportOptions: { now: c.now }, log: (l) => lines.push(l) }))!;
  const round = (n = 1) => {
    for (let i = 0; i < n; i++) {
      engine.step(1 / 60);
      listener.poll();
    }
  };
  return { c, gate, listener, peers, engine, handle, lines, round };
}

const codeOf = (gate: TokenGate) => encodePairCode({ kind: "address", octets: [1, 30], portOffset: 0, token: gate.current().token });

describe("a build that connects out to a listening tool", () => {
  it("pairs with the tool's code: the peer arrives accepted (no prompt) and the tool shows its next code", async () => {
    const { gate, peers, handle, round } = await toolListening(codeOf);
    const serial = gate.current().serial;
    round();
    expect(peers).toHaveLength(1);
    expect(peers[0]!.state).toBe("accepted");
    expect(peers[0]!.admission).toBe("token");
    expect(peers[0]!.pair).toEqual({ role: "build", kind: "native", token: expect.any(Number), name: "Phone game" });
    expect(peers[0]!.hello).toMatchObject({ name: "Phone game", platform: "android" });
    round();
    expect(handle.state).toBe("accepted");
    expect(gate.current().serial).toBe(serial + 1);
  });

  it("without a code, a build from another machine arrives pending, for the tool's prompt", async () => {
    const { peers, round } = await toolListening(() => null);
    round();
    expect(peers[0]!.state).toBe("pending");
    expect(peers[0]!.admission).toBe("prompt");
  });

  it("without a code, a same-machine build is paired as such and left to the tool, as before", async () => {
    const { peers, round } = await toolListening(() => null, true);
    round();
    expect(peers[0]!.admission).toBe("same-machine");
    expect(peers[0]!.state).toBe("pending");
  });

  it("stops trying after a refusal (a wrong code): it says why, and the tool never sees a peer", async () => {
    const { peers, handle, lines, round } = await toolListening((gate) => encodePairCode({ kind: "address", octets: [1, 30], portOffset: 0, token: (gate.current().token + 1) % 2 ** 30 }));
    round(2);
    expect(peers).toEqual([]);
    expect(handle.state).toBe("closed");
    expect(lines.join("\n")).toContain("That code doesn't match");
    round(RECONNECT_SECONDS * 3 * 60); // three reconnect periods of frames
    expect(peers).toEqual([]);
  });

  it("reconnects after the tool goes away, without the spent token (the tool's prompt decides)", async () => {
    const { c, peers, round } = await toolListening(codeOf);
    round(2);
    expect(peers[0]!.admission).toBe("token");
    peers[0]!.close("The Studio disconnected.");
    for (let t = 0; t <= RECONNECT_SECONDS + 0.5; t += 0.25) {
      c.step(250);
      for (let i = 0; i < 15; i++) round();
    }
    expect(peers).toHaveLength(2);
    expect(peers[1]!.admission).toBe("prompt");
    expect(peers[1]!.pair?.token).toBeUndefined();
  });

  it("logs a code that doesn't read as one and connects without it", async () => {
    const { peers, lines, round } = await toolListening(() => "not a code!");
    round();
    expect(lines.join("\n")).toContain("isn't a pairing code");
    expect(peers[0]!.admission).toBe("prompt");
  });

  it("a build that says hello first (no pair) is still read as a tokenless build: pending, no pair", async () => {
    const c = clock();
    const peers: DebugLinkPeer[] = [];
    const listener = new DebugLinkListener(createTransport("loopback", { now: c.now }), { onPeer: (p) => peers.push(p) }, { gate: new TokenGate({ now: c.now, randomToken: c.randomToken }), sameMachine: () => false });
    undo.push(() => listener.close());
    await listener.listen("old-build-door");
    const t = createTransport("loopback", { now: c.now });
    undo.push(() => t.close());
    const session = new DebugLinkSession({ transport: t, connection: t.connect("old-build-door"), hello: { name: "Old", platform: "web", topics: [] }, topics: new Map() });
    session.frameStart();
    listener.poll();
    expect(peers).toHaveLength(1);
    expect(peers[0]!.state).toBe("pending");
    expect(peers[0]!.pair).toBeNull();
    expect(peers[0]!.admission).toBeNull();
    peers[0]!.accept();
    session.frameStart();
    expect(session.state).toBe("accepted");
  });

  it("a tool connecting to a listening tool is refused with role", async () => {
    const c = clock();
    const listener = new DebugLinkListener(createTransport("loopback", { now: c.now }), {});
    undo.push(() => listener.close());
    await listener.listen("tool-door");
    const tool = new ToolConnector(createTransport("loopback", { now: c.now }), { kind: "native" });
    undo.push(() => tool.close());
    const attempt = tool.connect("tool-door");
    tool.poll();
    listener.poll();
    tool.poll();
    expect(attempt.state).toBe("refused");
    expect(attempt.refusal?.reason).toBe("role");
  });
});
