# Game UI

Menus, HUDs, lobbies and world-space panels are built from **UI components** on nodes. They lay out with flexbox, draw inside the game canvas with crisp text at any size, and take the pointer before the game does. The components are [ADR 0069](../../decisions/0069-ui-components-on-uikit.md)'s; they lay out with Yoga and draw with Babylon GUI ([ADR 0076](../../decisions/0076-ui-yoga-layout-babylon-gui-drawing.md)), which replaced the pmndrs uikit of [ADR 0020](../../decisions/0020-in-canvas-ui-with-uikit.md). This guide is about using them.

## The UI tree

A UI element is a node with one UI component, and the node tree is the UI tree: an element's children lay out inside it. The root is a `UICanvas`.

```
Canvas            UICanvas
└─ Menu           UIPanel   flexDirection: column, gap: 12, padding: 24
   ├─ Title       UIText    "King of Pirates", fontSize: 48
   ├─ Play        UIButton  width: 240, height: 56
   │  └─ Label    UIText    "Play"
   └─ Name        UIInputField  placeholder: "Your name"
```

- Nodes without a UI component are skipped: their UI children lay out in the nearest UI ancestor. Use them to group things.
- `UIText`, `UIImage` and `UIInputField` can't have children; UI nodes under one lay out beside it (with a warning).
- An element with no `UICanvas` above it isn't drawn (with a warning).
- A disabled component or an inactive node takes no space. `display = "none"` does the same while the node stays active (its scripts run), like CSS's `display: none`. `visible = false` hides an element and its children but keeps its space. Hidden elements, and elements inside them, don't take the pointer.

In the editor, **Create > UI Canvas, UI Panel, UI Text, UI Image, UI Button, UI Input Field** add each kind; the components are also in **Add Component > UI**. Their fields are in the Inspector. There's no drag-to-lay-out view yet: you lay out with the fields.

## Canvases

