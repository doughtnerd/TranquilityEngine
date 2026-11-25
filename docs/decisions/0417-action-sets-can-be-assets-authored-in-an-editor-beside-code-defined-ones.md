# 0417. Action sets can also be assets (`*.actions.json`), authored in an Input dialog, and bindings live only in contexts

- **Status:** Accepted
- **Date:** 2026-11-25 (revised 2026-11-26 after the design review)
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0336: actions are no longer code only, and an asset set carries no controls)
- **Related:** 0148, 0233, 0272, 0329, 0336, 0337

## Context

ADR 0336 made actions code: `defineActions("game.PlayerActions", { jump: button("<Keyboard>/space") })` registers a
data component, and contexts (`*.input.json`) map controls to the actions that exist. Controls given inline in
`defineActions` form the project's default context, so a small game needn't author one. The context editor
(`editor/ui/InputContextEditor.tsx`) lists the registered actions in a dropdown.

In a new project the only set registered is the engine's `engine.UIActions`, so the first context a user makes offers
`navigate (vec2) · engine.UIActions` and nothing else, and adding a game action means leaving the editor to write a
script. Owner feedback: confusing; actions should be creatable visually.

A set in data is already plain: `button(...)` returns `{ kind, defaults, options }`, and `defineActions` takes an id, a
record of those and `ActionSetOptions` (`networked`, `encoding`, `redundancy`, `key`). Scripts read actions by name
(`this.input.performed("jump")`); systems need the set's definition for their query (`query: [Transform,
PlayerActions]`); scripts can already import the project's JSON files through the code linker (0329).

The design was worked through on a canvas (`Action Set editor (ADR 0417)`); its board 1 is a working prototype. The
review settled two things this record didn't have at first: the editor is a dialog, not the Inspector, and putting
controls in both the set and the contexts read as the same thing twice.

## Decision

**An action set is a code definition or an asset; both register the same `ActionSetDef`.** Code-defined sets (0336)
stay as they are.

**Sets say what the game can do; contexts say which controls do it.** An asset set has actions (name, type, consume)
and networking, and no controls, modifiers or triggers. Every binding is a mapping in a context.

**The asset: `*.actions.json`, asset kind `actionSet`** (0233), one set per file:

```json
{ "id": "game.PlayerActions",
  "actions": [
    { "name": "heavy", "type": "button" },
    { "name": "move", "type": "vec2", "consume": true }
  ],
  "networked": true, "redundancy": 3, "encoding": { "move": { "quantize": 0.007874 } } }
