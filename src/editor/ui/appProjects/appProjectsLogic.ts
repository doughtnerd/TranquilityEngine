// The rules of an application's projects screen (ADR 0380): which recent projects a search keeps, which one is
// "Continue where you left off", and how an opening time reads. Pure; the views are `ProjectsTab.tsx` and the
// Biosonic screen's takes tab. Also what taking a project off the list does: the entry goes, its folder stays, and a
// toast offers Undo.
import type { RecentProject, RecentProjects } from "../../recentProjectList";
import type { ToastQueue } from "../undoToastModel";

/**
 * Take `entry` off the recent projects (never touching its folder) and show a toast saying so, whose Undo puts it back.
 * Returns whether it was on the list.
 */
export async function removeFromList(recent: Pick<RecentProjects, "remove" | "restore">, entry: Pick<RecentProject, "id" | "name">, toasts: Pick<ToastQueue, "show">): Promise<boolean> {
  const removed = await recent.remove(entry.id);
  if (!removed) return false;
  toasts.show({ text: `Removed ${entry.name} from the list. Its folder is still on disk.`, undo: () => void recent.restore(removed) });
  return true;
}

/** What a search matches in a row: its name and where it is. */
export interface Searchable {
  readonly name: string;
  readonly where: string;
}

/** The rows whose name or location holds every word of `query` (case-insensitive), in their order; all of them for an empty query. */
export function searchRows<T>(rows: readonly T[], query: string, text: (row: T) => Searchable): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((row) => {
    const { name, where } = text(row);
    const hay = `${name}\n${where}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The newest row (by `time`) as the one to continue, and the rest newest first. */
export function splitLatest<T>(rows: readonly T[], time: (row: T) => number): { latest: T | null; rest: T[] } {
  const sorted = [...rows].sort((a, b) => time(b) - time(a));
  return { latest: sorted[0] ?? null, rest: sorted.slice(1) };
}

/** "today, 14:20", "yesterday, 09:05", or the date ("3/14/2026" in the locale), for a time in ms. */
export function openedWhen(time: number, now: number = Date.now(), locale?: string): string {
  const d = new Date(time);
  const clock = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const day = (t: number) => new Date(t).toDateString();
  if (day(time) === day(now)) return `today, ${clock}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day(time) === yesterday.toDateString()) return `yesterday, ${clock}`;
  return d.toLocaleDateString(locale);
}
