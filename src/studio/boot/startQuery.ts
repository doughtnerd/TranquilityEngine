// What the Studio opens on start-up (ADR 0341): `?sample=<id>` a sample (read-only), `?project=<folder>` a project
// folder, else the start screen. The screen and asset come from the hash (`route.ts`, which reads the editor's
// `#/<screen>/<asset>` too). On the desktop the folder is a path; in a browser it is the path the editor's tab mounted
// the folder at (`/<folder name>`, FsaFileSystem), which a new tab can't open by itself: it is found among the recent
// projects' stored folder handles (`recentForMount`), which the editor added when it opened the folder.
import type { RecentProject } from "../../editor/recentProjects";

export type StartRequest = { readonly kind: "folder"; readonly root: string } | { readonly kind: "sample"; readonly id: string } | null;

/** The request in a page's query string. A sample wins over a folder when both are given. */
export function startRequest(search: string): StartRequest {
  const params = new URLSearchParams(search);
  const sample = params.get("sample")?.trim();
  if (sample) return { kind: "sample", id: sample };
  const root = params.get("project")?.trim();
  return root ? { kind: "folder", root } : null;
}

/** The mount path a browser folder named `name` gets in a tab (FsaFileSystem.mount, before any " (2)" for a second one). */
const mountBase = (name: string): string => `/${name.replace(/[\\/]/g, "_") || "folder"}`;

/**
 * The recent browser folder (a stored handle) that the editor's tab mounted at `root` (`/<folder name>`, or
 * `/<folder name> (n)` when that tab had two folders of the same name), newest first; null when none matches.
 */
export function recentForMount(recent: readonly RecentProject[], root: string): RecentProject | null {
  const path = root.replace(/[\\/]+$/, "");
  const base = path.replace(/ \(\d+\)$/, "");
  const newest = [...recent].sort((a, b) => b.lastOpened - a.lastOpened);
  return newest.find((e) => e.kind === "handle" && (mountBase(e.path) === path || mountBase(e.path) === base)) ?? null;
}
