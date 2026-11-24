// The Mixer's remote edits through `createRemoteMix`: a loopback link to a headless build serving the real `audio`
// topic (the setup of the plugin's `linkSmoke.test.ts`); a bus volume edit is applied on the build, an unknown bus is
// refused by it and reported, and with no build nothing is sent.
import { afterEach, describe, expect, it } from "vitest";
import { Assets, Engine, SceneManager } from "../../../myco";
import type { MixOp } from "../../../engine/audio/mixOps";
import { createTransport } from "../../../engine/net/Transport";
import "../../../engine/net/transport/loopback";
import { ToolConnector, type DebugLinkPeer } from "../../../engine/debugLink/client";
import { startBuildListener } from "../../../engine/debugLink/host";
import { decodePairCode } from "../../../engine/debugLink/pairing/code";
import { setAudioBackend } from "../../../plugins/audio/runtime/backend";
import { makeFakeBackend } from "../../../plugins/audio/runtime/testing";
import type { ConnectedBuild } from "../../../editor/debugLink/editorLink";
import { createRemoteMix } from "./remoteMix";

const undo: (() => void)[] = [];
afterEach(() => {
  for (const u of undo.splice(0).reverse()) u();
  setAudioBackend(null);
});

const busVolume = (bus: string, value: number): MixOp => ({ op: "setBus", bus, key: "volume", value });

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** A headless build serving the audio topic, and the Studio's end of its link as a `ConnectedBuild`. */
async function rig() {
  let seed = 0;
  const now = () => 1000;
  const randomToken = (bits: number) => (++seed * 104_729) % 2 ** bits;
  const fb = makeFakeBackend();
  fb.ready = true;
  setAudioBackend(fb);
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }, { name: "Music", parent: "Master" }] } } });
  undo.push(() => engine.dispose());
  await SceneManager.load("s.json");
  const handle = await startBuildListener(engine, {
    debug: { listen: true, lan: true },
    name: "Smoke game",
    transport: "loopback",
    transportOptions: { now },
    interfaces: () => [{ address: "192.168.1.20", family: "IPv4" as const }],
    sameMachine: () => false,
    now,
    randomToken,
  });
  undo.push(() => handle!.close());
  const peers: DebugLinkPeer[] = [];
  const tool = new ToolConnector(createTransport("loopback", { now }), { kind: "native", name: "Studio", events: { onPeer: (p) => peers.push(p) } });
  undo.push(() => tool.close());
  const round = () => {
    tool.poll();
    engine.step(1 / 60);
    tool.poll();
  };
  const read = decodePairCode(handle!.code!);
  if (!("code" in read)) throw new Error(read.refused);
  tool.connect(handle!.address, read.code.token);
  for (let i = 0; i < 4; i++) {
    round();
    await settle();
  }
  const build: ConnectedBuild = { id: 1, name: "Smoke game", platform: "desktop", remote: handle!.address, peer: peers[0]! };
  return { build, round, fb };
}

describe("remote mix", () => {
  it("applies a bus volume edit on the connected build", async () => {
    const { build, round, fb } = await rig();
    const reports: string[] = [];
    const remote = createRemoteMix({ build: () => build, report: (_k, t) => reports.push(t) });
    expect(remote.send([busVolume("Music", 0.25)])).toBe(1);
    round();
    expect(fb.ops).toEqual([busVolume("Music", 0.25)]);
    expect(reports).toEqual([]);
  });

  it("reports the build's refusal of an unknown bus", async () => {
    const { build, round } = await rig();
    const reports: { kind: string; text: string }[] = [];
    const remote = createRemoteMix({ build: () => build, report: (kind, text) => reports.push({ kind, text }) });
    remote.send([busVolume("Nope", 0.5)]);
    round();
    round();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.kind).toBe("error");
    expect(reports[0]!.text).toMatch(/Smoke game refused the change: .*Nope/);
  });

  it("sends nothing with no build connected", () => {
    const sent: string[] = [];
    const remote = createRemoteMix({ build: () => null, report: (_k, t) => sent.push(t) });
    expect(remote.send([busVolume("Music", 0.5)])).toBe(0);
    expect(sent).toEqual([]);
  });
});
