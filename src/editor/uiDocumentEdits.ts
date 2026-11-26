// Editing UI documents from the editor (ADR 0077 §4, wave B part 2): Inspector fields, text content,
// ids and classes, Move to class, Create, and the hierarchy's rename, delete, duplicate and drag, all
// written back to the markup and stylesheet files with edits that change only their own text
// (`uiEdit/markupText.ts`, `uiEdit/cssText.ts`).
//
// Every edit is one command on the open scene's CommandStack (`WriteFiles`), so Ctrl+Z undoes UI
// edits in order with scene edits, and the History panel lists them. The stack writes the files
// through its file host (`textFiles.ts`), whose writes update `Assets`, so the document rebuilds in
// the Editor World the next frame and the selection (a ref by path) follows. A gesture (a scene-view
// handle drag) wraps its edits in the undo step `beginUIEdit` opens. Whether UI documents can be edited now (a scene
// open, a project that can save, not playing) is the edit gate's (ADR 0247).
//
// An element is edited in its own file: elements from a `<Use>` live in the used document. Moving,
// deleting or duplicating a used document's root acts on its `<Use>` tag; attributes written on the
// `<Use>` tag (which override the used root's) are edited there. List rows (no path) aren't the
// file's and can't be edited; neither can read-only projects (samples) or anything while playing.
// Where an element's tags are written, and the path an element will have after an edit, are the UI
// document's answers (`engine/ui/documentSource.ts`, ADR 0298); this module only edits the text.
import type { UIDocumentElement } from "../engine/ui/UIDocument";
import { Color } from "../engine/core/math";
import { AssetRef, getFields, type FieldInfo } from "../engine/core/registry";
import { hasBinding, resolvePath } from "../engine/ui/document/markup";
import { camelCase, convertValue, matchSelector, parseColor } from "../engine/ui/document/stylesheet";
import type { UITag } from "../engine/ui/document/types";
import { childPath, elementSource, type MarkupPlace, type UIElementSource } from "../engine/ui/documentSource";
import { WriteFiles, type FileWrite, type TextFileHost } from "./document";
import { errorStatus } from "./messages";
import { openScene, status, type OpenScene } from "./state";
import { beginEditStep, editableNow } from "./editGate";
import { addRule, setDeclarations } from "./uiEdit/cssText";
import {
  addStyle,
  duplicateElement,
  elementAt,
  idsIn,
  insertElement,
  MarkupEditError,
  moveElement,
  parseSource,
  removeAttribute,
  removeElement,
  setAttribute,
  setText,
  type SourceElement,
} from "./uiEdit/markupText";
import { formatValue, kebab, resolveUIElement, type UIElementRef } from "./uiDocuments";
import { selectUIElement } from "./inspectorTarget";
import type { UndoStep } from "./undoStep";

// --- Where an element is written ------------------------------------------------------------------

/** Where an element accepted by `editableElement` (never a list row) is written: the UI document's answer (ADR 0298). */
const sourceOf = (el: UIDocumentElement): UIElementSource => elementSource(el)!;

// --- Edits as one step ----------------------------------------------------------------------------

/** The texts an edit reads and writes, before they become one `WriteFiles` command. */
class FileEdits {
  private readonly texts = new Map<string, string | null>();
  private readonly original = new Map<string, string | null>();
  private readonly order: string[] = [];

  constructor(private readonly host: TextFileHost) {}

  private load(path: string): string | null {
    if (!this.texts.has(path)) {
      const text = this.host.read(path);
      this.original.set(path, text);
      this.texts.set(path, text);
    }
    return this.texts.get(path)!;
  }

  exists(path: string): boolean {
    return this.load(path) !== null;
  }

  read(path: string): string {
    const text = this.load(path);
    if (text === null) throw new MarkupEditError(`There's no file ${path}.`);
    return text;
  }

  write(path: string, text: string): void {
    this.load(path);
    this.texts.set(path, text);
    if (!this.order.includes(path)) this.order.push(path);
  }

