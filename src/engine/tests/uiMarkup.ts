import { Assets } from "../scene/Assets";
import { GameObject } from "../scene/GameObject";
import { UIDocument } from "../ui/UIDocument";
import { UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText, type UIComponentType } from "../ui/components";

// Test helpers that make game UI the one way a game can (ADR 0417): markup built by a `UIDocument`. Call
// `loadUIDocumentSupport()` first (in `beforeEach`), so documents build as soon as they're added.

let count = 0;

/**
 * Build `markup` (a `*.ui.xml` document, with `css` as its stylesheet) on a new node under `parent` (the
 * active scene when null), as a project's document file would be. Throws on markup or stylesheet problems.
 */
export function buildUI(markup: string, options: { parent?: GameObject | null; css?: string; name?: string } = {}): UIDocument {
  const n = ++count;
  const path = `ui/test-${n}.ui.xml`;
  const files: Record<string, string> = {};
  if (options.css !== undefined) {
    files[`ui/test-${n}.ui.css`] = options.css;
    const style = `<Style src="test-${n}.ui.css"/>`;
    markup = markup.replace(/^\s*<([A-Za-z]+)([^>]*?)(\/?)>/, (_m, tag: string, attrs: string, selfClosing: string) => `<${tag}${attrs}>${style}${selfClosing ? `</${tag}>` : ""}`);
  }
  files[path] = markup;
  Assets.addSource(Assets.fromObject(files));
  const node = GameObject.create(options.name ?? "UI", { parent: options.parent ?? null });
  const doc = node.addBehavior(UIDocument, { document: `asset:${path}` });
  if (!doc.root) throw new Error(`The test document wasn't built (is loadUIDocumentSupport() awaited?): ${markup}`);
  if (doc.problems.length) throw new Error(doc.problems.map((p) => p.message).join("\n"));
  return doc;
}

/** The component of the element with `id` in `doc`, as `type`. */
export function byId<T extends UIComponentType>(doc: UIDocument, id: string, type: abstract new () => T): T {
  const el = doc.query(`#${id}`);
  if (!el) throw new Error(`No element with id "${id}".`);
  return el.as(type);
}

const TAGS = new Map<Function, string>([
  [UICanvas, "Canvas"],
  [UIPanel, "Panel"],
  [UIText, "Text"],
  [UIImage, "Image"],
  [UIButton, "Button"],
  [UIInputField, "InputField"],
]);

/**
 * One element, as a one-element document on a new node under `parent`, its fields then written as a
 * script writes a document element's (`element.as(UIPanel).width = …`). The element's node is named
 * `name`; the document's node sits between it and `parent`, and layout skips it like any node without UI.
 */
export function uiElement<T extends UIComponentType>(name: string, parent: GameObject | null, type: new () => T, init: Partial<T> = {}): T {
  const tag = TAGS.get(type);
  if (!tag) throw new Error(`${type.name} isn't a UI element type.`);
  const id = name.replace(/[&"<]/g, (c) => `&#${c.charCodeAt(0)};`);
  const comp = buildUI(`<${tag} id="${id}"/>`, { parent, name: `${name} document` }).root!.as(type);
  Object.assign(comp, init);
  return comp;
}
