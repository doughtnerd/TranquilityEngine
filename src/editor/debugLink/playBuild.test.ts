// The editor's Play as a build (ADR 0403, plan U3) over loopback: a headless Engine stands in for the play Engine, a
// `ToolConnector` (the Audio Studio) pairs with it by its code, asks one of its topics something, and sees it go when
// Play stops (or the Engine ends). The code changes after a pairing; the slot shows the code and the paired tools.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VNode } from "preact";
import { Engine } from "../../myco";
import { createTransport } from "../../engine/net/Transport";
import "../../engine/net/transport/loopback";
import { ToolConnector, type DebugLinkPeer } from "../../engine/debugLink/client";
import { decodePairCode } from "../../engine/debugLink/pairing/code";
import { registerDebugTopic } from "../../engine/debugLink/topics";
import { PlayBuildSlot, servePlayBuild, type PlayBuild, type PlayBuildOptions } from "./playBuild";

const undo: (() => void)[] = [];
afterEach(() => {
  for (const u of undo.splice(0).reverse()) u();
});

const LAN = [{ address: "192.168.1.20", family: "IPv4" as const }];

/** A play Engine served as a build with a `probe` topic, and the Studio's connector on the same clock. */
async function play(options: PlayBuildOptions = {}) {
  let t = 1000;
  let seed = 0;
  const now = () => t;
  undo.push(registerDebugTopic("probe", async () => () => ({ subscribe: () => ({ refused: "no" }), request: (method, params) => ({ method, params }) })));
  const engine = await Engine.create({ headless: true });
  undo.push(() => engine.dispose());
  const lines: string[] = [];
  const build = servePlayBuild(engine, "Flappy (editor Play)", {
    transport: "loopback",
    transportOptions: { now },
    lan: true,
    interfaces: () => LAN,
    sameMachine: () => false,
    now,
    randomToken: (bits) => (++seed * 104_729) % 2 ** bits,
    log: (l) => lines.push(l),
    ...options,
  });
  undo.push(() => build.stop());
  const peers: DebugLinkPeer[] = [];
  const closed: DebugLinkPeer[] = [];
  const tool = new ToolConnector(createTransport("loopback", { now }), { kind: "native", name: "Audio Studio on DESKTOP-1", events: { onPeer: (p) => peers.push(p), onClose: (p) => closed.push(p) } });
  undo.push(() => tool.close());
  const round = (n = 1) => {
    for (let i = 0; i < n; i++) {
      tool.poll();
      engine.step(1 / 60);
      tool.poll();
    }
  };
  return { engine, build, tool, peers, closed, round, lines, step: (ms: number) => void (t += ms) };
}

/** Waits for the listener to come up (it loads the topics first). */
async function serving(build: PlayBuild): Promise<string> {
  await vi.waitFor(() => expect(build.state.value.kind).not.toBe("starting"));
  const s = build.state.value;
  if (s.kind !== "serving") throw new Error(`not serving: ${JSON.stringify(s)}`);
  return s.address;
}

const tokenOf = (code: string | null) => {
  const read = decodePairCode(code ?? "");
  if (!("code" in read)) throw new Error(read.refused);
  return read.code.token;
};

/** Every string in a rendered vnode tree, in order. */
function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  return text((node as VNode<{ children?: unknown }>).props.children);
}

