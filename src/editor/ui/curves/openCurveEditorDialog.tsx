// Open the shared curve editor (ADR 0346) on its own, outside the component that asked for it: the dialog renders into
// a host at the end of `doc`'s body and lives until Apply or Cancel, so it survives the asker closing (an inline field
// in a popover that a press in the dialog dismisses) and isn't caught in a transformed parent (a graph canvas).
import { render } from "preact";
import { forEachChildWindow } from "../../windows/editorWindows";
import { CurveEditorDialog, type CurveEditorDialogProps } from "./CurveEditorDialog";

/** The open dialog. */
export interface OpenCurveEditor {
  /** Close it without applying (as Cancel). Idempotent. It also closes when the detached window it's in closes. */
  close(): void;
}

/** Show the curve editor dialog in `doc` (the asker's document: a detached panel window's, ADR 0174). */
export function openCurveEditorDialog(doc: Document, props: CurveEditorDialogProps): OpenCurveEditor {
  const host = doc.createElement("div");
  host.className = "ce-host";
  doc.body.appendChild(host);
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    stopWatching();
    try {
      render(null, host); // unmounting stops its timers (the live readout's)
      host.remove();
    } catch {
      // its window has closed; the document went with it
    }
  };
  // A detached window that closes (ADR 0174) takes the dialog with it: unmount it then, as Cancel. Nothing to watch
  // in the main window.
  const view = doc.defaultView;
  const stopWatching = forEachChildWindow((win) =>
    win === view
      ? () => {
          if (!open) return;
          close();
          props.onCancel();
        }
      : undefined,
  );
  render(
    <CurveEditorDialog
      {...props}
      onCancel={() => {
        close();
        props.onCancel();
      }}
      onApply={(result) => {
        close();
        props.onApply(result);
      }}
    />,
    host,
  );
  return { close };
}
