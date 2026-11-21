# 0299. One event-references module lists and rewrites the names an audio event reads

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0158 (§2 local parameters hide global ones), 0162 (§2.5 aux sends), 0166 (music tracks, stingers, region conditions), 0262 (named lists and the shell's rename), 0269 (the music tree module)

## Context

"Which places in an audio event name parameter X or bus Y?" was answered three times:

- **The Event editor** (`plugins/audio/editor/event/eventTreeModel.ts`): `parameterUses` and `renameParameter` walked the
  typed asset (event and node automation, `switch`/`blend` parameters), and `musicParameterUses` /
  `renameMusicParameter` repeated the walk for the music tree. No bus references at all.
- **The settings rename** (`plugins/audio/editor/audioNames.ts`, ADR 0262): `renamedMember` renamed every JSON member
  called `parameter` or `bus`, at any depth, whatever it meant; local-shadows-global was "skip the whole file when its
  own parameters have either name".
- **The runtime** (`eventRuntime.ts`): a binding reads the local parameter when the event defines one of that name, else
  the global one.

They agreed by coincidence. The untyped walk would rename a key that names nothing (a music node's own `automation`,
which the parser ignores, or a stray `bus` on a clip), and a new referencing field had to be added in two walks.

## Decision

We will have one module, **`src/engine/audio/eventReferences.ts`** beside `musicTree.ts`, that knows where an event names
a parameter or a bus, on the asset as parsed or on the file's JSON as written (the music tree under `musicRoot` or
`root`):

- **`eventNameReferences(event)`** lists every reference in file order: `{ kind: "parameter" | "bus", name, where, scope,
  key? }`. `where` is the path of keys from the event to the field; `key` marks a name that is the last step's key (an
  aux send in `sends`). `scope` is `"local"` when the event's own `parameters` define the name (it hides a global one,
  ADR 0158 §2), else `"global"`; buses are always global. Parameter references: the event's and every 0158 node's
  `automation`, `switch`/`blend` `parameter`, a `musicSwitch`'s `parameter`, a music track's `automation`, a region's
  `while`. Bus references: the event's `bus`, an aux send's key (never `reverb`, the event's own send), a music
  track's and a stinger's `bus`. Empty names name nothing and are not listed.
- **`rewriteEventReference(event, ref, to)`** rewrites one, copying only the path to it (an aux send keeps its place
  among the keys). It refuses (returns the event) a send renamed to `reverb` or to a key already there.
- **`renameEventName(event, kind, scope, from, to)`** rewrites every reference of that kind and scope naming `from`; a
  local rename also renames the definition in `parameters`. A global parameter rename leaves an event alone when its own
  parameters define `to` (the renamed reads would bind to the local one). Returns the same value when nothing changes.

Callers: the Parameters pane's use count and the local rename (`eventParameters.ts` `renameParameterAt`), and the Audio
section's bus and global parameter renames (`audioNames.ts`). The shadowing rule is the runtime's
(`localDefs.has(name)`); the runtime does not call the module (its one-line rule needs no walk).

## Alternatives considered

- **Keep the untyped walk, add bus references to the typed one** — two walks still, and the untyped one keeps renaming
  keys that name nothing.
- **Rename by parsing and re-formatting the file** — one typed walk, but a rename would rewrite every event file it
  touches in the formatter's shape and drop what the lenient parser drops.

## Consequences

**Positive**
- A new referencing field is added in one place; the use count, the local rename and both settings renames follow.
- One test table of the reference list.

**Negative / costs**
- A member called `parameter` or `bus` where the format has none (an ignored music-node `automation`, a stray key) is no
  longer renamed by a settings rename. It meant nothing before either.

## Deprecates

`parameterUses`, `renameParameter`, `musicParameterUses`, `renameMusicParameter` (eventTreeModel.ts) and
`renamedMember`, `renameBusInEvent`, `renameParameterInEvent` (audioNames.ts): removed.

## Open questions

None.

## References

`src/engine/audio/eventReferences.ts`, `src/engine/audio/eventReferences.test.ts`; review card 5 of the 2026-11-21
architecture review.