describe("the editor's Play as a build", () => {
  it("listens from the port after the editor's and shows a code for its LAN address", async () => {
    const { build } = await play();
    expect(build.state.value).toEqual({ kind: "starting" });
    const address = await serving(build);
    expect(address).toBe("ws://0.0.0.0:7791/myco-debug");
    expect(decodePairCode(build.code.value!)).toEqual({ code: { kind: "address", octets: [1, 20], portOffset: 1, token: expect.any(Number) } });
    expect(build.tools.value).toEqual([]);
  });

  it("pairs a tool by its code, answers its request from the play Engine's topic, and shows the next code", async () => {
    const { build, tool, peers, round } = await play();
    const address = await serving(build);
    const first = build.code.value;
    const attempt = tool.connect(address, tokenOf(first));
    round(3);
    expect(attempt.state).toBe("paired");
    expect(peers[0]!.hello).toMatchObject({ name: "Flappy (editor Play)", platform: "editor" });
    expect(peers[0]!.hello.topics).toContain("probe");
    expect(build.tools.value).toEqual([{ name: "Audio Studio on DESKTOP-1", kind: "native", remote: expect.any(String) }]);
    expect(build.code.value).not.toBe(first); // spent: the next tool needs the next code
    const answer = peers[0]!.request("probe", "ping", { n: 1 });
    round(2);
    await expect(answer).resolves.toEqual({ method: "ping", params: { n: 1 } });
  });

  it("refuses a tokenless tool from another machine (nobody to ask), and asks when given a prompt", async () => {
    const refused = await play();
    const attempt = refused.tool.connect(await serving(refused.build));
    refused.round(3);
    expect(attempt.state).toBe("refused");
    expect(attempt.refusal?.reason).toBe("no-token");
    for (const u of undo.splice(0).reverse()) u();

    const asked: string[] = [];
    const prompted = await play({ port: 7795, prompt: async (t) => (asked.push(t.name ?? ""), true) });
    const yes = prompted.tool.connect(await serving(prompted.build));
    prompted.round(2);
    await Promise.resolve();
    prompted.round(2);
    expect(asked).toEqual(["Audio Studio on DESKTOP-1"]);
    expect(yes.state).toBe("paired");
  });

  it("closes the tools' sessions when Play stops", async () => {
    const { build, tool, peers, closed, round } = await play();
    tool.connect(await serving(build), tokenOf(build.code.value));
    round(3);
    expect(peers).toHaveLength(1);
    build.stop();
    round();
    expect(closed).toEqual(peers);
    expect(peers[0]!.state).toBe("closed");
    expect(build.state.value).toEqual({ kind: "stopped" });
    expect(build.code.value).toBeNull();
    expect(build.tools.value).toEqual([]);
  });

  it("stops with the play Engine", async () => {
    const { engine, build, tool, peers, round } = await play();
    tool.connect(await serving(build), tokenOf(build.code.value));
    round(3);
    engine.dispose();
    tool.poll();
    expect(peers[0]!.state).toBe("closed");
    expect(build.state.value).toEqual({ kind: "stopped" });
  });

  it("stopped before it listens, it closes the listener as it arrives (the port is free again)", async () => {
    const { build } = await play();
    build.stop();
    await vi.waitFor(async () => {
      const again = await play();
      expect(await serving(again.build)).toBe("ws://0.0.0.0:7791/myco-debug");
    });
  });

  it("shows no code on this machine only, and says where tools connect", async () => {
    const { build } = await play({ lan: false });
    expect(await serving(build)).toBe("ws://127.0.0.1:7791/myco-debug");
    expect(build.code.value).toBeNull();
    expect(text(PlayBuildSlot({ build }))).toContain("Play is open to tools on this machine at localhost:7791.");
  });

  it("is unavailable where nothing can listen", async () => {
    const { build } = await play({ transport: null });
    expect(build.state.value.kind).toBe("unavailable");
    expect(text(PlayBuildSlot({ build }))).toContain("a browser page can't open a server socket");
  });

  it("the slot shows the code and the paired tools, and nothing without a Play", async () => {
    const { build, tool, round } = await play();
    expect(text(PlayBuildSlot({ build }))).toContain("Opening Play to tools");
    tool.connect(await serving(build), tokenOf(build.code.value));
    round(3);
    const shown = text(PlayBuildSlot({ build }));
    expect(shown).toContain(`pair with code ${build.code.value}`);
    expect(shown).toContain("Paired: Audio Studio on DESKTOP-1");
    expect(PlayBuildSlot({ build: null })).toBeNull();
  });
});