| Field | Meaning |
| --- | --- |
| `mode` | `screen`: drawn over the game, after the cameras and their post-processing, never tone mapped or fogged. `world`: a panel in the scene at the node's transform, drawn with the scene. |
| `referenceResolution` | The UI's design size in UI pixels (default 1280×720). |
| `matchHeight` | Screen mode. 1 (the default) scales the UI with the canvas height, 0 with its width, in between a blend, like Unity's Canvas Scaler. At 1, a 1280×720 design on a 2560×1440 canvas draws twice as big, and on a wider canvas gets more room at the sides. |
| `sortOrder` | Screen canvases draw in ascending order: higher is on top, and gets the pointer first. |
| `pixelSize` | World mode: world units per UI pixel (default 0.01, so a 1280×720 canvas is 12.8×7.2 units). |
| `modal`, `autoFocus`, `firstSelected`, `player` | Keyboard and gamepad navigation: see [below](#keyboard-and-gamepad-navigation). |

A screen canvas covers the game canvas. Its children lay out in a row by default (flexbox's default); for a full-screen layout, give it one `UIPanel` with `width: "100%"`, `height: "100%"`.

## Layout

Every element has flexbox fields (Yoga's, with web defaults). Lengths are UI pixels.

| Field | Values |
| --- | --- |
| `flexDirection` | `row` (default), `column`, `row-reverse`, `column-reverse`: how this element lays out its children |
| `justifyContent` | along that direction: `flex-start`, `center`, `flex-end`, `space-between`, `space-around`, `space-evenly` |
| `alignItems` | across it: `stretch` (default), `flex-start`, `center`, `flex-end`, `baseline` |
| `gap`, `padding`, `margin` | pixels, on every side |
| `width`, `height` | pixels (`240` or `"240"`), a percentage of the parent (`"50%"`) or `"auto"` (sized by the content) |
| `positionType` | `relative`, or `absolute` to take it out of the flow and place it by `top`, `right`, `bottom`, `left` |
| `flexGrow` | how much of the parent's free space it takes |
| `opacity` | 0–1, multiplied into its children's |
| `visible` | `false` hides it and its children, keeping its space |
| `display` | `flex` (default), or `none` to take it and its children out of layout, drawing and the pointer |
| `raycastTarget` | `true` (default): the pointer stops at it, if it's a graphic ([below](#the-pointer-goes-to-ui-first)); `false`: it passes through |

Children shrink to fit a parent that's too small (flexbox's `flex-shrink: 1`).

## Elements

- **`UIPanel`**: a box. `backgroundColor` (none by default), `borderRadius`, `borderWidth`, `borderColor`.
- **`UIText`**: `text`, `fontSize`, `color`, `fontWeight` (`light`, `normal`, `medium`, `semi-bold`, `bold`), `textAlign`, `wordBreak` (`break-word`, `break-all`, `keep-all` for no wrapping). The font is Inter, bundled; custom fonts aren't supported yet.
- **`UIImage`**: `image` (a texture asset) and `fit`: `fill` stretches it to the element, `cover` fills it and crops, `contain` keeps the texture's aspect ratio when the element's size comes from it (leave `width` or `height` at `"auto"`).
- **`UIButton`**: a panel that takes the pointer, with `hoverColor`, `pressedColor` and `interactable`. Its children are its label.
- **`UIInputField`**: a one-line text field: `value`, `placeholder`, `maxLength` (0: no limit), `fontSize`, `color`, `placeholderColor`, and the panel's style.
- Buttons and input fields also take focus: `focusable`, `focusColor`, `navigation` and `navUp`, `navDown`, `navLeft`, `navRight` ([below](#keyboard-and-gamepad-navigation)).
- **`UIControlMapper`**: a ready-made controls screen that lists a player's actions and rebinds them (see [Input](input.md#a-rebinding-screen)). It builds its elements as its node's children.

## Scripting

UI fields are plain values: change them at runtime and the UI follows next frame. UI built in the editor and UI built in code are the same thing.

```ts
import { GameBehavior, UIButton, UIInputField, UIText, behavior } from "myco";

@behavior("game.MainMenu")
export class MainMenu extends GameBehavior {
  update() {
    const play = this.node.find("Menu/Play")!.getComponent(UIButton)!;
    const name = this.node.find("Menu/Name")!.getComponent(UIInputField)!;
    if (play.clicked || name.submitted) startGame(name.value);
    this.node.find("Menu/Title")!.getComponent(UIText)!.text = play.hovered ? "Ready?" : "King of Pirates";
  }
}
```

A button's state, read any time:

- `hovered`: the pointer is over it (and it's interactable).
- `pressed`: from a press on it until the pointer button is released.
- `clicked`: true for the one frame a click finished: pressed and released over the same button, like `Input.getMouseButtonUp`.

A button's or field's `focused` is true while it has focus; set it to focus or unfocus it from a script (one element has focus at a time). A field's `typing` is true while it takes the keyboard: setting `focused = true` on a field, or clicking it, also starts typing. `changed` is true for the frame after the player changed its value and `submitted` for the frame after Enter was pressed in it. A script writing `value` is never a change.

`clicked`, `changed`, `submitted`, `focusedChanged` and a UI document's `hover`, `focus` and `blur` events all happen in the frame after the player acted (with the pointer; in the same frame with keyboard and gamepad navigation, before any script runs), and every script phase of that frame sees them, `fixedUpdate` included. A script's own focus changes are never events.

## The pointer goes to UI first

Each frame, before any script runs, the pointer is tested against the UI's raycast targets (below): screen canvases from the highest `sortOrder`, the topmost element first (later siblings draw over earlier ones), then world canvases, nearest first. When it's over one:

- `Input.pointerOverUI` is true.
- That frame's mouse presses go to the UI: `Input.getMouseButtonDown` reports false for them. A press that began on UI stays the UI's until it's released: `getMouseButton` and `getMouseButtonUp` report false for it too.
- A press that began in the game stays the game's, even when it's released over a button (which then isn't clicked).

**Raycast targets** ([ADR 0385](../../decisions/0385-ui-elements-stop-the-pointer-by-their-raycast-target-field-as-in-unity.md)). Every element has `raycastTarget`, like Unity's `Graphic.raycastTarget`, on by default. Text, images, buttons and input fields stop the pointer, and so does a panel with a `backgroundColor` (a transparent one too: an invisible click blocker) or a border; a panel with neither is a layout box and the pointer passes it. A press on text, an image or a panel goes to the UI and does nothing; inside a button, it presses the button (a button's label passes its clicks to the button). Turn `raycastTarget` off for decoration over the game, such as a HUD's markers or a hint line, so clicks reach the game through it (`raycastTarget="false"` in a UI document, or `raycast-target: false` in its stylesheet). It's per element: children keep their own. A button with `raycastTarget` off is pressed only through a child that stops the pointer.

A button with `interactable` off still blocks the pointer from the game, but isn't hovered, pressed or clicked.

Pressing a button or an input field focuses it (a field starts typing); pressing anywhere else unfocuses it. Escape stops typing, keeping the field focused. Typing goes through a hidden DOM `<input>`, so IME, paste and the OS's text tools work. While a field is typing, `Input.keyboardOverUI` is true and `Input.getKey`, `getKeyDown`, `getKeyUp` and `anyKeyDown` report false for keys, so typing a name doesn't move the ship.

Only a World that takes local input routes the pointer. The editor's scene view shows a scene's UI but doesn't route clicks to it (they select); in play mode the game World routes as usual.

## Keyboard and gamepad navigation

Menus work with the arrow keys, Tab, Enter and Escape, and with a gamepad's d-pad, left stick, A and B, with no game code ([ADR 0340](../../decisions/0340-game-ui-has-keyboard-and-gamepad-focus-navigation-driven-by-ui-actions.md)). It's Unity's selectable navigation and Godot's focus neighbours.

**Focus.** A World's UI has at most one focused element: a `UIButton` or `UIInputField` that is active, visible, `focusable` (default true) and, for a button, `interactable`. A press focuses what it hit, a script sets `focused`, and navigation moves it. Losing what made it focusable (hidden, disabled, made non-interactable) loses focus.

**The UI actions.** Navigation is driven by an engine action set, `engine.UIActions`, bound in the engine's `ui` context:

| Action | Defaults | Does |
| --- | --- | --- |
| `navigate` | arrow keys, d-pad, left stick | moves focus up, down, left or right |
| `submit` | Enter, Space, south button (A) | clicks the focused button; on an input field, starts typing |
| `cancel` | Escape, east button (B) | records a cancel on the focused element's canvas |
| `next`, `previous` | Tab, Shift+Tab | move focus in tree order, wrapping within the canvas |

`navigate`, `next` and `previous` repeat while held: at once, then after 0.4 s every 0.1 s. Turning `navigate` to another direction while it's held (rolling from one arrow key to the next, sweeping the stick round) moves at once too. The `ui` context is on for a player only while their World's UI has focus, at priority 1000, so a focused menu's arrows, d-pad, Enter, Space and Escape don't also move or pause the game; with nothing focused, the game gets every control. Players rebind it like any other context ([Input](input.md#contexts-vehicles-menus-modes)).

Pressing a button focuses it, so Space and Enter then press it until focus moves on (as in Unity). Give HUD buttons that shouldn't take the keyboard `focusable = false`.

**Where `navigate` goes.** From the focused element's box, to the nearest focusable element of the same canvas in that direction: candidates whose centre lies in a 90° cone opening from the box's edge (or that line up with it across the direction), scored by distance with a penalty for being off-axis. Per element:

- `navUp`, `navDown`, `navLeft`, `navRight` (nodes in the same canvas) override the search in their direction.
- `navigation`: `auto` (default) takes the neighbours, else the search; `explicit` only the neighbours; `none` doesn't leave the element with `navigate` (`next` and `previous` still do).

**Submit and cancel.** `submit` on a button is a click: `clicked`, `UIEvents` and a UI document's `click` handlers see it like a pointer click. `cancel` sets `UICanvas.canceled` for that frame and runs a UI document's `cancel` handlers on its root (`doc.root.on("cancel", …)`), so Escape or B backs out of a menu. Navigation's events (`clicked`, `focusedChanged`, `focus`, `blur`, `cancel`) happen in the same frame, before any script runs, and every script phase of the frame sees them.

**Canvases.**

| Field | Meaning |
| --- | --- |
| `autoFocus` | When the canvas becomes active, focus `firstSelected`, else its first focusable element: a pause menu gets focus without script. |
| `firstSelected` | The element `autoFocus`, `modal` and `navigate` with nothing focused start on. |
| `modal` | While it has a focusable element, focus can't leave it: focus elsewhere moves in, and presses outside don't take it (they still press what they hit). |
| `player` | The local player whose UI actions drive it (-1, the default: any local player), for split-screen menus. The `ui` context is on only for that player. |

With nothing focused, navigation acts on the highest `sortOrder` screen canvas that has a focusable element (but the `ui` context is off then, so only your own bindings of `engine.UIActions` reach it).

**Input fields.** Navigation focuses a field without typing in it; `submit` starts typing. While it's typing, the keyboard types (arrows move the caret); only Tab and Shift+Tab (to the next or previous element), Escape (stops typing, keeping focus) and the gamepad leave it.

**Showing focus.** `focusColor` is a button's fill (under hover and pressed) and an input field's border, drawn while it has focus and the last UI input was navigation. Moving or pressing the pointer hides it, so mouse users don't see a stray highlight.

**UI documents.** The same rules, as attributes: `focusable="false"`, `focus-color`, `navigation="explicit"`, `nav-up`, `nav-down`, `nav-left` and `nav-right` (element ids, looked up in the element's own list row first), and on the root `<Canvas>`, `auto-focus` (a bare attribute is `true`), `first-selected` (an id), `modal` and `player`. Elements take `focus` and `blur` handlers; the root takes `cancel`.

```xml
<Canvas auto-focus first-selected="resume" modal>
  <Panel flex-direction="column" gap="12">
    <Button id="resume" nav-up="quit">Resume</Button>
    <Button id="options">Options</Button>
    <Button id="quit" nav-down="resume">Quit</Button>
  </Panel>
</Canvas>
```

```ts
pause.root!.on("cancel", () => closePauseMenu());
pause.query("#resume")!.on("click", () => closePauseMenu());
```

## Headless Worlds and tests

UI components hold their data in any World. Only a World with a render backend builds and lays them out, so a server or a test can create UI without WebGL; there the pointer and typing do nothing and navigation has no layout to move focus through (a script's focus still takes `submit` and `cancel`). Tests click, hover, type and navigate through a UI core and `Input`, as a player does (`engine/tests/uiPointer.ts`, `engine/tests/uiNavigation.test.ts`).

## Known gaps

- No scrolling, sliders, toggles or dropdowns.
- No on-screen keyboard: a gamepad can focus an input field but not type in it.
- No styling of focus beyond `focusColor` (a `:focus` rule styles input fields only).
- No custom fonts (the bundled Inter only) and no shared styles or themes.
- `fit: contain` in a box with both sides fixed stretches like `fill`.
- No visual layout editing in the editor, and UI can't be picked in the scene view.
