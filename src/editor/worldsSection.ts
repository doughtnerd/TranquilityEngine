// The Worlds panel's project section (ADR 0032, 0062, 0151): `project.json`'s `bootstrap`, as a graph
// model while it's one the panel can draw. A code bootstrap or one that can't be drawn is kept as written
// and never saved from here.
import { listSystemCatalog } from "../engine/core/systems";
import { createProjectSection, type ProjectSection } from "./projectSection";
import { modelProblems, modelToConfig, readBootstrap, type BootstrapView, type WorldsModel } from "./worldsConfig";

/** The Worlds panel's draft: the bootstrap as the panel sees it, and as written (kept for views it can't edit). */
export interface WorldsDraft {
  readonly view: BootstrapView;
  readonly raw: unknown;
}

/** The draft after editing the graph: written out, even if it was the implicit default before. */
export const editedWorlds = (model: WorldsModel): WorldsDraft => ({ view: { kind: "graph", model, explicit: true }, raw: undefined });

/** The bootstrap a draft writes: undefined while it's still the implicit default. */
function bootstrapOf(draft: WorldsDraft): unknown {
  const view = draft.view;
  if (view.kind !== "graph") return draft.raw;
  return view.explicit ? modelToConfig(view.model) : undefined;
}

export function createWorldsSection(): ProjectSection<WorldsDraft> {
  return createProjectSection<WorldsDraft>({
    name: "Worlds",
    what: "the Worlds",
    keys: () => ["bootstrap"],
    read: (values) => ({ view: readBootstrap(values.bootstrap), raw: values.bootstrap }),
    write: (draft) => ({ bootstrap: bootstrapOf(draft) }),
    // Invalid graphs stay in the panel, unsaved (play mode would refuse them); other views are never written.
    problems: (draft) => (draft.view.kind === "graph" ? modelProblems(draft.view.model, listSystemCatalog()) : ["The bootstrap isn't a graph the Worlds panel edits."]),
  });
}
