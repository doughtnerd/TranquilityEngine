# 0077. UI is authored as markup documents with stylesheets, driven by scripts, and edited in the scene view

- **Status:** Accepted
- **Date:** 2026-11-05
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0013, 0017, 0020, 0022, 0026, 0069, 0076

## Context

0069 made UI a tree of nodes with UI components (`UICanvas`, `UIPanel`, `UIText`, `UIImage`, `UIButton`, `UIInputField`). 0076 decides how that tree is laid out and drawn. What's missing is a pleasant way to author it. Building UI node by node in the Inspector, or in code, is how early Unity UI turned into a mess: structure, look and behaviour all ended up in code or hand-wired Inspector references.

What works, in Unity's UI Toolkit (UXML, USS, C#) and on the web (HTML, CSS, JS), is keeping three things apart: structure in markup, look in a stylesheet, behaviour in scripts. The goal is UI that feels like web development to users, while staying in-canvas (0020) and on the engine's data-oriented core (0017).

We considered JSX or htm with Preact as the main authoring language. Preact output can be previewed in the editor, but it's generated from code, so the editor can't write visual edits back to it. Users should be able to click and edit UI in the scene view, so structure has to live in a file the editor can edit.

## Decision

**1. Structure: markup documents (`*.ui.xml`).**

- **Elements and attributes.**
  - Elements are the UI components, and attributes are their fields: `<Canvas>`, `<Panel>`, `<Text>`, `<Image>`, `<Button>`, `<InputField>`.
  - Every element may have `id` and `class`.
  - A text element's content is its `text`.
- **Embedding.** `<Use src="widgets/healthbar.ui.xml"/>` embeds another document, like a nested prefab.
- **Styles.** `<Style src="menu.ui.css"/>` attaches a stylesheet.
- **Bindings.** These are the whole binding language:
  - `{name}` inside text or an attribute value takes its value from the document's data, or from a list item's field.
  - `<Template>` inside an element is the row a script repeats with `list()`.
- **Hard limits.** No expressions, conditionals or loops in markup, and no event handlers in markup. Logic lives in scripts. When a screen needs more than this, the way to grow is Preact rendering into an element (below), not new markup syntax.
- **`UIDocument` component.** A node with a `UIDocument` component (`document`: asset reference) builds the document's elements as its child nodes when it loads.
  - These nodes belong to the document. They aren't saved in the scene, and they're rebuilt when the file changes (hot reload in the editor).
  - Scripts may change them at runtime, but those changes aren't saved.
  - Hand-built UI nodes from 0069 keep working beside documents.

**2. Look: stylesheets (`*.ui.css`), a subset of CSS.**

- **Selectors:** element names, `.class`, `#id`, descendants (`A B`) and children (`A > B`), plus the pseudo-classes `:hover`, `:pressed`, `:focus` and `:disabled`, which come from the engine's own UI state.
- **Properties:** component fields in kebab-case (`flex-direction`, `background-color`, `border-radius`, `font-size`…), with CSS units where a field is a length (`px`, `%`, `auto`). Unknown properties warn once.
- **Variables:** `--name: value` and `var(--name)` for themes, including on `:root`.
- **Inheritance:** text properties (`color`, `font-*`, `text-align`) are inherited by child elements, as on the web. Other properties aren't.
- **Cascade:** standard specificity, with later rules winning ties. An attribute on an element beats any stylesheet rule.
- **Not included:** media queries, animations and transitions, `!important`, and attribute selectors. These can be added later without breaking anything.

**3. Behaviour: scripts, on a data-oriented core with optional handlers.**

- **The core is data, as in 0017.**
  - Every element has polled state each frame: `clicked`, `pressed`, `hovered`, `changed`, `submitted`, `focused`, `value`.
  - A `UIEvents` buffer lists the frame's clicks, changes and submits (element, document, list item), like `CollisionEvents`.
  - Systems read the buffer, and behaviors may poll.
- **Handlers are a thin layer over that core.**
  - `element.on("click" | "change" | "submit" | "hover", handler)` registers a callback.
  - Once per frame, right after UI input routing and before behaviors' `update`, the engine walks that frame's `UIEvents` and calls the handlers of each event's element. A handler runs exactly when the matching polled flag is true, in the same frame.
  - Handlers are removed with their element, node or list row.
  - This is a UI-local callback layer, not an engine event bus. 0017's "no event system" covers communication between systems, components and entities, and still holds there.
- **The script API**, on `UIDocument`:
  - `ui.query(selector)` and `ui.queryAll(selector)` return elements.
  - An element has:
    - `id` and `classList`;
    - `query` and `queryAll` (searching inside it);
    - `on` and `off`;
    - the polled state above;
    - `node` (its GameObject), and its component, so typed field access still works: `element.as(UIButton).interactable = false`.
  - `ui.data` is a plain object. `{name}` bindings follow its values, checked each frame, so `ui.data.score += 10` updates the text.
  - `ui.list(selector, items, setup?, { key? })` makes one row per item from the element's `<Template>`.
    - `{field}` inside the row reads the item's fields.
    - `setup(row, item)` runs once per new row, which is where row handlers go.
    - Calling `list()` again with new items reuses rows by key (default: index).
    - A row's events carry its item.

