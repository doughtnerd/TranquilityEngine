// Editing Svelte UI from the editor (ADR 0419 wave C): the Inspector's fields, text, id and classes, Move to class,
// Create, the hierarchy's rename, duplicate, delete and drag, and the scene view's handles, all written back to the
// view's `.svelte` source with edits that change only their own text (`uiEdit/svelteText.ts`, on `parse()` spans).
// It's `uiDocumentEdits.ts`'s counterpart for views, with the same rules:
//
// - Every edit is one `WriteFiles` command on the open scene's CommandStack, so Ctrl+Z undoes it in order with scene
//   and UI document edits, and the History panel lists it. The file host writes through the project; writing UI code
//   reloads the project's code (`textFiles.ts`), and the view hot-reloads with its props.
// - Whether it can be edited now (a scene open, a project that can save, not playing) is the edit gate's (ADR 0247).
// - Only static parts of the view's own component are edited (owner decision 1 of ADR 0419): `uiViews.ts`'s
//   `whyViewOnly` says why the others aren't, in the status bar.
// - A selection is a template location; an edit that moves the selected element selects it where it went.
import type { UIHostElement } from "../engine/ui/host/UIHost";
import { getFields, type FieldInfo } from "../engine/core/registry";
import { camelCase, convertValue } from "../engine/ui/document/cascade";
import { WriteFiles } from "./document";
import { errorStatus } from "./messages";
import { status, type OpenScene } from "./state";
import { beginEditStep, editableNow, whyNotEdit } from "./editGate";
import { selectUIElement } from "./inspectorTarget";
import type { UndoStep } from "./undoStep";
import { cssValue } from "./uiDocumentEdits";
import { kebab } from "./uiDocuments";
import {
  duplicateElement,
  elementAtLocation,
  idsIn,
  insertAfterElement,
  insertElement,
  lineColumnAt,
  moveElement,
  offsetAt,
  parseSvelte,
  removeAttribute,
  removeElement,
  setAttribute,
  setRuleDeclarations,
  setStyleProperty,
  setText,
  styleDeclarations,
  SvelteEditError,
  type SvelteElement,
} from "./uiEdit/svelteText";
import { attributeNamesOf, refOfViewElement, resolveUIViewElement, sourceOfFile, viewFile, viewOf, whyViewOnly, type UIViewRef } from "./uiViews";

const TO_DO = "edit Svelte UI";

/** A view: its node's path key and which UIView on it. */
export type UIViewAt = { readonly host: string; readonly index: number };

/** Start a gesture whose edits are one undo step (a scene-view handle drag), or null with the reason in the status bar. */
export function beginUIViewEdit(label: string): UndoStep | null {
  return beginEditStep({ kind: "ui-documents" }, label, TO_DO);
}

/** Why the element `ref` names can't be edited now (the edit gate, then `whyViewOnly`), or null. */
export function whyNotEditViewElement(scene: OpenScene | null, ref: UIViewRef): string | null {
  return whyNotEdit({ kind: "ui-documents" }, TO_DO) ?? (scene ? whyViewOnly(scene.sync, ref) : "open a scene first");
}

/** The open scene if Svelte UI can be edited now; otherwise says why in the status bar. */
const editableScene = (): OpenScene | null => editableNow({ kind: "ui-documents" }, TO_DO);

interface Editable {
  readonly scene: OpenScene;
  readonly el: UIHostElement;
  readonly file: string;
  readonly element: SvelteElement;
}

/** The element a ref names if its static parts can be edited now; otherwise says why in the status bar. */
function editable(ref: UIViewRef): Editable | null {
  const scene = editableScene();
  if (!scene) return null;
  const el = resolveUIViewElement(scene.sync, ref);
  const reason = el ? whyViewOnly(scene.sync, ref) : "it's gone (its view changed)";
  if (reason || !el) {
    status.value = { kind: "info", text: `Can't edit that element: ${reason}.` };
    return null;
  }
  const element = elementAtLocation(sourceOfFile(ref.file)!, ref.line, ref.column)!; // whyViewOnly found it
  return { scene, el, file: ref.file, element };
}

