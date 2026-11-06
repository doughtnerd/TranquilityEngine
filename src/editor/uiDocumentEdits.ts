// Editing UI documents from the editor (ADR 0077 §4, wave B part 2): Inspector fields, text content,
// ids and classes, Move to class, Create, and the hierarchy's rename, delete, duplicate and drag, all
// written back to the markup and stylesheet files with edits that change only their own text
// (`uiEdit/markupText.ts`, `uiEdit/cssText.ts`).
//
// Every edit is one command on the open scene's CommandStack (`WriteFiles`), so Ctrl+Z undoes UI
// edits in order with scene edits, and the History panel lists them. The stack writes the files
// through its file host (`textFiles.ts`), whose writes update `Assets`, so the document rebuilds in
// the Editor World the next frame and the selection (a ref by path) follows. A gesture (a scene-view
// handle drag) wraps its edits in `beginUIEdit`/`endUIEdit` to make one step.
//
// An element is edited in its own file: elements from a `<Use>` live in the used document. Moving,
// deleting or duplicating a used document's root acts on its `<Use>` tag; attributes written on the
// `<Use>` tag (which override the used root's) are edited there. List rows (no path) aren't the
// file's and can't be edited; neither can read-only projects (samples) or anything while playing.
import type { UIDocumentElement } from "../engine";
import { Color } from "../engine/core/math";
import { AssetRef, getFields, type FieldInfo } from "../engine/core/registry";
import { hasBinding, resolvePath } from "../engine/ui/document/markup";
import { camelCase, convertValue, matchSelector, parseColor } from "../engine/ui/document/stylesheet";
import type { MarkupElement, UITag } from "../engine/ui/document/types";
import { WriteFiles, type FileWrite, type TextFileHost } from "./document";
import { errorStatus } from "./messages";
import type { EditorProject } from "./projects";
import { currentProject, openScene, playState, status, type OpenScene } from "./state";
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
import { formatValue, kebab, resolveUIElement, selectUIElement, type UIElementRef } from "./uiDocuments";

// --- Where an element is written ------------------------------------------------------------------

/** A tag in a file: the file and its path among element children from the file's root. */
export interface MarkupPlace {
  readonly file: string;
  readonly path: readonly number[];
}

/** Index of an element among its parent's markup children (-1 for the root or a button's label). */
const childIndex = (el: UIDocumentElement) => (el.parent ? el.parent._markup.children.indexOf(el._markup) : -1);

/** The element's own tag: in its file (a used document's root is that file's root, path []). */
export function ownPlace(el: UIDocumentElement): MarkupPlace {
  const file = el._markup.file;
  const path: number[] = [];
  for (let e = el; e.parent && !e._markup.from && e.parent._markup.file === file; e = e.parent) path.unshift(childIndex(e));
  return { file, path };
}

/** For a used document's root: its `<Use>` tag in the parent's file. Null otherwise. */
export function usePlace(el: UIDocumentElement): MarkupPlace | null {
  if (!el._markup.from || !el.parent) return null;
  const parent = ownPlace(el.parent);
  return { file: parent.file, path: [...parent.path, childIndex(el)] };
}

/** Where the element sits among its siblings (its `<Use>` tag for a used root); null for the document's root. */
export function sitePlace(el: UIDocumentElement): MarkupPlace | null {
  if (!el.parent) return null;
  return usePlace(el) ?? ownPlace(el);
}

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

/** Why UI documents can't be edited now, or null when they can. */
export function whyNotEditableUI(project: EditorProject | null = currentProject.peek()): string | null {
  if (!openScene.peek() || !project) return "no scene is open";
  if (!project.canSave) return `${project.name} is read-only. Open a project folder (or copy the sample) to edit its UI documents`;
  if (playState.peek() !== "edit") return "stop playing to edit UI documents";
  return null;
}

/** The open scene if UI documents can be edited now; otherwise says why in the status bar. */
function editableScene(): OpenScene | null {
  const reason = whyNotEditableUI();
  if (reason) {
    status.value = { kind: "info", text: `Can't edit the UI document: ${reason}.` };
    return null;
  }
  return openScene.peek();
}

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
    if (gesture) for (const w of writes) if (!gesture.before.has(w.path)) gesture.before.set(w.path, host.read(w.path));
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
  const reason = !el ? "it's gone (its document changed)" : el._path === null ? "it's made by a script (a list row)" : null;
  if (reason) {
    status.value = { kind: "info", text: `Can't edit that element: ${reason}.` };
    return null;
  }
  return el;
}