  /** The tag at `place`, checked against what the live tree expects (the file may have changed). */
  tag(place: MarkupPlace, expected: string): SourceElement {
    const el = elementAt(parseSource(this.read(place.file)), place.path);
    if (!el || el.tag !== expected) throw new MarkupEditError(`${place.file} changed since the document was built; try again once it reloads.`);
    return el;
  }

  /** Apply a text edit to a file. */
  edit(file: string, change: (text: string) => string): void {
    this.write(file, change(this.read(file)));
  }

  get writes(): FileWrite[] {
    return this.order.filter((p) => this.texts.get(p) !== this.original.get(p)).map((path) => ({ path, text: this.texts.get(path)! }));
  }
}

/** The open scene if UI documents can be edited now (the edit gate, ADR 0247); otherwise says why in the status bar. */
const editableScene = (): OpenScene | null => editableNow({ kind: "ui-documents" });

/** Run `build` and record what it wrote as one undoable step. False (with a status) when nothing changed or it failed. */
function commit(scene: OpenScene, label: string, build: (edits: FileEdits) => void): boolean {
  const host = scene.stack.files;
  if (!host) {
    status.value = { kind: "error", text: "This scene can't write files." };
    return false;
  }
  const edits = new FileEdits(host);
  try {
    build(edits);
    const writes = edits.writes;
    if (writes.length === 0) return false;
    scene.stack.execute(new WriteFiles(label, writes));
    return true;
  } catch (err) {
    status.value = err instanceof MarkupEditError ? { kind: "info", text: `Couldn't ${label.toLowerCase()}: ${err.message}` } : errorStatus(`Couldn't ${label.toLowerCase()}`, err);
    return false;
  }
}

/** The live element a ref names if it can be edited; otherwise says why in the status bar. */
function editableElement(scene: OpenScene, ref: UIElementRef): UIDocumentElement | null {
  const el = resolveUIElement(scene.sync, ref);
  const reason = !el ? "it's gone (its document changed)" : !elementSource(el) ? "it's made by a script (a list row)" : null;
  if (reason) {
    status.value = { kind: "info", text: `Can't edit that element: ${reason}.` };
    return null;
  }
  return el;
}

/**
 * Start a gesture whose edits are one undo step (a scene-view handle drag): every `setUIElementAttributes` until the
 * returned step ends joins it; cancelling it puts back every file it wrote (Escape). Null, with the reason in the
 * status bar, when UI documents can't be edited now (the edit gate, ADR 0231, 0247).
 */
export function beginUIEdit(label: string): UndoStep | null {
  return beginEditStep({ kind: "ui-documents" }, label);
}

// --- Names and paths ------------------------------------------------------------------------------

const ID_PATTERN = /^[A-Za-z_][\w-]*$/;
const CLASS_PATTERN = /^-?[A-Za-z_][\w-]*$/;

/** The names an attribute for `name` may be written as (`flexDirection` and `flex-direction`). */
function aliasesOf(name: string): string[] {
  return [...new Set([name, kebab(camelCase(name)), camelCase(name)])];
}

/** A ref in the document `ref` names, at `path`. */
const refAt = (ref: { readonly host: string; readonly index: number }, path: string): UIElementRef => ({ host: ref.host, index: ref.index, path });

// --- Values ---------------------------------------------------------------------------------------

/** Number fields that are lengths, written with `px` in stylesheets. */
const PX_FIELDS: ReadonlySet<string> = new Set([
  "gap", "padding", "margin", "borderRadius", "borderWidth", "fontSize",
  // ADR 0418 wave 1
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "marginTop", "marginRight", "marginBottom", "marginLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
]);
/** String fields that hold a length (`auto`, `50%`, or pixels). */
const LENGTH_FIELDS: ReadonlySet<string> = new Set(["width", "height", "top", "right", "bottom", "left", "minWidth", "minHeight", "maxWidth", "maxHeight", "flexBasis"]);

/** The field a component of `el` has for an attribute name, or null. */
function fieldInfo(el: UIDocumentElement, name: string): FieldInfo | null {
  const field = camelCase(name);
  return getFields(el.component.constructor as never).find((f) => f.name === field) ?? null;
}