/** Run `change` on the file's text and record the result as one undoable step. False (with a status) when nothing changed or it was refused. */
function commit(scene: OpenScene, file: string, label: string, change: (text: string) => string): string | null {
  const host = scene.stack.files;
  if (!host) {
    status.value = { kind: "error", text: "This scene can't write files." };
    return null;
  }
  const before = host.read(file);
  if (before === null) {
    status.value = { kind: "info", text: `Couldn't ${label.toLowerCase()}: there's no file ${file}.` };
    return null;
  }
  try {
    const after = change(before);
    if (after === before) return null;
    scene.stack.execute(new WriteFiles(label, [{ path: file, text: after }]));
    return after;
  } catch (err) {
    status.value = err instanceof SvelteEditError ? { kind: "info", text: `Couldn't ${label.toLowerCase()}: ${err.message}.` } : errorStatus(`Couldn't ${label.toLowerCase()}`, err);
    return null;
  }
}

/** The ref of the element starting at `start` in `text` (written in `ref`'s view and file). */
const refAtOffset = (at: UIViewAt, file: string, text: string, start: number): UIViewRef => ({ host: at.host, index: at.index, file, ...lineColumnAt(text, start), nth: 0 });

const label = (el: UIHostElement) => (el.id ? `#${el.id}` : `<${el.tag}>`);

// --- Attributes and fields ------------------------------------------------------------------------------

const ID_PATTERN = /^[A-Za-z_][\w-]*$/;
const CLASS_PATTERN = /^-?[A-Za-z_][\w-]*$/;

/** Write `attributes` on the element starting at `start` (see `setUIViewElementAttributes`). */
function writeAttributes(text: string, start: number, attributes: Readonly<Record<string, string | null>>): string {
  for (const [name, value] of Object.entries(attributes)) {
    const el = parseSvelte(text).elements.find((e) => e.start === start)!;
    if (name === "id" || name === "class") {
      text = value === null ? removeAttribute(text, start, name) : setAttribute(text, start, name, value);
      continue;
    }
    const field = camelCase(name);
    const property = kebab(field);
    const names = attributeNamesOf(field);
    const inStyle = (styleDeclarations(el) ?? []).some((d) => d.property === property);
    const written = el.attributes.find((a) => names.includes(a.name));
    if (value === null) {
      if (inStyle) text = setStyleProperty(text, start, property, null);
      for (const a of el.attributes) if (names.includes(a.name)) text = removeAttribute(text, start, a.name);
      continue;
    }
    // An inline style beats attributes: a property the literal style sets is changed there.
    if (inStyle) text = setStyleProperty(text, start, property, value);
    else text = setAttribute(text, start, written?.name ?? (field === "image" ? "src" : property), value);
  }
  return text;
}

/**
 * Set or remove (null) attributes on a rendered element in its `.svelte` source, as one undoable step: the API the
 * Inspector and the scene-view handles use. Names are attribute or field names (`flex-direction`, `flexDirection`,
 * `id`, `class`): one the element's literal `style` declares is changed there, one already written keeps its
 * spelling, a new one is written kebab-case. Refused (with the reason in the status bar) on view-only elements and on
 * attributes written as expressions. Inside a `beginUIViewEdit` step it joins that gesture. Returns true if the file changed.
 */
export function setUIViewElementAttributes(ref: UIViewRef, attributes: Readonly<Record<string, string | null>>, text?: string): boolean {
  const e = editable(ref);
  if (!e) return false;
  const names = Object.keys(attributes);
  const what = text ?? (names.length === 1 ? `${attributes[names[0]] === null ? "Reset" : "Set"} ${names[0]}` : `Set ${names.length} attributes`);
  return commit(e.scene, e.file, what, (t) => writeAttributes(t, e.element.start, attributes)) !== null;
}

/** The field a component of `el` has for an attribute name, or null. */
function fieldInfo(el: UIHostElement, name: string): FieldInfo | null {
  const field = camelCase(name);
  return getFields(el.component.constructor as never).find((f) => f.name === field) ?? null;
}

/** Set a rendered element's literal text content (a heading's, a button's label). Refused when it has expressions or elements inside. */
export function setUIViewElementText(ref: UIViewRef, value: string): boolean {
  const e = editable(ref);
  if (!e) return false;
  return commit(e.scene, e.file, "Set text", (t) => setText(t, e.element.start, value)) !== null;
}

/**
 * The Inspector's edit of one field: `raw` as typed (attribute syntax: `#ff0000`, `12`, `auto`, `50%`), or null to
 * reset it (remove the attribute, or clear the text). A text element's `text` is its text content. Anything else is
 * an attribute (or the literal style's declaration), overriding rules and inheritance.
 */