/**
 * Start a gesture whose edits are one undo step (a scene-view handle drag): every
 * `setUIElementAttributes` until `endUIEdit` joins it. Returns false when UI documents can't be
 * edited now (then don't call `endUIEdit`).
 */
export function beginUIEdit(label: string): boolean {
  const scene = editableScene();
  if (!scene) return false;
  scene.stack.beginGroup(label);
  gesture = { scene, before: new Map() };
  return true;
}

/** The gesture in progress: the files it wrote, as they were before it. */
let gesture: { scene: OpenScene; before: Map<string, string | null> } | null = null;

/** End the gesture `beginUIEdit` started. */
export function endUIEdit(): void {
  const scene = gesture?.scene ?? openScene.peek();
  gesture = null;
  scene?.stack.endGroup();
}

/**
 * End the gesture `beginUIEdit` started, putting back every file it wrote as it was (Escape during a
 * handle drag). The step then changed nothing, so nothing is recorded.
 */
export function cancelUIEdit(): void {
  const g = gesture;
  gesture = null;
  if (!g) return;
  const host = g.scene.stack.files;
  const writes = host ? [...g.before].filter(([path, text]) => host.read(path) !== text).map(([path, text]) => ({ path, text })) : [];
  try {
    if (writes.length) g.scene.stack.execute(new WriteFiles("Cancel", writes));
  } finally {
    g.scene.stack.endGroup();
  }
}

// --- Names and paths ------------------------------------------------------------------------------

const ID_PATTERN = /^[A-Za-z_][\w-]*$/;
const CLASS_PATTERN = /^-?[A-Za-z_][\w-]*$/;

/** The names an attribute for `name` may be written as (`flexDirection` and `flex-direction`). */
function aliasesOf(name: string): string[] {
  return [...new Set([name, kebab(camelCase(name)), camelCase(name)])];
}

const idOf = (m: MarkupElement) => m.attributes.find((a) => a.name === "id")?.value ?? null;

/** The path segment of the element with `tag`/`id` at `index` among `siblings` (the others, in order). */
function segment(siblings: readonly MarkupElement[], index: number, tag: string, id: string | null): string {
  if (id) return `/#${id}`;
  return `/${tag}[${siblings.slice(0, index).filter((s) => s.tag === tag).length}]`;
}

/** A ref to a child of `parent` (a live element) at `segment`. */
const childRef = (ref: UIElementRef, parent: UIDocumentElement, seg: string): UIElementRef => ({ host: ref.host, index: ref.index, path: `${parent._path}${seg}` });

// --- Values ---------------------------------------------------------------------------------------

/** Number fields that are lengths, written with `px` in stylesheets. */
const PX_FIELDS: ReadonlySet<string> = new Set(["gap", "padding", "margin", "borderRadius", "borderWidth", "fontSize"]);
/** String fields that hold a length (`auto`, `50%`, or pixels). */
const LENGTH_FIELDS: ReadonlySet<string> = new Set(["width", "height", "top", "right", "bottom", "left"]);

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

/** An attribute's value as a stylesheet declaration writes it: colours as hex, lengths with `px`, assets as `url()`. */
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
  return convertValue(raw, info, el._markup.file) === undefined ? `"${raw}" isn't a valid ${kebab(info.name)}` : null;
}

// --- Attributes and content -----------------------------------------------------------------------

/** Fields whose value is the element's text content. */
const CONTENT_FIELD: Readonly<Record<string, string>> = { Text: "text", Button: "text", InputField: "value" };

