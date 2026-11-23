// The graph editor's registration (T51): `*.animgraph.json` files open in the Animation Graph panel, the kind has its
// Inspector summary, the panel and the rig gizmo tool are registered, and an edit through the file's asset document is
// one labelled undo step that the file gets.
import { afterEach, describe, expect, it } from "vitest";
import { assetKinds, panels, viewportTools } from "../../../../editor/sdk/contributions";
import { applyToDocument, editor, openAssetDocument } from "../../../../editor/sdk";
import { closeTestProject, openTestProject } from "../../../../editor/testing";
import { emptyAnimGraph, formatAnimGraph, parseAnimGraph, type AnimGraph } from "../../../../engine/animation/animGraph";
import { useEditorPlugins } from "../../../testEditorPlugins";
import { animationEditorPlugin } from "..";
import { addNode } from "./graphEditLogic";
import { ANIM_GRAPH_PANEL } from "./panelId";

useEditorPlugins([animationEditorPlugin]);
afterEach(() => closeTestProject());

const GRAPH = "animation/loco.animgraph.json";

describe("the Animation Graph panel (T51)", () => {
  it("is where graphs open; the kind has its Inspector summary; the rig gizmos are a viewport tool", async () => {
    await openTestProject({ [GRAPH]: formatAnimGraph(emptyAnimGraph()) });
    expect(panels.get(ANIM_GRAPH_PANEL)?.title).toBe("Animation Graph");
    expect(assetKinds.get("animgraph")?.panel).toBe(ANIM_GRAPH_PANEL);
    expect(typeof (await assetKinds.get("animgraph")!.inspector!())).toBe("function");
    expect(typeof (await panels.get(ANIM_GRAPH_PANEL)!.view())).toBe("function");
    expect(viewportTools.get("myco.animation.rig")?.id).toBe("myco.animation.rig");
    expect(editor.assets.open(GRAPH)).toBe(true);
    expect(editor.assets.openIn(ANIM_GRAPH_PANEL)).toBe(GRAPH);
  });

  it("applies an edit as one labelled undo step of the graph's document, written to the file", async () => {
    const { project } = await openTestProject({ [GRAPH]: formatAnimGraph(emptyAnimGraph()) });
    const doc = openAssetDocument<AnimGraph>(project, GRAPH);
    const r = addNode(doc.value.value, "sources", "clipPlayer", [10, 20], { clip: "asset:clips/walk.anim.json" });
    expect(applyToDocument(doc, "refused" in r ? r : { next: r.next.graph }, "Add Clip Player")).toBe(true);
    expect(doc.undoLabel.value).toBe("Add Clip Player");
    await doc.flush();
    const written = parseAnimGraph(project.assets.get(GRAPH));
    expect(written.problems).toEqual([]);
    expect(written.value.nodes.map((n) => n.id)).toEqual(["clipPlayer"]);
    doc.undo();
    expect(doc.value.value.nodes).toEqual([]);
  });
});