/** A field value as an attribute writes it: colours as hex (`none` for no fill), vectors as `x y`. */
export function attributeText(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value;
  return formatValue(value);
}

const pixels = (n: number) => (n === 0 ? "0" : `${n}px`);

/** An attribute's value as a stylesheet declaration writes it: colours as hex, lengths with `px`, assets as `url()` (Move to class, here and for Svelte UI). */
export function cssValue(info: FieldInfo | null, raw: string): string {
  const v = raw.trim();
  if (!info || v.includes("var(")) return v;
  const number = /^-?(\d+\.?\d*|\.\d+)(px)?$/.test(v) ? parseFloat(v) : null;
  if (info.type === Color) {
    const c = parseColor(v);
    return c === null ? "none" : c ? formatValue(c) : v;
  }
  if (info.type === Number) return PX_FIELDS.has(info.name) && number !== null ? pixels(number) : v;
  if (info.type === AssetRef) return v === "" ? '""' : `url("${v.replace(/^asset:/, "")}")`;
  if (info.type === String) {
    if (LENGTH_FIELDS.has(info.name)) return number !== null ? pixels(number) : v;
    if (Array.isArray(info.options?.choices) || /^[\w-]+$/.test(v)) return v;
    return v.includes('"') ? `'${v}'` : `"${v}"`;
  }
  return v;
}

/** Why `raw` isn't a valid value for the field, or null (bindings and variables aren't checked). */
function invalidValue(el: UIDocumentElement, info: FieldInfo, raw: string): string | null {
  if (hasBinding(raw) || raw.includes("var(")) return null;
  return convertValue(raw, info, sourceOf(el).file) === undefined ? `"${raw}" isn't a valid ${kebab(info.name)}` : null;
}

// --- Attributes and content -----------------------------------------------------------------------

/** Fields whose value is the element's text content. */
const CONTENT_FIELD: Readonly<Record<string, string>> = { Text: "text", Button: "text", InputField: "value" };

/** Write attribute edits on `el` into `edits` (see `setUIElementAttributes`). */
function writeAttributes(edits: FileEdits, el: UIDocumentElement, attributes: Readonly<Record<string, string | null>>): void {
  const src = sourceOf(el);
  if (src.label) throw new MarkupEditError("a button's label is its text content; set its fields on the button or in a stylesheet");
  const own = src.place, use = src.usePlace;
  for (const [name, value] of Object.entries(attributes)) {
    const aliases = name === "id" || name === "class" ? [name] : aliasesOf(name);
    const places = use ? [use, own] : [own];
    if (value === null) {
      for (const place of places) {
        const tag = edits.tag(place, place === use ? "Use" : el.tag);
        for (const a of tag.attributes) if (aliases.includes(a.name)) edits.edit(place.file, (t) => removeAttribute(t, place.path, a.name));
      }
      continue;
    }
    // Where it's written already (the <Use> tag first: it overrides the used root's own).
    let target = own, written: string | null = null;
    for (const place of places) {
      const found = edits.tag(place, place === use ? "Use" : el.tag).attributes.find((a) => aliases.includes(a.name));
      if (found) {
        target = place;
        written = found.name;
        break;
      }
    }
    const attr = written ?? (name === "id" || name === "class" ? name : kebab(camelCase(name)));
    edits.edit(target.file, (t) => setAttribute(t, target.path, attr, value));
  }
}

/**
 * Set or remove (null) attributes on an element in its markup file, as one undoable step: the API
 * the Inspector and scene-view handles use. Names are attribute or field names (`flex-direction`,
 * `flexDirection`, `id`, `class`); an attribute already written under either spelling keeps it,
 * new ones are written kebab-case. Values are written as given (see `attributeText`). Inside
 * a `beginUIEdit` step it joins that gesture's step. Returns true if a file changed.
 */
