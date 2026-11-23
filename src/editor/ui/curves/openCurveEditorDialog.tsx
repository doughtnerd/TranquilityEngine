// Open the shared curve editor (ADR 0346) on its own, outside the component that asked for it: the dialog renders into
// a host at the end of `doc`'s body and lives until Apply or Cancel, so it survives the asker closing (an inline field
// in a popover that a press in the dialog dismisses) and isn't caught in a transformed parent (a graph canvas).
import { render } from "preact";
import { CurveEditorDialog, type CurveEditorDialogProps } from "./CurveEditorDialog";

/** The open dialog. */
export interface OpenCurveEditor {
  /** Close it without applying (as Cancel). Idempotent. */
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
    render(null, host);
    host.remove();
  };
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
