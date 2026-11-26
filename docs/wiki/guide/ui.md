# Game UI

Menus, HUDs, lobbies and world-space panels are **UI documents**: markup in a `*.ui.xml` file, its look in `*.ui.css` stylesheets, and scripts that fill in data and react to clicks ([ADR 0077](../../decisions/0077-ui-documents-markup-styles-scripts.md)). UI lays out with flexbox, draws inside the game canvas with crisp text at any size, and takes the pointer before the game does. It lays out with Yoga and draws with Babylon GUI ([ADR 0076](../../decisions/0076-ui-yoga-layout-babylon-gui-drawing.md)).

A document is the only way to make game UI ([ADR 0417](../../decisions/0417-game-ui-is-built-only-from-ui-documents.md)). The elements it builds are UI components (`UICanvas`, `UIPanel`, `UIText`, `UIImage`, `UIButton`, `UIInputField`, [ADR 0069](../../decisions/0069-ui-components-on-uikit.md)), and scripts read and write their fields, but nothing else creates them: `addComponent(UIPanel)` throws, and a scene or prefab that saves a UI component on a node fails to load, naming the file and the node.

## A document

A document's root is a `<Canvas>`; the elements inside it lay out in it, children inside their parent.

```xml
<!-- ui/menu.ui.xml -->
<Canvas>
  <Style src="menu.ui.css"/>
  <Panel id="menu" class="column">
    <Text id="title">King of Pirates</Text>
    <Button id="play" class="primary">Play</Button>
    <InputField id="name" placeholder="Your name"/>
    <Text id="score">Score: {score}</Text>
  </Panel>
</Canvas>
```

```css
/* ui/menu.ui.css */
:root { --fg: #ffffff; }
#menu { width: 100%; height: 100%; flex-direction: column; justify-content: center; align-items: center; gap: 12px; color: var(--fg); }
#title { font-size: 48px; text-outline-color: #000000; text-outline-width: 3px; }
.primary { width: 240px; height: 56px; background-color: #336699; }
.primary:hover { background-color: #4477aa; }
```