export function setUIElementAttributes(ref: UIElementRef, attributes: Readonly<Record<string, string | null>>, label?: string): boolean {
  const scene = editableScene();
  const el = scene && editableElement(scene, ref);
  if (!scene || !el) return false;
  const names = Object.keys(attributes);
  const text = label ?? (names.length === 1 ? `${attributes[names[0]] === null ? "Reset" : "Set"} ${names[0]}` : `Set ${names.length} attributes`);
  return commit(scene, text, (edits) => writeAttributes(edits, el, attributes));
}

/** Set an element's text content (a Text's text, a Button's label, an InputField's value). */
function setUIElementText(ref: UIElementRef, text: string): boolean {
  const scene = editableScene();
  const found = scene && editableElement(scene, ref);
  if (!scene || !found) return false;
  const el = sourceOf(found).label ? found.parent! : found;
  if (!CONTENT_FIELD[el.tag]) {
    status.value = { kind: "info", text: `<${el.tag}> has no text content.` };
    return false;
  }
  return commit(scene, `Set ${el.tag === "InputField" ? "value" : "text"}`, (edits) => {
    const own = sourceOf(el).place;
    edits.tag(own, el.tag);
    edits.edit(own.file, (t) => setText(t, own.path, text));
  });
}

/**
 * The Inspector's edit of one field: `raw` as typed (attribute syntax: `#ff0000`, `12`, `auto`,
 * `50%`, `{binding}`), or null to reset it (remove the attribute, or clear the text content). The
 * text field of a Text, Button label or InputField (its `value`) is the element's text content
 * unless an attribute sets it. Anything else becomes an attribute, overriding rules and inheritance.
 */
export function setUIElementField(ref: UIElementRef, field: string, raw: string | null): boolean {
  const scene = editableScene();
  const el = scene && editableElement(scene, ref);
  if (!scene || !el) return false;
  const src = sourceOf(el);
  const contentField = src.label ? "text" : CONTENT_FIELD[el.tag];
  if (field === contentField && (src.label || !src.attributes.some((a) => aliasesOf(field).includes(a.name)))) {
    return setUIElementText(ref, raw ?? "");
  }
  const info = fieldInfo(el, field);
  if (!info) {
    status.value = { kind: "info", text: `<${el.tag}> has no field "${field}".` };
    return false;
  }
  if (raw !== null) {
    const problem = invalidValue(el, info, raw);
    if (problem) {
      status.value = { kind: "error", text: `${problem}.` };
      return false;
    }
  }
  return setUIElementAttributes(ref, { [field]: raw }, `${raw === null ? "Reset" : "Set"} ${kebab(field)}`);
}

// --- Localised text (ADR 0356 §4, §9) ---------------------------------------------------------------

/** The element a text field's markup belongs to: a button's label edits the button's text content. */
const textHost = (el: UIDocumentElement): UIDocumentElement => (sourceOf(el).label ? el.parent! : el);

/** The key a text field is bound to (`t:<field>="key"`), or null. */
export function uiElementKey(el: UIDocumentElement, field: string): string | null {
  const host = textHost(el);
  if (!elementSource(host)) return null;
  const names = aliasesOf(field).map((n) => `t:${n}`);
  return sourceOf(host).attributes.find((a) => names.includes(a.name))?.value.trim() || null;
}

/** The literal text a field has in the markup (its attribute, or the text content for the content field), or null. */
export function uiElementLiteral(el: UIDocumentElement, field: string): string | null {
  const host = textHost(el);
  if (!elementSource(host)) return null;
  const src = sourceOf(host);
  const attr = src.attributes.find((a) => aliasesOf(field).includes(a.name));
  if (attr) return attr.value;
  return field === CONTENT_FIELD[host.tag] ? src.text : null;
}

/** Write `t:<field>="key"` on `el` and clear the field's literal text (its attribute, or the text content). */
function writeKey(edits: FileEdits, el: UIDocumentElement, field: string, key: string): void {
  const own = sourceOf(el).place;
  const tag = edits.tag(own, el.tag);
  edits.edit(own.file, (t) => setAttribute(t, own.path, `t:${field}`, key));
  for (const a of tag.attributes) if (aliasesOf(field).includes(a.name)) edits.edit(own.file, (t) => removeAttribute(t, own.path, a.name));
  if (field === CONTENT_FIELD[el.tag]) edits.edit(own.file, (t) => setText(t, own.path, ""));
}

