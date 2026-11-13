import { afterEach, describe, expect, it } from "vitest";
import type { ApplyResult, MixOp } from "../../../../engine/audio/mixOps";
import { createProjectSettingsSection } from "../../../../editor/projectSettingsSection";
import { setValue, type SettingsDraft } from "../../../../editor/projectSettingsModel";
import { onSectionChanged, type SectionChange } from "../../../../editor/sectionChanged";
import { editor } from "../../../../editor/sdk";
import { closeTestProject, openTestProject } from "../../../../editor/testing";
import { createOpLog, opsOf, recordMixOps, type MixApplier, type OpLogHost } from "./opLog";

const PROJECT = `{
  "name": "Game",
  "audio": { "buses": [{ "name": "master" }, { "name": "sfx", "parent": "master" }] }
}
`;

class FakeMixer implements MixApplier {
  applied: MixOp[] = [];
  apply(op: MixOp): ApplyResult {
    this.applied.push(op);
    return { ok: false, class: "none", restartRequired: "no live audio backend" };
  }
}

const unsubs: Array<() => void> = [];
afterEach(() => {
  while (unsubs.length) unsubs.pop()!();
  closeTestProject();
});

const sfxVolume = (d: SettingsDraft, volume: number) => {
  const audio = d.audio as { buses: Array<Record<string, unknown>> };
  return { ...d, audio: { ...audio, buses: audio.buses.map((b) => (b.name === "sfx" ? { ...b, volume } : b)) } } as SettingsDraft;
};

function host(playing: () => boolean, mixer: FakeMixer | null): OpLogHost {
  return { onSectionChanged: (k, l) => (unsubs.push(onSectionChanged(k, l)), unsubs[unsubs.length - 1]), isPlaying: playing, mixer: () => mixer };
}

describe("editor.project.onSectionChanged", () => {
  it("fires synchronously for an edit, an undo and a redo, with before and after", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const s = createProjectSettingsSection().open(project);
    const seen: SectionChange[] = [];
    unsubs.push(editor.project.onSectionChanged("audio", (c) => seen.push(c)));
    const first = s.draft.audio;
    const p = s.edit("Volume", sfxVolume(s.draft, 0.5));
    expect(seen).toHaveLength(1); // before the write resolves
    await p;
    expect(seen[0].cause).toBe("edit");
    expect(seen[0].before).toBe(first);
    const second = s.draft.audio;
    expect(seen[0].after).toBe(second);
    const u = s.undo();
    expect(seen).toHaveLength(2);
    await u;
    expect(seen[1]).toMatchObject({ cause: "undo", before: second, after: first });
    await s.redo();
    expect(seen[2]).toMatchObject({ cause: "redo", before: first, after: second });
  });

  it("ignores other keys, unsubscribes, and never fires for an invalid draft", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const s = createProjectSettingsSection().open(project);
    const seen: SectionChange[] = [];
    const off = editor.project.onSectionChanged("audio", (c) => seen.push(c));
    await s.edit("Width", setValue(s.draft, "display", "width", 320));
    expect(seen).toHaveLength(0);
    // an audio change inside an invalid draft (display width < 0)
    await s.edit("Both", { ...sfxVolume(s.draft, 0.25), display: { width: -5, height: 10 } } as SettingsDraft);
    expect(seen).toHaveLength(0);
    await s.edit("Fix", sfxVolume(s.draft, 0.25)); // still invalid display: stays silent
    expect(seen).toHaveLength(0);
    await s.edit("Fix display", { ...s.draft, display: { width: 320, height: 10 } } as SettingsDraft);
    expect(seen).toHaveLength(1); // the audio change made while invalid arrives with the first valid draft
    expect((seen[0].after as { buses: Array<{ volume?: number }> }).buses[1].volume).toBe(0.25);
    off();
    await s.edit("Again", sfxVolume(s.draft, 0.75));
    expect(seen).toHaveLength(1);
  });

  it("isolates a throwing listener", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const s = createProjectSettingsSection().open(project);
    const seen: SectionChange[] = [];
    const err = console.error;
    console.error = () => {};
    try {
      unsubs.push(editor.project.onSectionChanged("audio", () => { throw new Error("boom"); }));
      unsubs.push(editor.project.onSectionChanged("audio", (c) => seen.push(c)));
      await s.edit("Volume", sfxVolume(s.draft, 0.5));
    } finally {
      console.error = err;
    }
    expect(seen).toHaveLength(1);
  });
});

