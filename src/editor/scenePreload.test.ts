// ADR 0080: the scene's warm-up preload list in the editor. Saving keeps `settings.preload`, the
// Inspector's edits are one undoable step each, and the message log finds the file a warm-up
// warning names.
import { describe, expect, it } from "vitest";
import { CommandStack, SceneDocument, SetScenePreload, type SceneFile } from "./document";
import { formatSceneJSON } from "./document/format";
import { addToPreload, preloadCandidates, preloadSuggestion, removeFromPreload } from "./scenePreload";

const file = (settings?: SceneFile["settings"]): SceneFile => ({ format: "myco.scene@4", ...(settings ? { settings } : {}), nodes: [{ id: "a", name: "A" }] }) as SceneFile;

describe("the scene's preload list in the editor (ADR 0080)", () => {
  it("is kept when the scene is saved", () => {
    const doc = new SceneDocument(file({ physics: "3d", preload: ["prefabs/boss.prefab.json"] }), "s.scene.json");
    expect(doc.preload).toEqual(["prefabs/boss.prefab.json"]);
    const text = formatSceneJSON(doc.toJSON());
    expect(JSON.parse(text).settings).toEqual({ physics: "3d", preload: ["prefabs/boss.prefab.json"] });
  });

  it("is set by one undoable command that keeps the file's key order", () => {
    const doc = new SceneDocument(file(), "s.scene.json");
    const stack = new CommandStack(doc);
    stack.execute(new SetScenePreload(["asset:prefabs/a.prefab.json", "prefabs/a.prefab.json", " materials/m.material.json "]));
    expect(doc.preload).toEqual(["prefabs/a.prefab.json", "materials/m.material.json"]); // bare, trimmed, once each
    expect(Object.keys(doc.toJSON())).toEqual(["format", "settings", "nodes"]); // settings before nodes
    stack.undo();
    expect(doc.toJSON()).toEqual(file());
    // Emptying the list removes the key, and settings with it when nothing else is there; other settings stay.
    const kept = new SceneDocument(file({ physics: "2d", preload: ["prefabs/a.prefab.json"] }), "t.scene.json");
    new CommandStack(kept).execute(new SetScenePreload([]));
    expect(kept.toJSON().settings).toEqual({ physics: "2d" });
    const gone = new SceneDocument(file({ preload: ["prefabs/a.prefab.json"] }), "u.scene.json");
    new CommandStack(gone).execute(new SetScenePreload([]));
    expect("settings" in gone.toJSON()).toBe(false);
  });

  it("adds and removes paths, only prefabs and materials, each once", () => {
    const doc = new SceneDocument(file(), "s.scene.json");
    const scene = { doc, stack: new CommandStack(doc) };
    expect(addToPreload(scene, "prefabs/boss.prefab.json")).toBe(true);
    expect(addToPreload(scene, "asset:prefabs/boss.prefab.json")).toBe(false); // already there
    expect(addToPreload(scene, "images/a.png")).toBe(false);
    expect(addToPreload(scene, "materials/glow.material.json")).toBe(true);
    expect(doc.preload).toEqual(["prefabs/boss.prefab.json", "materials/glow.material.json"]);
    removeFromPreload(scene, "prefabs/boss.prefab.json");
    expect(doc.preload).toEqual(["materials/glow.material.json"]);
    expect(scene.stack.undoLabel).toBe("Remove from Preload List");
    expect(preloadCandidates(["b.prefab.json", "a.png", "m.material.json", "g.shadergraph.json"])).toEqual(["b.prefab.json", "m.material.json"]);
  });

  it("finds the file a warm-up warning names: the prefab, else the material asset", () => {
    // The warm-up's variant report words them so (`warmUpChecks.test.ts` checks its side).
    const warning = (what: string, name: string, fix: string) => `[myco] ${what} drew a shader variant that wasn't warmed up (${name}: +ALPHABLEND), so its frame waited for the shader to compile. ${fix}, or SceneManager.preload it, or report the rule the warm-up is missing (ADR 0080).`;
    const fromPrefab = warning('"Splash" (from prefabs/splash.prefab.json)', "asset:materials/splash.material.json", "Add prefabs/splash.prefab.json to the scene's settings.preload list");
    expect(preloadSuggestion(fromPrefab)).toBe("prefabs/splash.prefab.json");
    const fromMaterial = warning('"Rock"', "materials/rock.material.json", "Add materials/rock.material.json to the scene's settings.preload list");
    expect(preloadSuggestion(fromMaterial)).toBe("materials/rock.material.json");
    const builtIn = warning('"Cube"', "builtin:lit", "Add its prefab to the scene's settings.preload list");
    expect(preloadSuggestion(builtIn)).toBeNull(); // nothing to add: the text says to add its prefab
    expect(preloadSuggestion("[myco] something else")).toBeNull();
  });
});