/**
 * Bind a text field (a Text's or Button's text, an InputField's value or placeholder) to a string key, as one undo
 * step: `t:<field>="key"` on the element, its literal text removed. `key` null removes the binding instead.
 */
export function localiseUIElement(ref: UIElementRef, field: string, key: string | null): boolean {
  const scene = editableScene();
  const found = scene && editableElement(scene, ref);
  if (!scene || !found) return false;
  const el = textHost(found);
  if (key === null) {
    return commit(scene, `Unlink ${field} from its key`, (edits) => {
      const own = sourceOf(el).place;
      const tag = edits.tag(own, el.tag);
      for (const a of tag.attributes) if (aliasesOf(field).map((n) => `t:${n}`).includes(a.name)) edits.edit(own.file, (t) => removeAttribute(t, own.path, a.name));
    });
  }
  return commit(scene, `Localise ${field}`, (edits) => writeKey(edits, el, field, key));
}

/**
 * Extract to string table (ADR 0356 §9): write `tableText` (the table with the new key, `localiseModel.ts`'s
 * `extractToTable`) to `tablePath` and bind the field to `key`, both files in one undo step.
 */
export function extractUIElementText(ref: UIElementRef, field: string, key: string, tablePath: string, tableText: string): boolean {
  const scene = editableScene();
  const found = scene && editableElement(scene, ref);
  if (!scene || !found) return false;
  const el = textHost(found);
  return commit(scene, `Extract ${field} to ${tablePath.slice(tablePath.lastIndexOf("/") + 1)}`, (edits) => {
    writeKey(edits, el, field, key);
    edits.write(tablePath, tableText);
  });
}

/** Set or clear (empty) an element's id, keeping it selected. Ids are unique in a file. */
export function renameUIElement(ref: UIElementRef, id: string): boolean {
  const scene = editableScene();
  const el = scene && editableElement(scene, ref);
  if (!scene || !el) return false;
  const next = id.trim();
  if (next === (el.id ?? "")) return false;
  if (next && !ID_PATTERN.test(next)) {
    status.value = { kind: "info", text: `"${next}" isn't a valid id: use letters, digits, - and _, starting with a letter.` };
    return false;
  }
  const src = sourceOf(el);
  const site = src.usePlace ?? src.place;
  if (next && scene.stack.files && idsIn(scene.stack.files.read(site.file) ?? "").has(next)) {
    status.value = { kind: "info", text: `Another element in ${site.file} is #${next} already.` };
    return false;
  }
  const renamed = el.parent ? childPath(el.parent, src.index, el.tag, next || null) : src.path;
  const done = commit(scene, next ? `Rename to #${next}` : "Remove id", (edits) => writeAttributes(edits, el, { id: next || null }));
  if (done && el.parent) selectUIElement(refAt(ref, renamed));
  return done;
}

/** Set an element's classes (space-separated; empty removes the attribute). */
export function setUIElementClasses(ref: UIElementRef, classes: string): boolean {
  const list = classes.split(/\s+/).filter(Boolean);
  const bad = list.find((c) => !CLASS_PATTERN.test(c));
  if (bad) {
    status.value = { kind: "info", text: `"${bad}" isn't a valid class name.` };
    return false;
  }
  return setUIElementAttributes(ref, { class: list.length ? list.join(" ") : null }, "Set class");
}

// --- Structure --------------------------------------------------------------------------------------

/** Delete an element from its markup (not a document's root), selecting its parent. */
export function deleteUIElement(ref: UIElementRef): boolean {
  const scene = editableScene();
  const el = scene && editableElement(scene, ref);
  if (!scene || !el) return false;
  const src = sourceOf(el);
  if (src.label) return setUIElementText(ref, ""); // a button's label: clear the text content
  const site = src.sitePlace;
  if (!site || !el.parent) {
    status.value = { kind: "info", text: "A document's root element can't be deleted (remove the UIDocument, or the file)." };
    return false;
  }
  const parentPath = sourceOf(el.parent).path;
  const done = commit(scene, `Delete ${el.id ? `#${el.id}` : `<${el.tag}>`}`, (edits) => {
    edits.tag(site, src.usePlace ? "Use" : el.tag);
    edits.edit(site.file, (t) => removeElement(t, site.path));
  });
  if (done) selectUIElement(refAt(ref, parentPath));
  return done;
}