export function setUIViewElementField(ref: UIViewRef, field: string, raw: string | null): boolean {
  const e = editable(ref);
  if (!e) return false;
  if (field === "text" && e.el.uiTag === "Text") return setUIViewElementText(ref, raw ?? "");
  const info = fieldInfo(e.el, field);
  if (!info) {
    status.value = { kind: "info", text: `<${e.el.tag}> has no field "${field}".` };
    return false;
  }
  if (raw !== null && !raw.includes("var(") && convertValue(raw, info, e.file) === undefined) {
    status.value = { kind: "error", text: `"${raw}" isn't a valid ${kebab(field)}.` };
    return false;
  }
  return setUIViewElementAttributes(ref, { [field]: raw }, `${raw === null ? "Reset" : "Set"} ${kebab(field)}`);
}

/** Set or clear (empty) a rendered element's id. Ids written in a file are unique in it. */
export function renameUIViewElement(ref: UIViewRef, id: string): boolean {
  const e = editable(ref);
  if (!e) return false;
  const next = id.trim();
  if (next === (e.el.id ?? "")) return false;
  if (next && !ID_PATTERN.test(next)) {
    status.value = { kind: "info", text: `"${next}" isn't a valid id: use letters, digits, - and _, starting with a letter.` };
    return false;
  }
  if (next && idsIn(sourceOfFile(e.file)!).has(next)) {
    status.value = { kind: "info", text: `Another element in ${e.file} is #${next} already.` };
    return false;
  }
  return commit(e.scene, e.file, next ? `Rename to #${next}` : "Remove id", (t) => writeAttributes(t, e.element.start, { id: next || null })) !== null;
}

/** Set a rendered element's static `class` attribute (space-separated; empty removes it). `class:` directives stay. */
export function setUIViewElementClasses(ref: UIViewRef, classes: string): boolean {
  const list = classes.split(/\s+/).filter(Boolean);
  const bad = list.find((c) => !CLASS_PATTERN.test(c));
  if (bad) {
    status.value = { kind: "info", text: `"${bad}" isn't a valid class name.` };
    return false;
  }
  return setUIViewElementAttributes(ref, { class: list.length ? list.join(" ") : null }, "Set class");
}

// --- Structure ------------------------------------------------------------------------------------------

/** Delete a rendered element from its source, selecting its parent (or nothing at the top of the view). */
export function deleteUIViewElement(ref: UIViewRef): boolean {
  const e = editable(ref);
  if (!e) return false;
  const parent = e.el.parent ? refOfViewElement(e.scene.sync, e.el.parent) : null;
  const done = commit(e.scene, e.file, `Delete ${label(e.el)}`, (t) => removeElement(t, e.element.start)) !== null;
  if (done) selectUIElement(parent);
  return done;
}

/** Duplicate a rendered element right after itself (fresh literal ids), selecting the copy. */
export function duplicateUIViewElement(ref: UIViewRef): boolean {
  const e = editable(ref);
  if (!e) return false;
  let copy: UIViewRef | null = null;
  const done = commit(e.scene, e.file, `Duplicate ${label(e.el)}`, (t) => {
    const r = duplicateElement(t, e.element.start);
    copy = refAtOffset(ref, e.file, r.text, r.start);
    return r.text;
  });
  if (done && copy) selectUIElement(copy);
  return done !== null;
}

/** Where a move into `parent` would go: the parent element in the file (null: the view's top level), or why it can't. */
function moveTarget(scene: OpenScene, ref: UIViewRef, parent: UIViewRef | UIViewAt): { at: number | null } | { reason: string } {
  if (parent.host !== ref.host || parent.index !== ref.index) return { reason: "elements move within their own view" };
  if (!("file" in parent)) {
    const view = viewOf(scene.sync, parent);
    return view && viewFile(view) === ref.file ? { at: null } : { reason: "it's gone" };
  }
  if (parent.file !== ref.file) return { reason: `elements move within their own file (this one is in ${ref.file})` };
  const why = whyViewOnly(scene.sync, parent);
  if (why) return { reason: `the element it would go into is view-only: ${why}` };
  const src = sourceOfFile(parent.file)!;
  const at = offsetAt(src.text, parent.line, parent.column);
  const p = src.elements.find((x) => x.start === at);
  if (!p) return { reason: "it's gone" };
  if (p.text.kind === "dynamic") return { reason: "the element it would go into has text with expressions" };
  return { at };
}

