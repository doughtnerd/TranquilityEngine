// The Inspector of a Tiled map or tileset or an LDtk project (ADR 0438): what it is, and Import as Myco assets…, which
// opens the import dialog (loaded on first use with the importer, so `fast-xml-parser` stays out of the first bundle).
import { editor } from "../../../../editor/sdk";
import "./tileImport.css";

const WHAT: Record<string, string> = {
  tiledmap: "A Tiled map. Myco doesn't read it at runtime: import it once as tilesets and a prefab.",
  tiledtileset: "A Tiled tileset. Myco doesn't read it at runtime: import it once as a Myco tileset (maps that use it import it too).",
  ldtkproject: "An LDtk project. Myco doesn't read it at runtime: import it once as tilesets and a prefab per level and world.",
};

export function ImportSourceInspector({ path }: { path: string }) {
  const kind = editor.assets.kindOf(path);
  const project = editor.project.current;
  return (
    <div class="tile-import-inspector">
      <span>{WHAT[kind] ?? "A file the Tilemaps plugin imports."}</span>
      <button
        class="primary"
        disabled={!project?.canSave}
        title={project?.canSave ? undefined : "This project is read-only."}
        onClick={() =>
          void import("./ImportDialog")
            .then((m) => m.openImportDialog(path))
            .then((written) => {
              const first = written.find((p) => p.endsWith(".prefab.json")) ?? written[0];
              if (first) editor.assets.reveal(first);
            })
        }
      >
        Import as Myco assets…
      </button>
    </div>
  );
}