/** Duplicate an element right after itself (fresh ids), selecting the copy. */
export function duplicateUIElement(ref: UIElementRef): boolean {
  const scene = editableScene();
  const el = scene && editableElement(scene, ref);
  if (!scene || !el) return false;
  const src = sourceOf(el);
  const site = src.sitePlace;
  if (!site || !el.parent) {
    status.value = { kind: "info", text: src.label ? "A button's label is its text content: duplicate the button." : "A document's root element can't be duplicated." };
    return false;
  }
  const parent = el.parent;
  let copyPath = "";
  const done = commit(scene, `Duplicate ${el.id ? `#${el.id}` : `<${el.tag}>`}`, (edits) => {
    edits.tag(site, src.usePlace ? "Use" : el.tag);
    const result = duplicateElement(edits.read(site.file), site.path);
    edits.write(site.file, result.text);
    const copyId = elementAt(parseSource(result.text), result.path)?.attributes.find((a) => a.name === "id")?.value ?? null;
    copyPath = childPath(parent, src.index + 1, el.tag, copyId ?? (src.usePlace ? el.id : null));
  });
  if (done) selectUIElement(refAt(ref, copyPath));
  return done;
}

/** True if `a` is `b` or inside it. */
function within(a: UIDocumentElement, b: UIDocumentElement): boolean {
  for (let e: UIDocumentElement | null = a; e; e = e.parent) if (e === b) return true;
  return false;
}

/** Why `ref` can't move into `parentRef` (both in the same document, in the same file), or null. */
export function whyNotMovable(ref: UIElementRef, parentRef: UIElementRef): string | null {
  const scene = openScene.peek();
  const el = scene && resolveUIElement(scene.sync, ref), parent = scene && resolveUIElement(scene.sync, parentRef);
  if (!el || !parent) return "it's gone";
  const src = elementSource(el), parentSrc = elementSource(parent);
  if (!src || !parentSrc) return "list rows are made by a script";
  if (src.label || parentSrc.label) return "a button's label is its text content";
  if (ref.host !== parentRef.host || ref.index !== parentRef.index) return "elements move within their own document";
  if (!el.parent || !src.sitePlace) return "the root element stays the root";
  if (within(parent, el)) return "an element can't go inside itself";
  const site = src.sitePlace, into = parentSrc.place;
  if (site.file !== into.file) return `elements move within their own file (this one is in ${site.file})`;
  return null;
}

/**
 * Move an element to be the `index`th child of `parentRef` (as the children are now, counting it
 * if it's there already; past the end: last), within its file. Selects it at its new place.
 */
export function moveUIElement(ref: UIElementRef, parentRef: UIElementRef, index: number): boolean {
  const scene = editableScene();
  const el = scene && editableElement(scene, ref);
  if (!scene || !el) return false;
  const reason = whyNotMovable(ref, parentRef);
  if (reason) {
    status.value = { kind: "info", text: `Can't move it there: ${reason}.` };
    return false;
  }
  const parent = resolveUIElement(scene.sync, parentRef)!;
  const src = sourceOf(el), parentSrc = sourceOf(parent);
  const site = src.sitePlace!, into = parentSrc.place;
  const from = src.index;
  const sameParent = el.parent === parent;
  const others = parentSrc.childCount - (sameParent ? 1 : 0);
  const at = Math.max(0, Math.min(sameParent && from < index ? index - 1 : index, others));
  if (sameParent && at === from) return false;
  const moved = childPath(parent, at, el.tag, el.id, el);
  const done = commit(scene, `Move ${el.id ? `#${el.id}` : `<${el.tag}>`}`, (edits) => {
    edits.tag(site, src.usePlace ? "Use" : el.tag);
    edits.tag(into, parent.tag);
    edits.write(site.file, moveElement(edits.read(site.file), site.path, into.path, index).text);
  });
  if (done) selectUIElement(refAt(ref, moved));
  return done;
}

