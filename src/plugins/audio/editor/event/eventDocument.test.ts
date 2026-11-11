// The Event editor's edits through the audio event's asset document (ADR 0133, 0158 §7): what the panel does on a tree
// edit, a property change and a slider drag, written to the file and undone in steps.
import { afterEach, describe, expect, it, vi } from "vitest";
import { _reset, openAssetDocument } from "../../../../editor/assetDocuments";
import { joinPath, openFolderProject } from "../../../../editor/projects";
import { currentProject } from "../../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../../editor/testing";
import { formatAudioEvent, emptyAudioEvent, type AudioEventAsset, type LayerNode } from "../../../../engine/audio/eventFormat";
import { useEditorPlugins } from "../../../testEditorPlugins";
import { audioEditorPlugin } from "..";
import { setNode } from "./EventTree";
import { findField, nodeFields, writeField } from "./nodeFields";
import { addNode } from "./treeActions";
import { applyClipDrop } from "./treeDrop";

useEditorPlugins([audioEditorPlugin], "each");
afterEach(() => {
  _reset();
  vi.useRealTimers();
});

const PATH = "e.audioevent.json";

async function openEvent() {
  const fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  fs.files.set(joinPath(ROOT, PATH), formatAudioEvent(emptyAudioEvent()));
  const project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
  const doc = openAssetDocument<AudioEventAsset>(project, PATH, "audioEvent");
  const file = () => JSON.parse(fs.files.get(joinPath(ROOT, PATH)) as string) as AudioEventAsset;
  return { doc, file };
}

describe("Event editor edits through the asset document", () => {
  it("a clip drop and a tree add are one undo step each, written to the file", async () => {
    const { doc, file } = await openEvent();
    const dropped = applyClipDrop(doc.value.value.root, { parent: [], index: 0 }, ["sfx/a.ogg", "sfx/b.ogg"]);
    if (typeof dropped === "string") throw new Error(dropped);
    doc.edit({ ...doc.value.value, root: dropped.root }, { label: "Add clips" });
    const added = addNode(doc.value.value.root, null, "random");
    if (typeof added === "string") throw new Error(added);
    doc.edit({ ...doc.value.value, root: added.root }, { label: "Add random" });
    await doc.flush();
    expect((file().root as LayerNode).children.map((c) => c.type)).toEqual(["clip", "clip", "random"]);
    expect(doc.undoLabel.value).toBe("Add random");
    doc.undo();
    await doc.flush();
    expect((file().root as LayerNode).children).toHaveLength(2);
    doc.undo();
    await doc.flush();
    expect((file().root as LayerNode).children).toHaveLength(0);
  });

  it("a slider drag coalesces into one step", async () => {
    vi.useFakeTimers();
    const { doc } = await openEvent();
    const root = doc.value.value.root;
    const volume = findField(nodeFields(root, null), "volume")!;
    for (const v of [0.9, 0.8, 0.7]) doc.edit({ ...doc.value.value, root: setNode(doc.value.value.root, [], writeField(doc.value.value.root, volume, v)) }, { coalesce: true, label: "Edit volume" });
    vi.advanceTimersByTime(500);
    await doc.flush();
    expect(doc.value.value.root.volume).toBe(0.7);
    doc.undo();
    await doc.flush();
    expect(doc.value.value.root.volume).toBe(1);
  });
});
