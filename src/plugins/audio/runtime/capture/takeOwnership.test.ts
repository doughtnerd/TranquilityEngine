// ADR 0417: take ownership through its own interface, over a fake take. Claims hand saving off; a take seen to stop under
// a claim is backed up once where the build keeps copies, however many claims see it and whether or not the trigger
// stopped it; a tool's start and stop go to the installed control, else to the take.
import { describe, expect, it } from "vitest";
import type { AudioTakeState } from "./take";
import { createTakeOwnership, type TakeControl } from "./takeOwnership";

function rig(backups = true) {
  const calls: string[] = [];
  const warnings: string[] = [];
  const take = {
    saveError: null as Error | null,
    async start() {
      calls.push("start");
    },
    stop() {
      calls.push("stop");
    },
    async save() {
      calls.push("save");
      if (take.saveError) throw take.saveError;
      return "take.sporesample";
    },
  };
  const ownership = createTakeOwnership({ take, backups: () => backups, warn: (t) => void warnings.push(t) });
  return { calls, warnings, take, ownership };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("take ownership", () => {
  it("hands saving off while any claim is held; a claim released twice counts once", () => {
    const { ownership } = rig();
    expect(ownership.handedOff()).toBe(false);
    const a = ownership.claim();
    const b = ownership.claim();
    a.release();
    a.release();
    expect(ownership.handedOff()).toBe(true);
    b.release();
    expect(ownership.handedOff()).toBe(false);
  });

  it("backs up each take seen to stop under a claim, once however many claims see it, and only a take it saw recording", async () => {
    const r = rig();
    const a = r.ownership.claim();
    const b = r.ownership.claim();
    const see = (s: AudioTakeState) => {
      a.observe(s);
      b.observe(s);
    };
    see("stopped"); // stopped before the claims: not theirs to back up
    see("recording");
    see("stopped");
    see("stopped");
    see("recording");
    see("stopped");
    await settle();
    expect(r.calls).toEqual(["save", "save"]);
    a.release();
    b.release();
  });

  it("keeps no copies where the build doesn't (a browser)", async () => {
    const r = rig(false);
    const claim = r.ownership.claim();
    claim.observe("recording");
    claim.observe("stopped");
    await expect(r.ownership.handOff()).resolves.toEqual({ copy: "none" });
    await settle();
    expect(r.calls).toEqual([]);
    claim.release();
  });

  it("a hand-off backs the take up at once and says how it went; the claim seeing that stop doesn't save it again", async () => {
    const r = rig();
    await expect(r.ownership.handOff(), "no claim: nothing is handed off").resolves.toEqual({ copy: "none" });
    const claim = r.ownership.claim();
    claim.observe("recording");
    await expect(r.ownership.handOff()).resolves.toEqual({ copy: "kept" });
    claim.observe("stopped");
    await settle();
    expect(r.calls).toEqual(["save"]);
    claim.observe("recording");
    r.take.saveError = new Error("the disk is full");
    await expect(r.ownership.handOff()).resolves.toEqual({ copy: "failed", reason: "the disk is full" });
    expect(r.warnings, "the trigger says so: no warning").toEqual([]);
    claim.release();
  });

  it("a backup no trigger asked for warns when it fails", async () => {
    const r = rig();
    r.take.saveError = new Error("the disk is full");
    const claim = r.ownership.claim();
    claim.observe("recording");
    claim.observe("stopped");
    await settle();
    expect(r.warnings).toEqual(["[myco] couldn't keep a copy of the take: the disk is full"]);
    claim.release();
  });

  it("a tool's start and stop go to the installed control, else straight to the take", async () => {
    const r = rig();
    const asked: string[] = [];
    const control: TakeControl = { start: async () => void asked.push("start"), stop: () => void asked.push("stop") };
    await r.ownership.startForTool();
    r.ownership.stopForTool();
    const remove = r.ownership.setControl(control);
    await r.ownership.startForTool();
    r.ownership.stopForTool();
    remove();
    await r.ownership.startForTool();
    expect(r.calls).toEqual(["start", "stop", "start"]);
    expect(asked).toEqual(["start", "stop"]);
  });

  it("removing a control that was since replaced leaves the newer one", async () => {
    const r = rig();
    const asked: string[] = [];
    const removeOld = r.ownership.setControl({ start: async () => void asked.push("old"), stop: () => {} });
    r.ownership.setControl({ start: async () => void asked.push("new"), stop: () => {} });
    removeOld();
    await r.ownership.startForTool();
    expect(asked).toEqual(["new"]);
  });
});