/** New elements' starting markup (sizes and looks like the hand-built UI Create menu's, ADR 0069). */
/** ADR 0426: inline SVG, video and audio are Svelte UI's (the HTML elements), not offered for UI documents. */
export const NEW_ELEMENTS: Readonly<Record<Exclude<UITag, "Canvas" | "Svg" | "Video" | "Audio">, string>> = {
  Panel: `<Panel width="200" height="100" background-color="#2a2f3a"/>`,
  Text: `<Text>New Text</Text>`,
  Image: `<Image width="100" height="100"/>`,
  Button: `<Button width="160" height="40">Button</Button>`,
  InputField: `<InputField placeholder="Enter text…"/>`,
  // ADR 0424: form elements.
  TextArea: `<TextArea placeholder="Enter text…"/>`,
  Toggle: `<Toggle/>`,
  Radio: `<Radio name="choice"/>`,
  Slider: `<Slider/>`,
  Select: `<Select><Option>One</Option><Option>Two</Option></Select>`,
  Option: `<Option>Option</Option>`,
  Progress: `<Progress value="0.5"/>`,
  Meter: `<Meter value="0.5"/>`,
  Label: `<Label>Label</Label>`,
  Form: `<Form/>`,
};

/** Elements that hold other elements when you create into them; into anything else, new elements go after it. */
const CONTAINERS: ReadonlySet<string> = new Set(["Canvas", "Panel", "Select", "Label", "Form"]);

/**
 * Add a new element into a document, as one undo step, and select it: into the element `at` names
 * (after it, when it's a Text, Image, Button or InputField), or into the root of the document
 * `{ host, index }` names. Returns its ref, or null.
 */
export function createUIElement(tag: keyof typeof NEW_ELEMENTS, at: UIElementRef | { readonly host: string; readonly index: number }): UIElementRef | null {
  const scene = editableScene();
  if (!scene) return null;
  let parent: UIDocumentElement | null, index: number;
  const docRef = { host: at.host, index: at.index };
  if ("path" in at) {
    const found = editableElement(scene, at);
    if (!found) return null;
    const el = sourceOf(found).label ? found.parent! : found;
    if (CONTAINERS.has(el.tag) || !el.parent) {
      parent = el;
      index = sourceOf(el).childCount;
    } else {
      parent = el.parent;
      index = sourceOf(el).index + 1;
    }
  } else {
    const root = resolveUIElement(scene.sync, { ...docRef, path: "" });
    if (!root) {
      status.value = { kind: "info", text: "That UIDocument has no elements yet (its file is missing or empty)." };
      return null;
    }
    parent = root;
    index = sourceOf(root).childCount;
  }
  const into = sourceOf(parent).place;
  const ref = refAt(docRef, childPath(parent, index, tag, null));
  const done = commit(scene, `Create ${tag}`, (edits) => {
    edits.tag(into, parent!.tag);
    edits.edit(into.file, (t) => insertElement(t, into.path, index, NEW_ELEMENTS[tag]));
  });
  if (!done) return null;
  selectUIElement(ref);
  return ref;
}

// --- Move to class ------------------------------------------------------------------------------

/** A class name for an element's attributes: its id, else its tag in lower case. */
export function suggestedClassName(el: UIDocumentElement): string {
  return el.id ?? el.tag.toLowerCase();
}

/** The attributes Move to class moves: not `id`, `class` or bound ones. */
export function movableAttributes(el: UIDocumentElement): string[] {
  const src = elementSource(el);
  if (!src || src.label) return [];
  return src.attributes.filter((a) => a.name !== "id" && a.name !== "class" && !hasBinding(a.value)).map((a) => a.name);
}

