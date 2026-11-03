import { signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { showPanel } from "../layout/store";
import { canOpenFolders } from "../projectFs";
import { recentProjects, recentVersion } from "../recentProjects";
import { closeProject, openProjectFolder, openRecentProject } from "../session";
import { currentProject } from "../state";
import { openNewProjectDialog } from "./NewProjectDialog";
import "./projects.css";

/** An entry in the toolbar's Project menu. Other features add theirs with `addProjectMenuItem` (e.g. Build/Export). */
export interface ProjectMenuItem {
  id: string;
  label: string;
  /** Items are grouped (with a divider between groups) and sorted by `order` within the menu. */
  order: number;
  title?: string;
  /** Checked each time the menu opens; default: always enabled. */
  enabled?: () => boolean;
  run: () => void;
}

/** Group orders: 100s open and create, 200s recent projects, 300s the open project, 400s build. */
const items = signal<readonly ProjectMenuItem[]>([
  { id: "new", label: "New Project…", order: 100, enabled: canOpenFolders, title: "Create a project folder from a template", run: openNewProjectDialog },
  { id: "open", label: "Open Project…", order: 110, enabled: canOpenFolders, title: "Open a project folder", run: () => void openProjectFolder() },
  { id: "settings", label: "Project Settings", order: 300, enabled: () => !!currentProject.value, title: "Show the Project panel: project.json's settings", run: () => showPanel("project") },
  { id: "close", label: "Close Project", order: 390, enabled: () => !!currentProject.value, title: "Close the project and go back to the start screen", run: () => void closeProject() },
]);

/** Add an item to the Project menu; returns a function that removes it. */
export function addProjectMenuItem(item: ProjectMenuItem): () => void {
  items.value = [...items.value.filter((i) => i.id !== item.id), item];
  return () => (items.value = items.value.filter((i) => i !== item));
}

const RECENT_IN_MENU = 5;
const open = signal(false);

/** The toolbar's Project menu: new, open, recent projects, project settings, close, and whatever other features add. */
export function ProjectMenu() {
  recentVersion.value;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open.value) return;
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && (open.value = false);
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [open.value]);

  const recent: ProjectMenuItem[] = canOpenFolders()
    ? recentProjects()
        .list()
        .filter((e) => e.path !== currentProject.value?.root)
        .slice(0, RECENT_IN_MENU)
        .map((e, i) => ({ id: `recent:${e.id}`, label: e.name, title: e.path, order: 200 + i, run: () => void openRecentProject(e) }))
    : [];
  const all = [...items.value, ...recent].sort((a, b) => a.order - b.order);
  const run = (item: ProjectMenuItem) => {
    open.value = false;
    item.run();
  };

  return (
    <div class="project-menu" ref={root} onKeyDown={(e) => e.key === "Escape" && (open.value = false)}>
      <button aria-haspopup="menu" aria-expanded={open.value} title="New, open and recent projects, project settings" onClick={() => (open.value = !open.value)}>
        Project ▾
      </button>
      {open.value && (
        <div class="project-menu-list" role="menu" aria-label="Project">
          {all.map((item, i) => {
            const divider = i > 0 && Math.floor(all[i - 1].order / 100) !== Math.floor(item.order / 100);
            return (
              <div key={item.id} class="project-menu-entry">
                {divider && <div class="project-menu-divider" role="separator" />}
                {item.order >= 200 && item.order < 300 && (i === 0 || all[i - 1].order < 200) && <div class="project-menu-heading">Recent</div>}
                <button role="menuitem" title={item.title} disabled={item.enabled ? !item.enabled() : false} onClick={() => run(item)}>
                  {item.label}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