/** Why `ref` can't move into `parent` (an element, or the view's top level), or null. */
export function whyNotMovableView(scene: OpenScene | null, ref: UIViewRef, parent: UIViewRef | UIViewAt): string | null {
  if (!scene) return "open a scene first";
  const own = whyViewOnly(scene.sync, ref);
  if (own) return own;
  const t = moveTarget(scene, ref, parent);
  if ("reason" in t) return t.reason;
  const src = sourceOfFile(ref.file)!;
  const self = src.elements.find((x) => x.start === offsetAt(src.text, ref.line, ref.column))!;
  if (self.block) return `it's inside ${self.block}: move it in the Code panel`;
  if (t.at !== null) {
    const p = src.elements.find((x) => x.start === t.at)!;
    if (p.start >= self.start && p.end <= self.end) return "an element can't go inside itself";
  }
  return null;
}

/**
 * Move a rendered element to be the `index`th element written directly in `parent` (an element, or the view's top
 * level), counting the children as they are now with it among them (past the end: last). Selects it where it went.
 */
export function moveUIViewElement(ref: UIViewRef, parent: UIViewRef | UIViewAt, index: number): boolean {
  const e = editable(ref);
  if (!e) return false;
  const reason = whyNotMovableView(e.scene, ref, parent);
  if (reason) {
    status.value = { kind: "info", text: `Can't move it there: ${reason}.` };
    return false;
  }
  const t = moveTarget(e.scene, ref, parent) as { at: number | null };
  const siblings = t.at === null ? sourceOfFile(e.file)!.top : sourceOfFile(e.file)!.elements.find((x) => x.start === t.at)!.children;
  const from = siblings.indexOf(e.element);
  if (from >= 0 && (index === from || index === from + 1)) return false;
  let moved: UIViewRef | null = null;
  const done = commit(e.scene, e.file, `Move ${label(e.el)}`, (text) => {
    const r = moveElement(text, e.element.start, t.at, index);
    moved = refAtOffset(ref, e.file, r.text, r.start);
    return r.text;
  });
  if (done && moved) selectUIElement(moved);
  return done !== null;
}

/** New elements' starting markup, by the HTML tag the Create menu names (sizes and looks like UI documents' Create, ADR 0069). */
export const NEW_VIEW_ELEMENTS: Readonly<Record<string, { readonly label: string; readonly markup: string }>> = {
  div: { label: "Panel (div)", markup: `<div width="200" height="100" background-color="#2a2f3a"></div>` },
  span: { label: "Text (span)", markup: `<span>New Text</span>` },
  p: { label: "Paragraph (p)", markup: `<p>New Text</p>` },
  h1: { label: "Heading (h1)", markup: `<h1>Heading</h1>` },
  button: { label: "Button", markup: `<button width="160" height="40">Button</button>` },
  img: { label: "Image (img)", markup: `<img width="100" height="100" alt="" />` },
  input: { label: "Input Field (input)", markup: `<input placeholder="Enter text…" />` },
  // ADR 0424: form elements.
  textarea: { label: "Text Area (textarea)", markup: `<textarea placeholder="Enter text…"></textarea>` },
  checkbox: { label: "Checkbox (input)", markup: `<input type="checkbox" />` },
  radio: { label: "Radio Button (input)", markup: `<input type="radio" name="choice" />` },
  range: { label: "Slider (input)", markup: `<input type="range" />` },
  select: { label: "Drop-down (select)", markup: `<select><option>One</option><option>Two</option></select>` },
  option: { label: "Option", markup: `<option>Option</option>` },
  progress: { label: "Progress Bar (progress)", markup: `<progress value="0.5"></progress>` },
  meter: { label: "Meter", markup: `<meter value="0.5"></meter>` },
  label: { label: "Label", markup: `<label>Label</label>` },
  form: { label: "Form", markup: `<form></form>` },
};

/** Elements that hold other elements when you create into them; into anything else, new elements go after it. */
const CONTAINERS: ReadonlySet<string> = new Set(["Panel", "Select", "Label", "Form"]);

/**
 * Add a new element to a view's component source, as one undo step, and select it once the view reloads: into the
 * element `at` names (after it, when it isn't a container), or at the end of the view's top level for `{ host, index }`.
 * Returns its ref, or null.
 */