/**
 * Move an element's attributes (not `id`, `class` or bindings) into a class rule, as one undo step:
 * `.name { … }` in its file's first stylesheet is added or extended (kebab-case properties, colours
 * as hex, lengths in px), the element gets the class, and the attributes go. Without a stylesheet,
 * `<name>.ui.css` is made beside the markup and linked with `<Style src>`.
 */
export function moveUIElementToClass(ref: UIElementRef, className?: string): boolean {
  const scene = editableScene();
  const el = scene && editableElement(scene, ref);
  if (!scene || !el) return false;
  const src = sourceOf(el);
  if (src.label) {
    status.value = { kind: "info", text: "A button's label has no attributes of its own: move the button's." };
    return false;
  }
  const name = (className ?? suggestedClassName(el)).trim().replace(/^\./, "");
  if (!CLASS_PATTERN.test(name)) {
    status.value = { kind: "info", text: `"${name}" isn't a valid class name.` };
    return false;
  }
  const own = src.place;
  let moved = 0;
  let shadowed: string[] = [];
  const done = commit(scene, `Move to class .${name}`, (edits) => {
    const tag = edits.tag(own, el.tag);
    const attrs = tag.attributes.filter((a) => a.name !== "id" && a.name !== "class" && !hasBinding(a.value));
    if (attrs.length === 0) throw new MarkupEditError(`${el.id ? `#${el.id}` : `<${el.tag}>`} has no attributes to move`);
    moved = attrs.length;
    shadowed = moreSpecificRules(el, name, attrs.map((a) => kebab(camelCase(a.name))));
    const root = parseSource(edits.read(own.file))!;
    const style = root.nodes.find((n) => n.tag === "Style" && n.attributes.some((a) => a.name === "src" && a.value));
    const src = style?.attributes.find((a) => a.name === "src")!.value;
    const base = own.file.split("/").pop()!.replace(/(\.ui)?\.xml$/i, "");
    const sheet = src ? resolvePath(own.file, src) : resolvePath(own.file, `${base}.ui.css`);
    const declarations = attrs.map((a) => [kebab(camelCase(a.name)), cssValue(fieldInfo(el, a.name), a.value)] as const);
    const css = edits.exists(sheet) ? edits.read(sheet) : "";
    edits.write(sheet, css === "" ? addRule(`/* Styles for ${own.file.split("/").pop()} (ADR 0077). */\n`, `.${name}`, declarations) : setDeclarations(css, `.${name}`, declarations));
    // The markup: the class, then each attribute removed (re-parsed after each edit).
    const classes = (tag.attributes.find((a) => a.name === "class")?.value ?? "").split(/\s+/).filter(Boolean);
    if (!classes.includes(name)) edits.edit(own.file, (t) => setAttribute(t, own.path, "class", [...classes, name].join(" ")));
    for (const a of attrs) edits.edit(own.file, (t) => removeAttribute(t, own.path, a.name));
    if (!src) edits.edit(own.file, (t) => addStyle(t, `${base}.ui.css`));
  });
  if (done) {
    const note = shadowed.length ? ` More specific rules still win for it: ${shadowed.join(", ")}.` : "";
    status.value = { kind: "info", text: `Moved ${moved === 1 ? "1 attribute" : `${moved} attributes`} to .${name}.${note}` };
  }
  return done;
}

/**
 * Rules more specific than `.name` that set any of `properties` on the element once it has the
 * class: attributes beat every rule, so moving them into `.name` can let these show through.
 */
function moreSpecificRules(el: UIDocumentElement, name: string, properties: readonly string[]): string[] {
  const target = { ...el._target, classes: [...el._target.classes, name] };
  const out: string[] = [];
  for (const sheet of el.document._sheets) {
    for (const rule of sheet.rules) {
      const spec = rule.selectors.filter((s) => matchSelector(s, target)).map((s) => s.specificity);
      if (!spec.some(([ids, classes, tags]) => ids > 0 || classes > 1 || (classes === 1 && tags > 0))) continue;
      for (const d of rule.declarations) if (properties.includes(d.property)) out.push(`${rule.selectorText} { ${d.property} }`);
    }
  }
  return out;
}

