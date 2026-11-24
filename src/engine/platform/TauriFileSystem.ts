import type { DirEntry, FileSystem } from "./FileSystem";

/**
 * File access through Tauri's fs, dialog and opener plugins (ADR 0003, 0026, 0030). Internal.
 *
 * The plugins are imported lazily so headless tests and browser builds never load them. Paths
 * must be inside the app's data folder or a folder the user picked with `pickFolder` (the dialog
 * plugin adds picked folders to the fs scope for the rest of the session; see
 * src-tauri/capabilities/default.json).
 */
export class TauriFileSystem implements FileSystem {
  readonly canWrite = true;

  async readText(path: string): Promise<string> {
    const fs = await import("@tauri-apps/plugin-fs");
    return fs.readTextFile(path);
  }

  async writeText(path: string, text: string): Promise<void> {
    const fs = await import("@tauri-apps/plugin-fs");
    const tmp = tempPath(path);
    await fs.writeTextFile(tmp, text);
    await fs.rename(tmp, path);
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const fs = await import("@tauri-apps/plugin-fs");
    return fs.readFile(path);
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const fs = await import("@tauri-apps/plugin-fs");
    const tmp = tempPath(path);
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, path);
  }

  async list(path: string): Promise<DirEntry[]> {
    const fs = await import("@tauri-apps/plugin-fs");
    const entries = await fs.readDir(path);
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory }));
  }

  async exists(path: string): Promise<boolean> {
    const fs = await import("@tauri-apps/plugin-fs");
    return fs.exists(path);
  }

  async mkdir(path: string): Promise<void> {
    const fs = await import("@tauri-apps/plugin-fs");
    await fs.mkdir(path, { recursive: true });
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    const fs = await import("@tauri-apps/plugin-fs");
    await fs.remove(path, { recursive: options?.recursive ?? false });
  }

  async rename(from: string, to: string): Promise<void> {
    const fs = await import("@tauri-apps/plugin-fs");
    if (from !== to && from.toLowerCase() === to.toLowerCase()) {
      // A change of case only: on a case-insensitive file system (Windows, macOS) `exists(to)` finds `from` itself, so
      // only `to`'s exact name in its folder's listing means another entry has it. Go through a temporary name, which
      // every file system renames reliably.
      const sep = Math.max(to.lastIndexOf("/"), to.lastIndexOf("\\"));
      if ((await fs.readDir(to.slice(0, sep) || to.slice(0, sep + 1))).some((e) => e.name === to.slice(sep + 1))) throw new Error(`"${to}" already exists.`);
      const tmp = tempPath(from);
      await fs.rename(from, tmp);
      await fs.rename(tmp, to);
      return;
    }
    if (await fs.exists(to)) throw new Error(`"${to}" already exists.`);
    await fs.rename(from, to);
  }

  async pickFolder(title?: string, defaultPath?: string): Promise<string | null> {
    const dialog = await import("@tauri-apps/plugin-dialog");
    // `recursive` makes the dialog plugin allow the whole folder tree in the fs scope.
    const picked = await dialog.open({ directory: true, multiple: false, recursive: true, title, defaultPath });
    return typeof picked === "string" ? picked : null;
  }

  async watch(path: string, onChange: (paths: string[]) => void): Promise<() => void> {
    const fs = await import("@tauri-apps/plugin-fs");
    // Needs the plugin's "watch" Cargo feature (src-tauri/Cargo.toml).
    return fs.watch(path, (e) => onChange(e.paths), { recursive: true, delayMs: 300 });
  }

  async openExternally(path: string): Promise<void> {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.openPath(path);
  }

  async reveal(path: string): Promise<void> {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.revealItemInDir(path);
  }
}

/** A sibling temp file, so the final rename stays on one volume (and is atomic). */
function tempPath(path: string): string {
  return `${path}.tmp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