/** Write attribute edits on `el` into `edits` (see `setUIElementAttributes`). */
function writeAttributes(edits: FileEdits, el: UIDocumentElement, attributes: Readonly<Record<string, string | null>>): void {
  if (el._synthetic) throw new MarkupEditError("a button's label is its text content; set its fields on the button or in a stylesheet");
  const own = ownPlace(el), use = usePlace(el);
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
 * `beginUIEdit`/`endUIEdit` it joins that gesture's step. Returns true if a file changed.
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
export function setUIElementText(ref: UIElementRef, text: string): boolean {
  const scene = editableScene();
  const found = scene && editableElement(scene, ref);
  if (!scene || !found) return false;
  const el = found._synthetic ? found.parent! : found;
  if (!CONTENT_FIELD[el.tag]) {
    status.value = { kind: "info", text: `<${el.tag}> has no text content.` };
    return false;
  }
  return commit(scene, `Set ${el.tag === "InputField" ? "value" : "text"}`, (edits) => {
    const own = ownPlace(el);
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
  const owner = el._synthetic ? el.parent! : el;
  const contentField = el._synthetic ? "text" : CONTENT_FIELD[el.tag];
  if (field === contentField && (el._synthetic || !owner._markup.attributes.some((a) => aliasesOf(field).includes(a.name)))) {
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
  const site = usePlace(el) ?? ownPlace(el);
  if (next && scene.stack.files && idsIn(scene.stack.files.read(site.file) ?? "").has(next)) {
    status.value = { kind: "info", text: `Another element in ${site.file} is #${next} already.` };
    return false;
  }
  const done = commit(scene, next ? `Rename to #${next}` : "Remove id", (edits) => writeAttributes(edits, el, { id: next || null }));
  if (done && el.parent) {
    const siblings = el.parent._markup.children;
    selectUIElement(childRef(ref, el.parent, segment(siblings, childIndex(el), el.tag, next || null)));
  }
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
  if (el._synthetic) return setUIElementText(ref, ""); // a button's label: clear the text content
  const target = el;
  const site = sitePlace(target);
  if (!site || !target.parent) {
    status.value = { kind: "info", text: "A document's root element can't be deleted (remove the UIDocument, or the file)." };
    return false;
  }
  const parent = target.parent;
  const done = commit(scene, `Delete ${target.id ? `#${target.id}` : `<${target.tag}>`}`, (edits) => {
    edits.tag(site, target._markup.from ? "Use" : target.tag);
    edits.edit(site.file, (t) => removeElement(t, site.path));
  });
  if (done) selectUIElement({ host: ref.host, index: ref.index, path: parent._path! });
  return done;
}

/** Duplicate an element right after itself (fresh ids), selecting the copy. */
export function duplicateUIElement(ref: UIElementRef): boolean {
  const scene = editableScene();
  const el = scene && editableElement(scene, ref);
  if (!scene || !el) return false;
  const site = sitePlace(el);
  if (!site || !el.parent || el._synthetic) {
    status.value = { kind: "info", text: el._synthetic ? "A button's label is its text content: duplicate the button." : "A document's root element can't be duplicated." };
    return false;
  }
  let copyId: string | null = null;
  const done = commit(scene, `Duplicate ${el.id ? `#${el.id}` : `<${el.tag}>`}`, (edits) => {
    edits.tag(site, el._markup.from ? "Use" : el.tag);
    const result = duplicateElement(edits.read(site.file), site.path);
    edits.write(site.file, result.text);
    copyId = elementAt(parseSource(result.text), result.path)?.attributes.find((a) => a.name === "id")?.value ?? null;
  });
  if (done) {
    const siblings = el.parent._markup.children;
    selectUIElement(childRef(ref, el.parent, segment(siblings, childIndex(el) + 1, el.tag, copyId ?? (el._markup.from ? el.id : null))));
  }
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
  if (el._path === null || parent._path === null) return "list rows are made by a script";
  if (el._synthetic || parent._synthetic) return "a button's label is its text content";
  if (ref.host !== parentRef.host || ref.index !== parentRef.index) return "elements move within their own document";
  if (!el.parent) return "the root element stays the root";
  if (within(parent, el)) return "an element can't go inside itself";
  const site = sitePlace(el)!, into = ownPlace(parent);
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
  const site = sitePlace(el)!, into = ownPlace(parent);
  const from = childIndex(el);
  const sameParent = el.parent === parent;
  const others = parent._markup.children.filter((m) => m !== el._markup);
  const at = Math.max(0, Math.min(sameParent && from < index ? index - 1 : index, others.length));
  if (sameParent && at === from) return false;
  const done = commit(scene, `Move ${el.id ? `#${el.id}` : `<${el.tag}>`}`, (edits) => {
    edits.tag(site, el._markup.from ? "Use" : el.tag);
    edits.tag(into, parent.tag);
    edits.write(site.file, moveElement(edits.read(site.file), site.path, into.path, index).text);
  });
  if (done) selectUIElement(childRef(ref, parent, segment(others, at, el.tag, el.id)));
  return done;
}

/** New elements' starting markup (sizes and looks like the hand-built UI Create menu's, ADR 0069). */
export const NEW_ELEMENTS: Readonly<Record<Exclude<UITag, "Canvas">, string>> = {
  Panel: `<Panel width="200" height="100" background-color="#2a2f3a"/>`,
  Text: `<Text>New Text</Text>`,
  Image: `<Image width="100" height="100"/>`,
  Button: `<Button width="160" height="40">Button</Button>`,
  InputField: `<InputField placeholder="Enter text…"/>`,
};

/** Elements that hold other elements when you create into them; into anything else, new elements go after it. */
const CONTAINERS: ReadonlySet<string> = new Set(["Canvas", "Panel"]);

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
    const el = found._synthetic ? found.parent! : found;
    if (CONTAINERS.has(el.tag) || !el.parent) {
      parent = el;
      index = el._markup.children.length;
    } else {
      parent = el.parent;
      index = childIndex(el) + 1;
    }
  } else {
    const root = resolveUIElement(scene.sync, { ...docRef, path: "" });
    if (!root) {
      status.value = { kind: "info", text: "That UIDocument has no elements yet (its file is missing or empty)." };
      return null;
    }
    parent = root;
    index = root._markup.children.length;
  }
  const into = ownPlace(parent);
  const done = commit(scene, `Create ${tag}`, (edits) => {
    edits.tag(into, parent!.tag);
    edits.edit(into.file, (t) => insertElement(t, into.path, index, NEW_ELEMENTS[tag]));
  });
  if (!done) return null;
  const ref = { ...docRef, path: `${parent._path}${segment(parent._markup.children, index, tag, null)}` };
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
  if (el._synthetic) return [];
  return el._markup.attributes.filter((a) => a.name !== "id" && a.name !== "class" && !hasBinding(a.value)).map((a) => a.name);
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
  if (el._synthetic) {
    status.value = { kind: "info", text: "A button's label has no attributes of its own: move the button's." };
    return false;
  }
  const name = (className ?? suggestedClassName(el)).trim().replace(/^\./, "");
  if (!CLASS_PATTERN.test(name)) {
    status.value = { kind: "info", text: `"${name}" isn't a valid class name.` };
    return false;
  }
  const own = ownPlace(el);
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
export function moreSpecificRules(el: UIDocumentElement, name: string, properties: readonly string[]): string[] {
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

// --- New documents ----------------------------------------------------------------------------------

/** The markup and stylesheet of a new UI document whose stylesheet is `css` (a file name beside it). */
export function newUIDocumentTexts(css: string): { markup: string; stylesheet: string } {
  return {
    markup: `<Canvas>\n  <Style src="${css}"/>\n  <Panel id="panel">\n    <Text id="title">New UI Document</Text>\n  </Panel>\n</Canvas>\n`,
    stylesheet: `/* The look of the document beside it (ADR 0077). */\n#panel {\n  width: 100%;\n  height: 100%;\n  justify-content: center;\n  align-items: center;\n}\n\n#title {\n  font-size: 32px;\n}\n`,
  };
}

/**
 * Create `New UI.ui.xml` with a matching `New UI.ui.css` (or `New UI 2`…) in `folder`: a Canvas
 * root with a panel and a title. Returns the markup's path, or null (read-only project, or a write
 * failed: the status says why).
 */
export async function createUIDocument(folder: string, base = "New UI"): Promise<string | null> {
  const project = currentProject.peek();
  if (!project) return null;
  if (!project.canSave) {
    status.value = { kind: "info", text: `${project.name} is read-only. Open a project folder (or copy the sample) to add UI documents.` };
    return null;
  }
  const join = (name: string) => (folder ? `${folder}/${name}` : name);
  const taken = (name: string) => project.files.includes(join(name));
  let stem = base;
  for (let n = 2; taken(`${stem}.ui.xml`) || taken(`${stem}.ui.css`); n++) stem = `${base} ${n}`;
  const { markup, stylesheet } = newUIDocumentTexts(`${stem}.ui.css`);
  try {
    await project.writeFile(join(`${stem}.ui.css`), stylesheet);
    await project.writeFile(join(`${stem}.ui.xml`), markup);
  } catch (err) {
    status.value = errorStatus(`Couldn't create ${stem}.ui.xml`, err);
    return null;
  }
  status.value = { kind: "info", text: `Created ${stem}.ui.xml and ${stem}.ui.css.` };
  return join(`${stem}.ui.xml`);
}
