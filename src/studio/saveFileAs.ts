// Saving a file where the user says, in a browser (ADR 0408: a browser Studio with no project asks where each take
// goes). The browser's save dialog (`showSaveFilePicker`, Chromium) where there is one; elsewhere a download, which the
// browser saves where its settings say (asking, if the user set it to). Needs a press: browsers only show the dialog
// from one.

/** What the file is, for the dialog's type filter. */
export interface SaveFileType {
  readonly description: string;
  /** The file's ending, with its dot (".sporesample"). */
  readonly extension: string;
  readonly mime?: string;
}

interface SaveFilePickerWindow {
  showSaveFilePicker?(options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }): Promise<{
    readonly name: string;
    createWritable(): Promise<{ write(data: BlobPart): Promise<void>; close(): Promise<void> }>;
  }>;
}

/**
 * Saves `bytes` as a file the user chooses, suggesting `name`; resolves with the file's name, or null when the user
 * cancelled the dialog. Other failures reject.
 */
export async function saveFileAs(name: string, bytes: Uint8Array, type: SaveFileType, win: Window = window): Promise<string | null> {
  const blob = new Blob([bytes as BlobPart], { type: type.mime ?? "application/octet-stream" });
  const picker = (win as unknown as SaveFilePickerWindow).showSaveFilePicker;
  if (picker) {
    let handle;
    try {
      handle = await picker.call(win, { suggestedName: name, types: [{ description: type.description, accept: { [type.mime ?? "application/octet-stream"]: [type.extension] } }] });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return null;
      throw err;
    }
    const out = await handle.createWritable();
    await out.write(blob);
    await out.close();
    return handle.name;
  }
  const url = URL.createObjectURL(blob);
  try {
    const a = win.document.createElement("a");
    a.href = url;
    a.download = name;
    a.style.display = "none";
    win.document.body.append(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return name;
}