describe("the audio op log", () => {
  it("hands edit, undo and redo to the mixer while playing", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const s = createProjectSettingsSection().open(project);
    const mixer = new FakeMixer();
    const log = createOpLog(host(() => true, mixer));
    await s.edit("Volume", sfxVolume(s.draft, 0.5));
    expect(mixer.applied).toEqual([{ op: "setBus", bus: "sfx", key: "volume", value: 0.5 }]);
    await s.undo();
    expect(mixer.applied[1]).toMatchObject({ op: "setBus", bus: "sfx", key: "volume" });
    expect((mixer.applied[1] as { value: number }).value).not.toBe(0.5);
    await s.redo();
    expect(mixer.applied[2]).toEqual(mixer.applied[0]);
    expect(log.entries.map((e) => e.cause)).toEqual(["edit", "undo", "redo"]);
    expect(log.entries[0].results[0].restartRequired).toBeTruthy();
    log.dispose();
  });

  it("uses the ops an edit recorded, for edit, redo and (the inverse) undo", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const s = createProjectSettingsSection().open(project);
    const mixer = new FakeMixer();
    createOpLog(host(() => true, mixer));
    const next = sfxVolume(s.draft, 0.5);
    const ops: MixOp[] = [{ op: "setBus", bus: "sfx", key: "volume", value: 0.5 }];
    const inverse: MixOp[] = [{ op: "setBus", bus: "sfx", key: "volume", value: 1 }];
    recordMixOps(next.audio as object, { ops, inverse });
    await s.edit("Volume", next);
    await s.undo();
    await s.redo();
    expect(mixer.applied).toEqual([...ops, ...inverse, ...ops]);
  });

  it("sends nothing outside Play, and nothing when no mixer is up", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const s = createProjectSettingsSection().open(project);
    const mixer = new FakeMixer();
    let playing = false;
    const log = createOpLog(host(() => playing, mixer));
    await s.edit("Volume", sfxVolume(s.draft, 0.5));
    await s.undo();
    expect(mixer.applied).toEqual([]);
    expect(log.entries).toEqual([]);
    const none = createOpLog(host(() => true, null));
    playing = true;
    await s.redo();
    expect(none.entries).toEqual([]);
    expect(mixer.applied).toHaveLength(1);
  });

  it("never sends an invalid draft", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const s = createProjectSettingsSection().open(project);
    const mixer = new FakeMixer();
    createOpLog(host(() => true, mixer));
    await s.edit("Bad", { ...sfxVolume(s.draft, 0.5), display: { width: -5, height: 10 } } as SettingsDraft);
    expect(mixer.applied).toEqual([]);
  });

  it("G9b: an edit with no live op but a key with no live path (the AAC codec) is an entry with that key, for edit, undo and redo", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const s = createProjectSettingsSection().open(project);
    const mixer = new FakeMixer();
    const log = createOpLog(host(() => true, mixer));
    const audio = s.draft.audio as Record<string, unknown>;
    await s.edit("Enable AAC", { ...s.draft, audio: { ...audio, codecs: { aac: true } } } as SettingsDraft);
    await s.undo();
    await s.redo();
    expect(mixer.applied, "no op reaches the mixer").toEqual([]);
    expect(log.entries.map((e) => [e.cause, e.source, e.ops.length, e.restartRequired])).toEqual([
      ["edit", "diff", 0, ["codecs"]],
      ["undo", "diff", 0, ["codecs"]],
      ["redo", "diff", 0, ["codecs"]],
    ]);
    // An edit that changes nothing the mixer sees (no op, no key) still makes no entry.
    await s.edit("Width", setValue(s.draft, "display", "width", 320));
    expect(log.entries).toHaveLength(3);
  });

  it("a preview that calls the mixer directly never enters the log", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const s = createProjectSettingsSection().open(project);
    const mixer = new FakeMixer();
    const log = createOpLog(host(() => true, mixer));
    mixer.apply({ op: "setBus", bus: "sfx", key: "volume", value: 0.3 }); // a drag in progress
    expect(log.entries).toEqual([]);
    expect(s.canUndo).toBe(false);
  });

  it("diffs untagged changes, and stops after dispose", () => {
    const before = { buses: [{ name: "master" }, { name: "sfx", parent: "master" }] };
    const after = { buses: [{ name: "master" }, { name: "sfx", parent: "master", volume: 0.4 }] };
    expect(opsOf({ before, after, cause: "edit" })).toMatchObject({ source: "diff", ops: [{ op: "setBus", bus: "sfx", key: "volume", value: 0.4 }] });
    // recorded ops made from another base are not trusted
    const stale = { buses: [{ name: "master" }, { name: "sfx", parent: "master", volume: 0.4 }] };
    recordMixOps(stale, { ops: [], inverse: [] }, { other: true });
    expect(opsOf({ before, after: stale, cause: "edit" }).source).toBe("diff");
    recordMixOps(stale, { ops: [], inverse: [] }, before);
    expect(opsOf({ before, after: stale, cause: "edit" }).source).toBe("recorded");
    const mixer = new FakeMixer();
    const log = createOpLog(host(() => true, mixer));
    log.dispose();
    expect(log.entries).toEqual([]);
  });
});
