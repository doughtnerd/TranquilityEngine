// The shell's one Project Settings section (ADR 0151, ADR 0173): the draft, undo history and save hooks the Project
// Settings panel and the SDK's `editor.project.settings` share, so an edit or undo in either is one step in the same
// history and the save hooks run once. Saves reload the editor's graphics tiers and re-apply plugins turned on or off.
// Kept outside any component, since a hidden tab unmounts.
//
// `session.ts` loads the plugins, whose editor halves import the SDK, which imports this module: a static import of it
// here would close that loop, and a plugin test importing the SDK first would see the SDK half-loaded. So re-applying
// plugins reaches `session.ts` on demand (it's loaded long before any save in the editor), as `assetKinds.builtin.ts` does.
import { reloadGraphics } from "./graphicsPreview";
import { createProjectSettingsSection } from "./projectSettingsSection";

const reapplyPlugins = (): void => void import("./session").then((m) => m.reapplyPlugins());

export const projectSettings = createProjectSettingsSection({ graphicsSaved: reloadGraphics, pluginsChanged: reapplyPlugins });