```

- `actions` is a list, so the user's order is the field order (the editor shows it A to Z). Each action has `name`,
  `type` (`button`, `axis`, `vec2`, `vec3`) and optional `consume`.
- Set fields: `id`, optional `key`, `networked`, `redundancy`, `encoding`.
- **Engine:** `input/actionAssets.ts` parses and validates a file (`actionSetProblems`, every problem with its path,
  as 0272) and calls `defineActions`. Public: `defineActionsFromData(spec)`, for tools and tests.

**The default context is a real file.** Every project has `input/default.input.json`, made with the project (and by
the editor for a project that lacks one). It is on whenever no other context is, so it holds each action's everyday
controls. It can't be renamed or deleted. Controls given inline in `defineActions` still work as 0336 says: they
appear in the default context as read-only mappings marked as coming from a script.

**Loading.** `project.json` lists the files: `input.actionSets: ["input/player.actions.json"]`.

- `bootProject` loads them beside `bootLocale`, before the bootstrap, so every World's players get them (0337).
- The list is the order sets are defined in; Project Settings › Input shows it with drag handles (and Space, arrows,
  Space from the keyboard). New Action Set adds a file; rename and delete update the list through the asset reference
  module (0148). Hand-written lists are validated like any settings section (0272).
- A changed file is defined again (`Assets.onChanged`), as a script reload replaces a code set.

**Scripts.**

- By name, as today: `this.input.performed("jump")`, `InputPlayers.get(0).vector2("move")`.
- Systems import the file: `import PlayerActions from "../input/player.actions.json"`. The linker (0329) makes an
  `*.actions.json` import a module that defines the set (or returns it if it's defined already), so
  `query: [Transform, PlayerActions]` works whatever loads first. The script checker types the import as
  `ActionSetDef`.

**One id, one source.** An id defined both in code and by an asset is reported in both places, and in the console at
run time. The asset wins, since it's what the editor shows.

**The editor: an Input dialog** (Project › Input, or double-clicking an `.actions.json` or `.input.json`), replacing
the context editor in the Inspector:

- **Left list:** action sets and contexts, each A to Z, with + to add. A new set or context stays at the end of the
  list, its name selected for typing, until the name is committed. Right-click (or F2) on an entry: Rename in place,
  Duplicate, Copy id, Delete. Code-defined sets and the default context can't be renamed or deleted.
- **A set:** Name (bound to its list entry as you type), Name in system queries, Asset path; its actions A to Z, each
  with name, type, consume and **Mapped in** (the contexts that map it, with their controls, one click away). An
  action no context maps is flagged, with *Map it in default*. Changing a type converts the controls in every mapping
  of the action and says what changed. A Networking section: send to the server, resent ticks, precision per analog
  action, upload per action and in total.
- **A context:** Name, Used by (the nodes whose InputContext turns it on, and their priority), Asset path; its
  mappings, each with:
  - the action, picked from a searchable combobox grouped by set (sets fold; search filters every set; matches first,
    then *Create "name" in* each set and *New set…*, so a missing action is made where it's needed);
  - controls: single or composite (D-pad, axis), bound by clicking a field and pressing a key, or picking a mouse or
    gamepad control; a warning when a control doesn't suit the slot (a key as a vec2's single control);
  - modifiers as an ordered stack (run top to bottom; drag, keyboard or ⋯ to reorder; a value tried through the chain
    shows each step's output);
  - triggers as chips grouped by how they combine (any of these, all of these, blocked by);
  - consume and a note.
- **History:** a panel with every edit as a step, an undo tree (going back and editing starts a branch and keeps the
  old one), Undo and Redo buttons and Ctrl+Z / Ctrl+Shift+Z. A footer shows Saving…, Saved, or Live (saved and
  applied to Play). Removals are undoable from a toast.
- The pane lays out by its own width, so it stays readable with History open.

## Alternatives considered

- **Keep actions code-only, add a "New Action Set" script template.** Least work, but it's still a script to read and
  edit, and the context editor can't add an action where the user needs one.
- **The editor writes TypeScript (`defineActions` source).** Typed names for free, but the editor would have to
  round-trip code a user may also edit by hand; data with a loader is the pattern every other asset follows.
- **Default controls in the set file (0336's model, as first proposed here).** No default context file, but a key
  could then be bound in two places, the set and a context, and the editor showed the same editors twice. Rejected in
  review.
- **Put actions in the context file.** Fewer files, but a set is shared by every context, the networking stream and
  pawns (0337); defining actions inside one context makes the others depend on it.
- **Edit in the Inspector.** What exists today; too narrow for mappings with controls, modifiers and triggers, and it
  shows one file at a time. A dialog shows every set and context together.
- **Find every `*.actions.json` at boot instead of listing them.** No list to keep, but a game build has no folder
  listing to search, and the list doubles as the order sets are defined in.

## Consequences

**Positive**
- A game's input is made entirely in the editor: action sets, contexts, bindings, and the debugger to watch them.
- One place to bind a key: a context. The set editor shows where each action is mapped.
- Rebinding, prompts, glyphs and networking work unchanged: they see an `ActionSetDef`.
- Code users lose nothing; both kinds of set can live in one project.

**Negative / costs**
- Two ways to define a set, and a duplicate-id rule to explain.
- A project always has a default context file, even when it maps nothing yet.
- Code sets keep inline defaults while asset sets can't have them; the default context shows the difference
  (read-only mappings from scripts).
- Imported sets are typed as `ActionSetDef` with string names, not checked against the actions, unlike `defineActions`
  in code.
- A new asset kind, settings field, boot step, linker rule and dialog to maintain; the context editor's control,
  modifier and trigger rows must be split out to share them.

## Deprecates

- The context editor in the Inspector (`InputContextEditor.tsx`): its rows move into the Input dialog, and selecting
  an `.input.json` opens the dialog.
- For asset sets, 0336's inline defaults: they become mappings in `default.input.json`.

## Open questions

- ~~Should a code-defined set be convertible to an asset from the editor?~~ Not in the first build. When a project
  has code sets to migrate: a "Convert to asset…" item on a read-only set, with a preview of what moves where. It
  writes the set file, moves the inline defaults into the default context and adds the file to `input.actionSets`;
  the user then deletes the `defineActions` call (until then the duplicate-id report stands). Values computed at run
  time are written as they are at that moment.
- ~~Could the checker declare each `*.actions.json` with its own action names?~~ Yes, as a follow-up once asset sets
  exist: the script checker generates a declaration per file (`ActionSetDef<{ jump: "button", … }>`), regenerated on
  save, so imports in systems get checked names and a rename shows every stale use. Behaviour scripts' string names
  (`this.input.performed("jump")`) stay unchecked.
- The prototype's choices to confirm while building: which controls count as unsuited to a slot, how a type change
  converts composites, the deadzone and curve formulas behind the tried value, and the wire size of each precision.

## References

- Canvas: `Action Set editor (ADR 0417)`, board 1 (working prototype) and boards 1b to 4
- `src/engine/input/actions.ts` (`defineActions`, `ActionSetOptions`), `src/engine/input/contexts.ts`
- `src/editor/ui/InputContextEditor.tsx`, `src/editor/inputContextModel.ts`, `src/editor/inputContextKind.ts`
- `src/engine/core/projectBoot.ts` (`bootLocale` precedent), `src/engine/core/settings.ts` (`input` section)
- `src/editor/scriptLoader.ts` and the code linker (0329) for JSON imports