- **Elements:** `<Canvas>`, `<Panel>`, `<Text>`, `<Image>`, `<Button>` and `<InputField>`. `<Use src="…">` puts another document's root in its place, `<Style src="…">` adds a stylesheet, and `<Template>` holds the element `list()` repeats.
- **Attributes** set the element's fields, in kebab case (`font-size="20"`, `background-color="#336699"`) and beat stylesheet rules. A `Text`'s, `Button`'s or `InputField`'s content is its text.
- **Stylesheets** are a CSS subset: type, `.class`, `#id`, descendant and child selectors, `:hover`, `:pressed`, `:focus`, `:disabled` and `:lang()`, and variables (`--name`, `var(--name)`). Properties are the elements' fields in kebab case. Text properties inherit from parent to child, as on the web: `color`, `font-size`, `font-weight`, `text-align`, `text-outline-color` and `text-outline-width`.
- `Text`, `Image` and `InputField` can't have children.
- **Bindings:** `{name}` in an attribute or a text reads `ui.data.name` (in a list row, the row's item first). The text follows the value each frame.
- **Localised text:** `t:text="menu.start"` sets the text to that key's message in the current language ([ADR 0356](../../decisions/0356-text-is-localised-through-keyed-string-tables-with-icu-messages-bound-by-key-in-ui-documents-and-scripts.md) §4); `translate="no"` marks text that stays as written.

To show a document, put a node with a `UIDocument` component in the scene and set its `document` (`asset:ui/menu.ui.xml`). It builds the elements as the node's children; they aren't saved in the scene, and they're rebuilt when the document or a stylesheet changes. In the editor, **Create > UI > UI Document** adds one; its elements are selected and edited in the scene view and the Inspector, and the Create menu adds elements into the selected document.

- A disabled element or an inactive node takes no space. `display: none` does the same while the node stays active, like CSS's `display: none`. `visible: false` hides an element and its children but keeps its space. Hidden elements, and elements inside them, don't take the pointer.
- An element with no canvas above it isn't drawn (with a warning). A `<Canvas>` inside another element is a canvas of its own.

## Canvases

| Field | Meaning |
| --- | --- |
| `mode` | `screen`: drawn over the game, after the cameras and their post-processing, never tone mapped or fogged. `world`: a panel in the scene at the node's transform, drawn with the scene. |
| `referenceResolution` | The UI's design size in UI pixels (default 1280×720). |
| `matchHeight` | Screen mode. 1 (the default) scales the UI with the canvas height, 0 with its width, in between a blend, like Unity's Canvas Scaler. At 1, a 1280×720 design on a 2560×1440 canvas draws twice as big, and on a wider canvas gets more room at the sides. |
| `sortOrder` | Screen canvases draw in ascending order: higher is on top, and gets the pointer first. |
| `pixelSize` | World mode: world units per UI pixel (default 0.01, so a 1280×720 canvas is 12.8×7.2 units). |
| `modal`, `autoFocus`, `firstSelected`, `player` | Keyboard and gamepad navigation: see [below](#keyboard-and-gamepad-navigation). |

A screen canvas covers the game canvas. Its children lay out in a row by default (flexbox's default); for a full-screen layout, give it one `<Panel>` with `width: 100%; height: 100%`.

On the root `<Canvas>`, these are attributes: `<Canvas mode="world" pixel-size="0.005">`, `<Canvas sort-order="10">`.

## Layout

Every element has flexbox fields (Yoga's, with web defaults), written in kebab case in markup and stylesheets (`flex-direction`, `justify-content`). Lengths are UI pixels.

| Field | Values |
| --- | --- |
| `flexDirection` | `row` (default), `column`, `row-reverse`, `column-reverse`: how this element lays out its children |
| `justifyContent` | along that direction: `flex-start`, `center`, `flex-end`, `space-between`, `space-around`, `space-evenly` |
| `alignItems` | across it: `stretch` (default), `flex-start`, `center`, `flex-end`, `baseline` |
| `gap`, `padding`, `margin` | pixels, on every side |
| `width`, `height` | pixels (`240` or `"240"`), a percentage of the parent (`"50%"`) or `"auto"` (sized by the content) |
| `positionType` | `relative`, or `absolute` to take it out of the flow and place it by `top`, `right`, `bottom`, `left` (`position: absolute` in a stylesheet) |
| `flexGrow` | how much of the parent's free space it takes |
| `opacity` | 0–1, multiplied into its children's |
| `visible` | `false` hides it and its children, keeping its space |
| `display` | `flex` (default), or `none` to take it and its children out of layout, drawing and the pointer |
| `raycastTarget` | `true` (default): the pointer stops at it, if it's a graphic ([below](#the-pointer-goes-to-ui-first)); `false`: it passes through |

When children don't fit, text shrinks and wraps to what's left; other elements keep their size unless their `flexShrink` says otherwise (below).

### Sides, sizes, wrapping, clipping and layers

[ADR 0418](../../decisions/0418-the-ui-core-grows-toward-web-css-layout-paint-transforms-animation-and-selectors-in-waves.md) wave 1 adds these fields to every element, each settable by attribute, rule or script:

| Field | Values |
| --- | --- |
| `paddingTop`, `paddingRight`, `paddingBottom`, `paddingLeft`; the same for `margin…` | pixels on one side; `null` (the default) takes `padding` / `margin`, the all-sides value |
| `borderTopWidth`, `borderRightWidth`, `borderBottomWidth`, `borderLeftWidth` | panels, buttons and input fields: one side's border; `null` takes `borderWidth`. Unequal sides draw each side as its own edge |
| `minWidth`, `minHeight` | pixels or a percentage; `auto` (default): no minimum |
| `maxWidth`, `maxHeight` | pixels or a percentage; `none` (default): no maximum |
| `flexWrap` | `nowrap` (default), `wrap`, `wrap-reverse`: children that don't fit go onto more lines |
| `alignSelf` | `auto` (default: the parent's `alignItems`), or one of `alignItems`' values for this element |
| `alignContent` | how wrapped lines share the space across: `stretch` (default), `flex-start`, `center`, `flex-end`, `space-between`, `space-around`, `space-evenly` |
| `flexShrink` | how much it shrinks, relative to its siblings, when they don't fit; `null` (default): its kind's (text 1, others 0) |
| `flexBasis` | its size along the parent's direction before growing and shrinking: pixels, a percentage, or `auto` (default: its `width` or `height`) |
| `aspectRatio` | width ÷ height, kept when only one side is set (`aspect-ratio: 16 / 9`); 0 (default): none |
| `overflow` | `visible` (default) or `hidden`: its children are drawn, take the pointer and can be reached by navigation only inside its padding box (inside its border, with rounded inner corners) |
| `zIndex` | draw and pointer order among siblings: higher on top, then document order |

Shorthands work as in CSS, in stylesheets and in attributes, and expand to the fields above where they're written, so the later declaration wins for each side:

```css
.card { padding: 8px 16px; margin: 0 0 12px; border: 2px solid #fff; border-width: 2px 0; }
.grow { flex: 1; }              /* grow 1, shrink 1, basis 0; also flex: none | auto | 2 0 50% | 120px */
```

- `padding`, `margin` and `border-width` take one to four values (top, right, bottom, left, as in CSS). One value sets the all-sides field and clears the sides; two to four set the sides. A script writing `padding` changes the sides that have no value of their own.
- `border` takes a width, `solid` (or `none`, no border) and a colour, in any order. Only solid borders are drawn.
- `overflow: hidden` and a non-zero `zIndex` each draw the element's descendants together, right after it, ordered among themselves by their own `zIndex`: a child can't rise above its parent's later siblings by its `zIndex` (a CSS stacking context). Tab and `next`/`previous` keep document order; only drawing and the pointer follow `zIndex`.
- `overflow: hidden` doesn't scroll. An element it clips away entirely is skipped by keyboard and gamepad navigation, and the editor outlines only the part that's drawn.

## Elements

- **`UIPanel`**: a box. `backgroundColor` (none by default), `borderRadius`, `borderWidth`, `borderColor`, and the paint [above](#paint-shadows-gradients-and-rounded-corners): a shadow, a background image or gradient, and per-corner radii.
- **`UIText`**: `text`, `font` (a font file in the project; empty is the bundled Inter), `fontSize`, `color`, `fontWeight` (`light`, `normal`, `medium`, `semi-bold`, `bold`, or a number), `textAlign` (`start` and `end` follow the language's direction), `wordBreak` (`break-word`, `break-all`, `keep-all` for no wrapping), and an outline: `textOutlineColor` (none by default) and `textOutlineWidth` (UI pixels, 0 by default). The outline shows outside the glyphs, scales with the canvas like the font, and doesn't change the layout. A HUD label over a busy game takes `text-outline-color: #000; text-outline-width: 3px;`.
- **`UIImage`**: `image` (a texture asset) and `fit`: `fill` stretches it to the element, `cover` fills it and crops, `contain` keeps the texture's aspect ratio when the element's size comes from it (leave `width` or `height` at `"auto"`).
- **`UIButton`**: a panel that takes the pointer, with `hoverColor`, `pressedColor` and `interactable`. Its children are its label.
- **`UIInputField`**: a one-line text field: `value`, `placeholder`, `maxLength` (0: no limit), `fontSize`, `color`, `placeholderColor`, and the panel's style.
- Buttons and input fields also take focus: `focusable`, `focusColor`, `navigation` and `navUp`, `navDown`, `navLeft`, `navRight` ([below](#keyboard-and-gamepad-navigation)).
- **`UIControlMapper`**: a ready-made controls screen that lists a player's actions and rebinds them (see [Input](input.md#a-rebinding-screen)). It builds its elements as its node's children, under a canvas a document built.

## Paint: shadows, gradients and rounded corners

Panels, buttons and input fields take a shadow, a gradient or image background and a radius per corner; text takes a shadow ([ADR 0418](../../decisions/0418-the-ui-core-grows-toward-web-css-layout-paint-transforms-animation-and-selectors-in-waves.md) wave 2). Write them as CSS, in a stylesheet or as attributes:

```css
.card {
  background-color: #1d2230;
  border-radius: 12px 12px 0 0;              /* top-left, top-right, bottom-right, bottom-left */
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5); /* offset-x offset-y blur colour */
}
.banner { background-image: linear-gradient(90deg, #336699, #66aacc 70%); }
.glow   { background-image: radial-gradient(#ffffffcc, transparent); }
.wood   { background-image: url(../images/wood.png); }
.title  { text-shadow: 0 2px 4px black; }
```

| Property | Takes | Fields it sets |
| --- | --- | --- |
| `box-shadow` | one shadow: `offset-x offset-y [blur] [colour]` (black when the colour is left out), or `none` | `boxShadowOffsetX`, `boxShadowOffsetY`, `boxShadowBlur`, `boxShadowColor` (null: none) |
| `text-shadow` | the same, on text; inherited like `color` | `textShadowOffsetX`, `textShadowOffsetY`, `textShadowBlur`, `textShadowColor` |
| `background-image` | `url(path)`, `linear-gradient([angle \| to side,] stops…)`, `radial-gradient([circle [at center],] stops…)` or `none` | `backgroundImage` (the CSS text) |
| `border-radius` | one to four lengths, in CSS order | one value: `borderRadius`; two to four: `borderTopLeftRadius`, `borderTopRightRadius`, `borderBottomRightRadius`, `borderBottomLeftRadius` |

- **Shadows** are one shadow each: `inset`, a spread and several shadows aren't supported. Offsets and blur are UI pixels and scale with the canvas. A panel's shadow is cast by its background, so a panel without a `backgroundColor` or gradient has none.
- **Gradients:** a stop is a colour and an optional position in `%`; positions left out are spread evenly, as in CSS. A linear gradient's angle is in `deg` (also `turn`, `rad`, `grad`; default `180deg`, top to bottom) or `to top`, `to right`, `to bottom`, `to left`. A radial gradient is a circle at the centre reaching the farthest corner. A gradient replaces `backgroundColor`, so a button with one doesn't change colour on hover.
- **`url()`** stretches the texture over the box inside the border, under the element's children; a relative path is relative to the stylesheet or document.
- **Corners:** a corner's field at `-1` (its default) takes `borderRadius`, so scripts writing `borderRadius` keep working. One value in `border-radius` sets `borderRadius` and puts every corner back on it; `border-top-left-radius: 0` after it squares just that corner. Elliptical corners (`/`) aren't supported.
- A value that can't be read is left out and warned about once, saying why.
- Every field is also its own property (`box-shadow-blur: 8px`, `background-image` by attribute), and scripts write them like any field.

**Performance.** Babylon GUI draws the UI with Canvas2D and redraws only what changed. A shadow or gradient redraws its whole region, blur included, each time it changes, so animating one (a pulsing glow, a moving gradient) costs more CPU than animating a position, and more on large screens. Animate opacity or position where you can.

## Transforms: translate, rotate and scale

Any element can be drawn moved, turned and scaled ([ADR 0418](../../decisions/0418-the-ui-core-grows-toward-web-css-layout-paint-transforms-animation-and-selectors-in-waves.md) wave 3). As on the web, layout ignores transforms: the element keeps its place in the layout and its siblings don't move. A transform applies to the element and its children, and the pointer, editor picking, the scene view's outline and handles, and keyboard navigation all follow what's drawn.

```css
.badge   { transform: translate(-50%, -50%) rotate(-8deg) scale(1.2); }
.tilted  { rotate: 12deg; transform-origin: left top; }
.pressed { scale: 0.95; }
.slid    { translate: 40px 0; }
```

| Property | Takes | Fields it sets |
| --- | --- | --- |
| `transform` | `none`, or a list of `translate(x[, y])`, `translateX()`, `translateY()`, `scale(s[, sy])`, `scaleX()`, `scaleY()`, `rotate(angle)`, composed left to right | all five: `translateX`, `translateY`, `scaleX`, `scaleY`, `rotate` |
| `translate` | `x [y]`: px, or `%` of the element's own width (x) and height (y); `none` | `translateX`, `translateY` (strings like `"12"` or `"50%"`; default `"0"`) |
| `scale` | one number for both axes or two (`2`, `1.5 1`, `150%`); `none` | `scaleX`, `scaleY` (default 1) |
| `rotate` | an angle: `deg`, `turn`, `rad`, `grad`, or a bare number of degrees; `none` | `rotate` (degrees, clockwise) |
| `transform-origin` | one or two positions: `left`, `center`, `right`, `top`, `bottom`, px or `%` | `transformOriginX`, `transformOriginY` (default `"50%"`, the middle) |

- **The fields keep one translate, one rotation and one scale**, applied the way CSS applies its `translate`, `rotate` and `scale` properties: scale, then rotate, about the origin, then translate. A `transform` list is folded into them, so `rotate(90deg) translate(10px)` becomes `rotate: 90deg; translate: 0 10px`. A list that can't fold is refused with a warning: a rotation after an unequal scale (`scale(2, 1) rotate(45deg)` skews), or a `%` translate after a rotation that isn't a half turn. Write `rotate()` before `scale()`.
- **`transform` and the individual properties set the same fields**, so the later declaration wins for each field (CSS would apply both). `transform` sets all five, so `transform: scale(2)` puts `rotate` back to 0.
- **In markup**, `transform="…"`, `rotate="45"`, `scale="2"`, `translate-x="10"` and `transform-origin="left top"` work as attributes. The `translate` attribute stays HTML's "don't localise this" marker ([ADR 0356](../../decisions/0356-text-is-localised-through-keyed-string-tables-with-icu-messages-bound-by-key-in-ui-documents-and-scripts.md)), so write `transform="translate(…)"` or `translate-x`/`translate-y` instead.
- **Scripts** write the fields: `el.as(UIButton).rotate = 15`, `.scaleX = 1.1`, `.translateY = "-4"`.
- **Clipping:** an `overflow: hidden` element clips its children where it's drawn, so a turned clipper clips at its turned edges, and a transformed child is clipped where the transform puts it.
- **Paint** turns with the element: gradients, borders and rounded corners are drawn in its frame, and a shadow's offset turns and scales with it (its blur scales). 3D transforms, `skew()` and `matrix()` aren't supported.
- **The scene view** outlines the box as drawn and puts the handles on its turned corners. Resizing works in the element's own frame (dragging a turned edge changes its width by the distance in its own UI pixels). On an element with a transform of its own, the west and north handles change only the size, never `left`/`top` (those are in its parent's frame). Moving an absolutely positioned element works in its parent's frame, from where layout put it.
- **Input fields:** the hidden DOM `<input>` that takes typing (and IME composition) stays off-screen as before, so an IME's candidate window shows where the browser puts it, not next to the transformed field.

**Performance.** Changing a transform needs no new layout: Babylon GUI redraws only the regions the element leaves and enters. Its shadow and gradient are redrawn with it, so a transformed element with a large blur still costs what a moving shadow costs.

## Animation: transitions and keyframes

Stylesheets animate as CSS does ([ADR 0418](../../decisions/0418-the-ui-core-grows-toward-web-css-layout-paint-transforms-animation-and-selectors-in-waves.md) wave 4): a **transition** eases a field from its old value to its new one when a class, a pseudo-class (`:hover`, `:focus`…) or an attribute changes it, and an **animation** plays `@keyframes` while an element has it, starting when the element appears or when its `animation-name` changes. It works the same in UI documents and in Svelte views.

```css
.button { background-color: #335; transform: scale(1); transition: background-color 150ms ease-out, transform 150ms; }
.button:hover { background-color: #558; scale: 1.05; }
.toast { animation: slide-in 300ms ease-out, fade 300ms ease-in 3s forwards; }
@keyframes slide-in { from { translate: 0 -40px; opacity: 0; } }
@keyframes fade { to { opacity: 0; } }
.spinner { animation: spin 1s linear infinite; }
@keyframes spin { to { rotate: 360deg; } }
```

| Property | Takes |
| --- | --- |
| `transition` | comma-separated `property duration timing-function delay` in any order (the first time is the duration, the second the delay); `none` |
| `transition-property` | `all`, `none`, or property names; a shorthand covers its longhands (`padding` its sides, `transform` the transform fields, `box-shadow` the shadow's fields, `border-radius` the corners) |
| `transition-duration`, `transition-delay` | times: `0.3s`, `300ms` (a negative delay starts part-way) |
| `transition-timing-function` | `linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out`, `cubic-bezier(x1, y1, x2, y2)`, `steps(n[, jump-start \| jump-end \| jump-none \| jump-both \| start \| end])`, `step-start`, `step-end` |
| `animation` | comma-separated `name duration timing-function delay iteration-count direction fill-mode play-state` in any order |
| `animation-name` | `@keyframes` names, or `none` |
| `animation-iteration-count` | a number (`2.5` ends half way through the third) or `infinite` |
| `animation-direction` | `normal`, `reverse`, `alternate`, `alternate-reverse` |
| `animation-fill-mode` | `none`, `forwards` (hold the last value), `backwards` (show the first keyframe during the delay), `both` |
| `animation-play-state` | `running`, `paused` (toggle it with a class to pause and resume) |

- **What animates:** numbers (opacity, sizes in px, `font-size`, `gap`, `z-index` rounded…), lengths (`width`, `left`, `translate`…: px with px, `%` with `%`; a mixed pair or `auto` jumps half way), colours (in linear RGB), the transform fields, shadow fields, per-side padding, margins and borders, and corner radii. A side left unset animates from its all-sides value, and a shadow from `none` animates from a transparent one. Other fields (choices like `flex-direction`, text, images) change at once in a transition, and jump half way between keyframes.
- **`@keyframes`** take `from`, `to` and percentages (`0%, 50% { … }` lists several). A keyframe can set `animation-timing-function` for the segment that starts at it. A missing `from` or `to` uses the element's own value, so `@keyframes fade { from { opacity: 0 } }` fades in to whatever opacity the element has. The last `@keyframes` with a name wins.
- **These are styles, not fields:** set them in rules, as attributes (`<Panel class="x" transition="opacity 0.2s">`) or in a Svelte `style`. A script starts and stops them by changing classes or attributes.
- **A script writing a field** that's transitioning or animating takes it over at once, as an inline style would: `el.as(UIPanel).opacity = 1` stops that field's transition (no `transitionend`) or that field of the animation.
- **Time:** animations run on the World's unscaled clock, so UI still animates with `Time.timeScale = 0` (a pause menu). They start in the frame of the change.
- **Interrupting:** a transition interrupted by another change starts again from the value showing, towards the new value.
- **Events:** `el.on("transitionend", e => …)` with `e.propertyName` (kebab-case) and `e.elapsedTime`; `animationstart`, `animationiteration` and `animationend` with `e.animationName`. Like other UI events they arrive in the frame after they happened, and they're in the `UIEvents` buffer too. Svelte views listen on the element the same way (`UIViewElement.on`).
- **The Inspector** shows a field that's animating as *Transition* or *Animation*, over the rule or attribute it animates to.
- **Scenes being edited** don't animate: the editor shows each element's styled values.
- **Not supported:** `transition-behavior`, `animation-composition`, `animation-timeline`, the `linear()` timing function, and CSS's shortening of a transition that reverses half way. Changing an animation's duration or timing while it runs takes effect when it next starts (its play state applies at once). An inherited value (a `color` on a button) reaches its label at the end of a transition, not in between, unless the label transitions too.

**How it runs.** Transitions and keyframe segments run as tweens on the engine's tween core ([ADR 0420](../../decisions/0420-tweening-is-a-shared-rust-crate-linked-by-the-animation-core-and-a-small-tween-module.md)): the animation core's when the animation plugin is on, otherwise a small standalone tween module that loads the first time a document's stylesheet animates. Timing functions become engine curves (a cubic Bézier is exactly one Bézier segment). Measured headless (no drawing): 500 elements each transitioning a colour and a number cost about 1 ms a frame, and the frame that starts all 1,000 transitions about 17 ms (9 without transitions). Animating paint (shadows, gradients, colours of large boxes) also redraws regions each frame (see Paint above); opacity and transforms are the cheap things to animate.

## Scripting

A script finds the document on its node and reaches its elements with selectors. Element fields are plain values: change them at runtime and the UI follows next frame.

```ts
import { GameBehavior, UIDocument, UIText, behavior } from "myco";

@behavior("game.MainMenu")
export class MainMenu extends GameBehavior {
  private ui!: UIDocument;

  start() {
    this.ui = this.node.getBehavior(UIDocument)!;
    this.ui.data.score = 0; // {score} in the markup
    void this.ui.ready.then(() => {
      this.ui.query("#play")!.on("click", () => startGame(this.ui.query("#name")!.value ?? ""));
      this.ui.query("#name")!.on("submit", (e) => startGame(e.element.value ?? ""));
    });
  }

  update() {
    const play = this.ui.query("#play");
    if (play) this.ui.query("#title")!.as(UIText).text = play.hovered ? "Ready?" : "King of Pirates";
  }
}
```

- `query(selector)` and `queryAll(selector)` find elements (the root included); an element has its own `query`, `classList` (classes restyle it), `node`, `as(UIButton)` for its component, and the button and field state below.
- `on(type, handler)`: `click`, `change`, `submit`, `hover`, `focus`, `blur`, and `cancel` on the root; `transitionend`, `animationstart`, `animationiteration` and `animationend` (see Animation above).
- `ui.data` fills `{name}` bindings; it's checked each frame.
- **Rows made at runtime** (a list of rooms, a crew, markers): `ui.list("#rooms", items, setup, { key: "id" })` makes one row per item from the element's `<Template>`, reusing rows by key when it's called again. `{field}` in the row reads the item, so positions and colours can be bindings too (`<Panel left="{x}" background-color="{color}">`). There's no other way to add an element at runtime.
- `ui.ready` resolves once the document is built; `ui.problems` lists what was wrong in the markup and stylesheets.

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

## Svelte components and `UIView` (ADR 0419, in progress)

Game UI is moving to Svelte 5 components. UI documents keep working until the migration finishes.

Make a component with the Assets panel's **Create > UI > New Svelte Component** (it goes in `ui/`), add a `UIView` to a node and set its `component` to the `.svelte` asset.
 The view makes the canvas itself (its fields are the canvas settings: `mode`, `referenceResolution`, `matchHeight`, `sortOrder`, `pixelSize`, `modal`, `autoFocus`, `player`), so a component never writes a canvas tag:

```svelte
<script lang="ts">
  let { title, coins = 0 }: { title: string; coins?: number } = $props();
  let name = $state("");
</script>

<section class="panel" flex-direction="column" gap="4">
  <h1>{title} ({coins})</h1>
  <input bind:value={name} placeholder="Your name" onsubmit={() => console.log(name)} />
  <button onclick={() => coins++}>Add</button>
</section>

<style>
  .panel { background-color: #112233; padding: 8px; }
  h1 { color: var(--accent); }
  :global(:root) { --accent: #ffcc00; }
</style>
```

- **Tags are HTML names.** `div`, `section`, `nav`, `ul`, `li`… are panels; `span`, `p`, `h1`–`h6`, `label`, `b`, `em`… are text; `img` is an image; `button` a button; `input` and `textarea` input fields. Other tags warn once and are panels.
- **Attributes are fields** in kebab-case, as in UI documents (`flex-direction="column"`, `font-size={24}`). `class`, `id`, `style`, `class:` and `style:` feed the cascade. HTML-only attributes (`type`, `alt`, `aria-*`, `data-*`…) stay on the node.
- **Text** inside a text tag is its text, nested tags included (`<p>Hi <b>you</b></p>`). Text anywhere else becomes its own text element (a button's label).
- **Events:** `onclick`, `oninput`, `onchange`, `onsubmit`, `onfocus`, `onblur`, `onpointerenter`, `onpointerleave`, or the older `on:click` form with its modifiers (`|once`, `|preventDefault`, `|stopPropagation`). They come from the UI core, so the mouse, touch, keyboard and gamepad all reach them, and their changes show in the same frame. `e.currentTarget.value` reads an input field. Events don't bubble yet.
- **Bindings:** `bind:value` on `input`, and `bind:this`, which gives a node with an Element subset for actions and attachments: `setAttribute`/`getAttribute`, `classList`, `style` (`node.style.color = "red"`), `dataset`, `addEventListener`/`dispatchEvent`, `focus`/`blur` (the UI's focus), `getBoundingClientRect` (in canvas UI pixels, through transforms), `closest`/`matches`/`querySelector`, `contains`, `parentElement`/`children`/`nextElementSibling`…, `value`, `textContent`.
- **The window:** `<svelte:window>`, `<svelte:document>` and `<svelte:body>` work. `onkeydown`/`onkeyup` get the keys the game gets (none while a text field is typing), `onpointerdown`/`onpointerup`/`onpointermove`/`onwheel` the pointer outside UI, and `onresize` fires when the game's canvas changes size. `bind:innerWidth`/`bind:innerHeight` are the canvas's size in CSS pixels, and `bind:devicePixelRatio`, `bind:online` and `<svelte:document bind:activeElement>` (the focused element) work too.
- **`<svelte:head>`:** its `<title>` sets the browser tab's or the desktop window's title; anything else in it is ignored with a warning.
- **Localised text:** `import { t } from "myco"` and write `{t("menu.start")}` or `{t("hud.coins", { count })}`: the message in the current language, as `Locale.t`, which follows `Locale.setLanguage` (and string table edits) in the same frame.
- **Styles** are Svelte's: a component's `<style>` is scoped to it (`<svelte:options css="injected" />` works too); `:global(...)` rules apply to every `UIView` in the World (one theme for the HUD and the pause menu). Selectors match the tag as written (`button`, `div`), in any case, and `:is()`/`:where()` work (`:where()` adds no specificity).
- **Scripts** pass data through `view.props`, which is reactive (`view.props.coins = 10` shows that frame), wait for `await view.ready`, and find elements with `view.query("#play")`/`view.queryAll(".row")`. Disabling or removing the view unmounts the component; enabling it mounts it again with fresh state and the same props.
- **Shared state** goes in rune modules (`ui/score.svelte.ts`: `export const score = $state({ value: 0 })`), which components and scripts both import (`import { score } from "../ui/score.svelte"`).
- **Plain `.css` files** a component imports (`import "./theme.css"`) apply to every `UIView` in the World, like `:global` rules. A `.css` file nothing imports isn't loaded.
- `addComponent(UIPanel)` and the other UI components stay refused: a view's render (or a document's build) makes them.

**Compiling.** Components (`.svelte`), rune modules (`.svelte.ts`, anywhere in the project) and the `.css` files they import compile with the project's scripts, in the editor and when you export:

- In the editor they compile when the project opens and again whenever you save one (in the Code panel or outside the editor), or create one. A mounted `UIView` shows the new version in its next frame and keeps its `props` (hot reload); its own state starts over. A compile error is reported like a script's (the status line, with the file and line), and the view keeps showing the last version that compiled.
- Play's type check covers rune modules (Svelte's runes and modules are known to the Code panel's TypeScript service). Inside `.svelte` files, the Svelte compiler's errors are reported, but types aren't checked yet (no svelte-check).
- A game build compiles them without the editor's debugging information. The `.svelte` and `.svelte.ts` files don't ship: their compiled code does, with Svelte's runtime and the engine's renderer from the player, never the compiler. Styles are parsed when they compile, so a game that uses only Svelte UI doesn't load the CSS parser.


Not yet: transitions and `animate:`, `{@html}`, bubbling and capture (so `<svelte:window onclick>` doesn't hear clicks on UI), `scrollIntoView`, npm packages that import Svelte, type checking inside `.svelte` files, and the editor's view of components (picking, Inspector edits).
 How much of Svelte works is measured by `npm run test:svelte-conformance`, which runs Svelte's own runtime tests against the engine's renderer (see the 0419 row of the implementation status).

## Headless Worlds and tests

A document builds its elements in any World. Only a World with a render backend lays them out and draws them, so a server or a test can build UI without WebGL; there the pointer and typing do nothing and navigation has no layout to move focus through (a script's focus still takes `submit` and `cancel`). Tests click, hover, type and navigate through a UI core and `Input`, as a player does (`engine/tests/uiPointer.ts`, `engine/tests/uiNavigation.test.ts`).

## Known gaps

- No scrolling, sliders, toggles or dropdowns.
- No 3D transforms, `skew()` or `matrix()`; a rotation inside an unequal scale (a parent scaled `2 1` with a turned child) is drawn without its skew, though the pointer still follows the exact transform.
- No on-screen keyboard: a gamepad can focus an input field but not type in it.
- In a Svelte component, `ontransitionend={…}` and the other animation event attributes aren't wired yet; listen with `on("transitionend", …)` on the element from `UIView.query`.
- No styling of focus beyond `focusColor` (a `:focus` rule styles input fields only).
- `fit: contain` in a box with both sides fixed stretches like `fill`.
- A script can add elements at runtime only through `list()` and a `<Template>`.