**4. Editing in the scene view.**

- **Selecting.**
  - Clicking UI in the scene view, picked with the same layout boxes routing uses, selects that element. So does selecting it in the hierarchy.
  - The hierarchy shows a document's elements under its node, marked as coming from the file.
- **The Inspector** shows the element's fields and where each value comes from: its own attribute, a stylesheet rule (with the rule named), or the default.
  - Editing a field writes an attribute to that element in the markup file.
  - "Move to class" moves the element's attributes into a class rule in its stylesheet.
- **Moving and resizing in the scene view.**
  - Resize handles set `width` and `height`.
  - Dragging moves an absolutely positioned element (`top`, `left`), or reorders an element among its flex siblings.
  - Dragging in the hierarchy reorders or reparents elements in the markup.
- **The Create menu** adds elements into the selected document.
- **Every change is a command** on the document (0026), with undo, saved like scenes.
  - Edits change only the affected text. Comments and formatting in the file are kept, so hand edits and editor edits can mix.
  - Sample documents are read-only, as other sample assets are.

**5. Libraries.**

- `htmlparser2` 12.0.0 (MIT) parses markup in XML mode. It reports source positions, so the editor's edits patch only the affected text.
- `css-tree` 3.2.1 (MIT) parses stylesheets, with positions for "Move to class" and later stylesheet edits.
- Both are used at runtime too: games parse documents and stylesheets as they load, along with UI. Pinned exact versions.

**6. Later: Preact for dynamic parts.** `ui.render(selector, <Component …/>)` renders a Preact component into an element when a screen needs more than `list()` and bindings.

- Preact renders through a small DOM-like layer whose elements are the same UI nodes, and they pick up the document's stylesheet through `class`.
- Preact output is viewable in the editor but not editable there, because it's generated from code.
- It gets its own small record when it's needed. Until then, markup gains no new syntax.

## Alternatives considered

- **Preact (JSX or htm) as the main authoring language.** Full JavaScript, components and familiarity. But structure generated from code can't take visual edits from the editor, and layout, logic and state drift into one file. It's kept for dynamic parts (6).
- **Svelte.** Its compiler emits DOM calls, including template cloning from HTML strings, with no supported custom renderer, so rendering into UI nodes is harder than with Preact. It's also a second UI framework beside the editor's Preact.
- **A bigger template language in markup** (expressions, `if`, `each`). It's convenient at first, then turns into a programming language with weaker tools than TypeScript. Logic stays in scripts.
- **Handlers only, or polling only.** Handlers alone don't suit systems. Polling alone is the least web-like, and `update` grows a long list of `if (…clicked)` checks. Both are offered, on one data core.
- **Lifecycle hooks** (`onUIClick(e)` on the behavior). These match physics notifications, but each hook becomes a dispatch on ids and classes that grows with every button.
- **A real DOM overlay with HTML and CSS.** Rejected by 0020, and reconfirmed: UI stays in-canvas.

## Consequences

**Positive**
- UI feels like web development: markup, a CSS subset, `querySelector`-style queries, handlers and data-driven lists, on top of the same polled state and buffers the rest of the engine uses.
- Structure, look and behaviour stay in their own files, and themes are a stylesheet with variables.
- UI is visible and editable in the scene view, and saved to files people can also edit by hand.
- 0069 components and scripts keep working. Documents just produce the same nodes.

**Negative / costs**
- A markup format and a CSS subset to specify, document and keep stable: their rules are now part of the engine's API.
- Editor work: picking UI elements, showing where values come from, writing edits back while keeping formatting, and handles for move, resize and reorder.
- Two parsers added to the UI bundle (`htmlparser2` and `css-tree`), loaded only with UI.
- Two ways to handle input (handlers and polling) to document. The docs lead with handlers for behaviors and polling and buffers for systems.

## Deprecates

- Nothing. Hand-built UI nodes (0069) stay supported. Documents are the recommended way to author UI.

## Open questions

- Animations and transitions in stylesheets, and how they meet the polled-state model.
- Keyboard and gamepad navigation between elements (from 0020 and 0069), possibly through `tab-index`-like attributes in markup.
- Localisation: whether `{name}` bindings or a separate `t:` key form carry translated strings.
- A visual stylesheet editor in the editor, beyond "Move to class".

## References

- Unity UI Toolkit: UXML, USS and UI Builder (the model this follows)
- htmlparser2: https://github.com/fb55/htmlparser2 · css-tree: https://github.com/csstree/csstree
- 0069 (UI components), 0076 (layout and drawing), 0026 (editor commands), 0017 (data-oriented communication)
