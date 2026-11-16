// The shell's one Worlds section (ADR 0151), beside the Project Settings one (`projectSettingsInstance.ts`, ADR 0173):
// `project.json`'s `bootstrap` as a draft with one undo history, which every copy of the Worlds panel views, so an
// edit or undo in one is one step in the same history. Kept outside any component, since a hidden tab unmounts.
import { createWorldsSection } from "./worldsSection";

export const worlds = createWorldsSection();
