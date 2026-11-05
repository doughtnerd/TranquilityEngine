# Game UI

Menus, HUDs, lobbies and world-space panels are built from **UI components** on nodes. They lay out with flexbox, draw inside the game canvas with crisp text at any size, and take the pointer before the game does. The design is in [ADR 0069](../decisions/0069-ui-components-on-uikit.md) (built on pmndrs uikit, as [ADR 0020](../decisions/0020-in-canvas-ui-with-uikit.md) decided). This guide is about using it.

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
- A disabled component or an inactive node takes no space. `visible = false` hides an element and its children but keeps its space.

In the editor, **Create > UI Canvas, UI Panel, UI Text, UI Image, UI Button, UI Input Field** add each kind; the components are also in **Add Component > UI**. Their fields are in the Inspector. There's no drag-to-lay-out view yet: you lay out with the fields.

## Canvases

| Field | Meaning |
| --- | --- |
| `mode` | `screen`: drawn over the game, after the cameras and their post-processing, never tone mapped or fogged. `world`: a panel in the scene at the node's transform, drawn with the scene. |
| `referenceResolution` | The UI's design size in UI pixels (default 1280×720). |
| `matchHeight` | Screen mode. 1 (the default) scales the UI with the canvas height, 0 with its width, in between a blend, like Unity's Canvas Scaler. At 1, a 1280×720 design on a 2560×1440 canvas draws twice as big, and on a wider canvas gets more room at the sides. |
| `sortOrder` | Screen canvases draw in ascending order: higher is on top, and gets the pointer first. |
| `pixelSize` | World mode: world units per UI pixel (default 0.01, so a 1280×720 canvas is 12.8×7.2 units). |

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

Children shrink to fit a parent that's too small (flexbox's `flex-shrink: 1`).

## Elements

- **`UIPanel`**: a box. `backgroundColor` (none by default), `borderRadius`, `borderWidth`, `borderColor`.
- **`UIText`**: `text`, `fontSize`, `color`, `fontWeight` (`light`, `normal`, `medium`, `semi-bold`, `bold`), `textAlign`, `wordBreak` (`break-word`, `break-all`, `keep-all` for no wrapping). The font is Inter, bundled; custom fonts aren't supported yet.
- **`UIImage`**: `image` (a texture asset) and `fit`: `fill` stretches it to the element, `cover` fills it and crops, `contain` keeps the texture's aspect ratio when the element's size comes from it (leave `width` or `height` at `"auto"`).
- **`UIButton`**: a panel that takes the pointer, with `hoverColor`, `pressedColor` and `interactable`. Its children are its label.
- **`UIInputField`**: a one-line text field: `value`, `placeholder`, `maxLength` (0: no limit), `fontSize`, `color`, `placeholderColor`, and the panel's style.

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

A field's `focused` is true while it takes the keyboard; set it to focus or unfocus the field from a script. `submitted` is true for the frame Enter was pressed in it.

## The pointer goes to UI first

Each frame, before any script runs, the pointer is tested against the UI's buttons and input fields: screen canvases from the highest `sortOrder`, the topmost element first (later siblings draw over earlier ones), then world canvases, nearest first. When it's over one:

- `Input.pointerOverUI` is true.
- That frame's mouse presses go to the UI: `Input.getMouseButtonDown` reports false for them. A press that began on UI stays the UI's until it's released: `getMouseButton` and `getMouseButtonUp` report false for it too.
- A press that began in the game stays the game's, even when it's released over a button (which then isn't clicked).

A button with `interactable` off still blocks the pointer from the game, but isn't hovered, pressed or clicked. Panels, text and images don't block it.

Clicking an input field focuses it; clicking anywhere else unfocuses it, and so does Escape. Typing goes through a hidden DOM `<input>`, so IME, paste and the OS's text tools work. While a field is focused, `Input.keyboardOverUI` is true and `Input.getKey`, `getKeyDown`, `getKeyUp` and `anyKeyDown` report false for keys, so typing a name doesn't move the ship.

Only a World that takes local input routes the pointer. The editor's scene view shows a scene's UI but doesn't route clicks to it (they select); in play mode the game World routes as usual.

## Headless Worlds and tests

UI components hold their data in any World. Only a World with a render backend builds and lays them out, so a server or a test can create UI without WebGL; there `clicked` and `submitted` stay false. Tests can report a click with `button._simulateClick()` and Enter with `field._simulateSubmit()` (internal): inside a frame, scripts see it that frame; between frames, in the next.

## Known gaps

- No keyboard or gamepad navigation between elements, scrolling, sliders, toggles or dropdowns.
- No custom fonts (the bundled Inter only) and no shared styles or themes.
- `fit: contain` in a box with both sides fixed stretches like `fill`.
- No visual layout editing in the editor, and UI can't be picked in the scene view.
