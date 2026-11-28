// The frame every editor of one asset document renders in (ADR 0265): the Material, Tileset and Formation
// inspectors, the Sky panel and the particle asset inspectors. It owns what they share: the root marked
// `data-asset-document`, so focus inside makes the document the active history (ADR 0145); the head with the kind,
// the file name and Undo / Redo; the problems list; the read-only notice; and writing a pending coalesced edit when
// it closes. The kind supplies only its body.
import { fileName } from "../projectPath";
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import type { AssetDocument } from "../assetDocuments";
import { readOnlyMessage } from "../readOnly";
import { currentProject } from "../state";
import "./assetInspector.css";

export interface AssetDocumentFrameProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any document: the frame reads no value
  readonly doc: AssetDocument<any>;
  /** The kind as a label ("Material"): the head's first word and the root's accessible name. */
  readonly kind: string;
  /** The kind's own classes on the root, for its layout ("inspector-body asset-inspector"). */
  readonly class?: string;
  /** Problems the kind adds to the document's own (a compiled graph's), listed after them. */
  readonly problems?: readonly string[];
  /** The body. */
  readonly children?: ComponentChildren;
}


/** One asset document's editor frame (see the file comment). */
export function AssetDocumentFrame(props: AssetDocumentFrameProps) {
  const { doc, kind } = props;
  useEffect(() => () => void doc.flush(), [doc]); // write a pending slider change when the editor closes
  const name = fileName(doc.path);
  const readOnly = doc.readOnly ? readOnlyMessage(currentProject.value ?? { name: "This project" }, `change ${name}`) : null;
  const problems = [...new Set([...doc.problems.value.map((p) => p.message), ...(props.problems ?? [])])];
  const noun = kind.toLowerCase();
  const canUndo = !readOnly && doc.canUndo.value;
  const canRedo = !readOnly && doc.canRedo.value;
  const undoLabel = doc.undoLabel.value;
  const redoLabel = doc.redoLabel.value;
  return (
    <div class={`asset-document${props.class ? ` ${props.class}` : ""}`} aria-label={kind} data-asset-document={doc.path} tabIndex={-1}>
      <div class="asset-inspector-head">
        <span class="asset-inspector-kind">{kind}</span>
        <span class="asset-inspector-name" title={doc.path}>
          {name}
        </span>
        <span class="asset-document-history">
          <button onClick={() => doc.undo()} disabled={!canUndo} title={readOnly ?? (canUndo ? `Undo ${undoLabel ?? "the last edit"} (Ctrl+Z)` : `Nothing to undo in this ${noun}`)}>
            Undo
          </button>
          <button onClick={() => doc.redo()} disabled={!canRedo} title={readOnly ?? (canRedo ? `Redo ${redoLabel ?? "the undone edit"} (Ctrl+Shift+Z)` : `Nothing to redo in this ${noun}`)}>
            Redo
          </button>
        </span>
      </div>
      {problems.length > 0 && (
        <ul class="asset-inspector-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {readOnly && <p class="asset-document-readonly">{readOnly}</p>}
      {props.children}
    </div>
  );
}
