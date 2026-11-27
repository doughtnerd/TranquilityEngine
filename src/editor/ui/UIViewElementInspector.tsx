import { currentProject, openScene, playState } from "../state";
import { openScript } from "../code/codeBuffers";
import { editorTextFiles } from "../textFiles";
import { attributeText, type FieldSourceRow } from "../uiFieldSources";
import { resolveUIViewElement, selectedUIViewRef, uiViewVersion, viewElementSource, viewFieldSources, whyViewOnly, writtenClasses } from "../uiViews";
import { movableViewAttributes, moveUIViewElementToClass, renameUIViewElement, setUIViewElementClasses, setUIViewElementField, setUIViewElementText, suggestedViewClassName, whyNotEditViewElement } from "../uiViewEdits";
import { styleDeclarations } from "../uiEdit/svelteText";
import { DraftInput, FieldSourceView, MoveToClass } from "./UIFieldSourceView";
import { UIViewLocalise } from "./localisation/UIViewLocalise";
import "./ui-element-inspector.css";

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** What a field's editor starts with: the literal attribute (or style declaration) as written, the text, or the current value. */
function rawText(row: FieldSourceRow, text: string | null): string {
  const o = row.origin;
  if (o.kind === "attribute") {
    if (o.attribute.name !== "style") return o.attribute.value;
    const d = o.attribute.value.split(";").map((x) => x.split(":")).find(([p]) => p.trim() === row.property);
    return d ? d.slice(1).join(":").trim() : attributeText(row.value);
  }
  if (o.kind === "content") return text ?? "";
  return attributeText(row.value);
}

/**
 * An element a UIView rendered from a Svelte component (ADR 0423 wave C): what it is, where it's written (the file
 * and line open in the Code panel), and its component's fields with where each value comes from: a literal attribute,
 * an expression `{…}` (view-only, shown as written), a scoped or global rule, inherited, the text, the default, or a
 * transition or animation. Static parts of the view's own component edit in place, written back to the `.svelte`
 * source (Ctrl+Z undoes them); `{#each}` rows, snippets and child components' insides are view-only, and say why.
 * Its text (content and text attributes) can be localised: Localise / Extract to string table (ADR 0356 §9).
 */
export function UIViewElementInspector() {
  uiViewVersion.value; // follow re-renders and hot reload
  currentProject.value;
  playState.value;
  const scene = openScene.value, ref = selectedUIViewRef();
  const el = scene && ref ? resolveUIViewElement(scene.sync, ref) : null;
  if (!scene || !el || !ref) return <p class="empty">{editorTextFiles.busy ? "Updating…" : "The selected UI element is gone (its view changed)."}</p>;
  const where = viewElementSource(scene.sync, ref);
  const viewOnly = whyViewOnly(scene.sync, ref);
  const readOnly = whyNotEditViewElement(scene, ref);
  const rows = viewFieldSources(el);
  const element = where?.element ?? null;
  const classAttr = element?.attributes.find((a) => a.name === "class");
  const staticClass = !classAttr || classAttr.value.kind !== "dynamic";
  const idAttr = element?.attributes.find((a) => a.name === "id");
  const staticId = !idAttr || idAttr.value.kind !== "dynamic";
  const text = element?.text;
  const textEditable = !readOnly && !!element && (text?.kind === "literal" || (text?.kind === "none" && element.children.length === 0));
  const contentField = el.uiTag === "Text" ? "text" : null;
  return (
    <div class="inspector-body ui-element-inspector ui-view-element-inspector">
      <div class="node-header">
        <span class="node-name ui-element-name">{`<${el.tag}>`}</span>
      </div>
      <p class="ui-element-note">
        {viewOnly
          ? `From a Svelte component, view-only: ${viewOnly}.`
          : readOnly
            ? `From a Svelte component: rendered from the file, not saved in the scene. Can't edit it here: ${readOnly}.`
            : "From a Svelte component: edits are written to its source (Ctrl+Z undoes them); expressions stay as written."}
      </p>
      <dl class="node-meta">
        <dt>File</dt>
        <dd>
          <button class="link-button" title={`Open ${ref.file} in the Code panel at line ${ref.line}`} onClick={() => openScript(ref.file, { line: ref.line, column: ref.column + 1 })}>
            {ref.file}:{ref.line}
          </button>
          {where && where.file !== where.viewFile && <span class="ui-element-from"> (inside a child component of {fileName(where.viewFile)})</span>}
          {element?.block && <span class="ui-element-from"> (inside {element.block})</span>}
        </dd>
        <dt>Id</dt>
        <dd>{readOnly || !staticId ? (idAttr?.value.kind === "dynamic" ? idAttr.value.source : el.id ?? "") : <DraftInput label="Id" value={el.id ?? ""} placeholder="none" onCommit={(v) => renameUIViewElement(ref, v)} />}</dd>
        <dt>Class</dt>
        <dd>
          {readOnly || !staticClass ? (
            classAttr?.value.kind === "dynamic" ? classAttr.value.source : writtenClasses(el).join(" ")
          ) : (
            <DraftInput label="Class" value={classAttr?.value.kind === "literal" ? classAttr.value.text : ""} placeholder="none" onCommit={(v) => setUIViewElementClasses(ref, v)} />
          )}
          {element?.directives.some((d) => d.kind === "ClassDirective") && <span class="ui-element-from"> {element.directives.filter((d) => d.kind === "ClassDirective").map((d) => d.source).join(" ")}</span>}
        </dd>
        {!contentField && text && text.kind !== "none" && (
          <>
            <dt>Text</dt>
            <dd>{textEditable && text.kind === "literal" ? <DraftInput label="Text" value={text.text.trim()} onCommit={(v) => setUIViewElementText(ref, v)} /> : text.kind === "dynamic" ? text.source : text.text.trim()}</dd>
          </>
        )}
        {element && styleDeclarations(element) === null && (
          <>
            <dt>Style</dt>
            <dd>{element.attributes.find((a) => a.name === "style")?.value.kind === "dynamic" ? (element.attributes.find((a) => a.name === "style")!.value as { source: string }).source : ""}</dd>
          </>
        )}
      </dl>
      <UIViewLocalise uiRef={ref} id={el.id ?? null} tag={el.tag} />
      {!readOnly && <MoveToClass key={`${ref.line}:${ref.column}`} count={movableViewAttributes(ref, el).length} suggested={suggestedViewClassName(el)} onMove={(name) => moveUIViewElementToClass(ref, name)} target={`${fileName(ref.file)}'s <style>`} />}
      <section class="component">
        <h3>{el.component.constructor.name}</h3>
        <div class="fields ui-element-fields">
          {rows.map((r) => {
            const editable = !readOnly && r.origin.kind !== "expression" && (r.field !== contentField || textEditable);
            return <FieldSourceView key={r.field} row={r} raw={rawText(r, text?.kind === "literal" ? text.text.trim() : null)} onCommit={(v) => setUIViewElementField(ref, r.field, v)} editable={editable} />;
          })}
        </div>
      </section>
    </div>
  );
}
