// What the editor's last plugin apply had to tell the user about plugins that did activate (ADR 0374): an
// optional dependency that failed ("Audio integration unavailable: myco.audio failed") or one outside its
// version range. The Project settings' Plugins category shows them beside the plugin. Editor code only.
import { signal } from "@preact/signals";
import type { PluginSetNotice } from "./pluginSet";

export const pluginNotices = signal<readonly PluginSetNotice[]>([]);

/** The messages of `notices` about `plugin`. */
export const noticesOf = (notices: readonly PluginSetNotice[], plugin: string): string[] => notices.filter((n) => n.plugin === plugin).map((n) => n.message);
