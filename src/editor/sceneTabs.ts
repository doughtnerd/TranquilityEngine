// Which scene tabs a "close" command closes (the context menu on a tab, Ctrl/Cmd+W). Pure: the
// confirmation and the closing are session.ts `closeScenes`.

export type CloseMode = "this" | "others" | "all" | "right" | "left" | "saved";

/** The tabs `mode` closes, given the open tabs in order, the tab it was invoked on, and which have unsaved changes. */
export function tabsToClose<T>(tabs: readonly T[], target: T, mode: CloseMode, isDirty: (tab: T) => boolean): T[] {
  const at = tabs.indexOf(target);
  switch (mode) {
    case "this":
      return at < 0 ? [] : [target];
    case "others":
      return tabs.filter((t) => t !== target);
    case "all":
      return [...tabs];
    case "right":
      return at < 0 ? [] : tabs.slice(at + 1);
    case "left":
      return at < 0 ? [] : tabs.slice(0, at);
    case "saved":
      return tabs.filter((t) => !isDirty(t));
  }
}