export function createUIViewElement(tag: keyof typeof NEW_VIEW_ELEMENTS, at: UIViewRef | UIViewAt): UIViewRef | null {
  const markup = NEW_VIEW_ELEMENTS[tag]?.markup;
  if (!markup) return null;
  let scene: OpenScene | null, file: string, change: (text: string) => { text: string; start: number };
  if ("file" in at) {
    const e = editable(at);
    if (!e) return null;
    scene = e.scene;
    file = e.file;
    const start = e.element.start;
    change = CONTAINERS.has(e.el.uiTag) ? (t) => insertElement(t, start, Number.MAX_SAFE_INTEGER, markup) : (t) => insertAfterElement(t, start, markup);
  } else {
    scene = editableScene();
    const view = scene && viewOf(scene.sync, at);
    if (!scene) return null;
    file = view ? viewFile(view) : "";
    if (!view || !file || sourceOfFile(file) === null) {
      status.value = { kind: "info", text: !view || !file ? "That UIView has no component yet." : `${file} doesn't parse; fix it in the Code panel first.` };
      return null;
    }
    change = (t) => insertElement(t, null, Number.MAX_SAFE_INTEGER, markup);
  }
  let ref: UIViewRef | null = null;
  const done = commit(scene, file, `Create <${markup.slice(1, markup.search(/[\s/>]/))}>`, (t) => {
    const r = change(t);
    ref = refAtOffset(at, file, r.text, r.start);
    return r.text;
  });
  if (!done || !ref) return null;
  selectUIElement(ref);
  return ref;
}

// --- Move to class ----------------------------------------------------------------------------------------

/** A class name for an element's attributes: its id, else its tag. */
export const suggestedViewClassName = (el: UIHostElement): string => el.id ?? el.tag.toLowerCase();

/** The literal attributes (and literal style declarations) Move to class moves: component fields, not `id`, `class` or expressions. */
export function movableViewAttributes(ref: UIViewRef, el: UIHostElement): string[] {
  const src = sourceOfFile(ref.file);
  const element = src?.elements.find((x) => x.start === offsetAt(src.text, ref.line, ref.column));
  if (!element) return [];
  const out = element.attributes.filter((a) => a.value.kind === "literal" && a.name !== "id" && a.name !== "class" && a.name !== "style" && fieldInfo(el, a.name)).map((a) => a.name);
  for (const d of styleDeclarations(element) ?? []) if (fieldInfo(el, d.property)) out.push(`style:${d.property}`);
  return out;
}

/**
 * Move a rendered element's literal field attributes and literal style declarations into a class rule in its
 * component's `<style>` (made at the end of the file when it has none), as one undo step: `.name { … }` is added or
 * extended (kebab-case properties, colours as hex, lengths in px), the element gets the class in its static `class`
 * attribute, and the attributes go. Svelte scopes the rule to the component.
 */
export function moveUIViewElementToClass(ref: UIViewRef, className?: string): boolean {
  const e = editable(ref);
  if (!e) return false;
  const name = (className ?? suggestedViewClassName(e.el)).trim().replace(/^\./, "");
  if (!CLASS_PATTERN.test(name)) {
    status.value = { kind: "info", text: `"${name}" isn't a valid class name.` };
    return false;
  }
  const classAttr = e.element.attributes.find((a) => a.name === "class");
  if (classAttr && classAttr.value.kind === "dynamic") {
    status.value = { kind: "info", text: `Couldn't move to class .${name}: its class is an expression (${classAttr.value.source}).` };
    return false;
  }
  const moving = movableViewAttributes(ref, e.el);
  if (moving.length === 0) {
    status.value = { kind: "info", text: `Couldn't move to class .${name}: ${label(e.el)} has no literal attributes to move.` };
    return false;
  }
  const done = commit(e.scene, e.file, `Move to class .${name}`, (text) => {
    const start = e.element.start;
    const styleDecls = styleDeclarations(e.element) ?? [];
    const declarations = moving.map((m) => {
      if (m.startsWith("style:")) {
        const p = m.slice(6);
        return [p, styleDecls.find((d) => d.property === p)!.value] as const;
      }
      const a = e.element.attributes.find((x) => x.name === m)!;
      const property = m === "src" ? "image" : kebab(camelCase(m));
      return [property, cssValue(fieldInfo(e.el, m), a.value.kind === "literal" ? a.value.text : "")] as const;
    });
    let t = text;
    // The element first (its edits come before the <style> block), then the rule.
    const classes = classAttr?.value.kind === "literal" ? classAttr.value.text.split(/\s+/).filter(Boolean) : [];
    if (!classes.includes(name)) t = setAttribute(t, start, "class", [...classes, name].join(" "));
    for (const m of moving) t = m.startsWith("style:") ? setStyleProperty(t, start, m.slice(6), null) : removeAttribute(t, start, m);
    return setRuleDeclarations(t, `.${name}`, declarations);
  });
  if (done) status.value = { kind: "info", text: `Moved ${moving.length === 1 ? "1 attribute" : `${moving.length} attributes`} to .${name}.` };
  return done !== null;
}
