# 0457. The codec owns how field types travel, and one catalogue owns the net messages a handshake lists

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0033 (netcode), 0030 (script reload), 0311 (the session answers net questions), 0337 (networked actions; "a shared codec option"), 0433 (action set assets)

## Context

**Field encoding was written four times.** `recordCodec` (`net/codec.ts`) kept its per-type rules private (`same`, `unchangedValue`). `input.ts` re-derived a value's round trip (`wire`) to give a client its input as the server reads it; `replication/layout.ts` `sameState` copied the codec's comparison (its doc comment said so) without the codec's out-of-range check, and kept per-field `steps` and `kinds` beside the codec's own plan. A schema's description was built three ways: `rpc.ts` (`name:kind`), `input.ts` (`name:kind~step`), and `layout.ts` `shapesKey` (`kind/step`). The RPC and input descriptors travel in the hello. The id check (non-empty, no parentheses) was copied in `rpc.ts` and `input.ts`. ADR 0337 asked for one shared codec option.

**Message kinds only grew.** `session.ts` kept an RPC map and a `messageKinds` list; `rpc.ts` kept its own `defined` set, and never recorded its RPCs with the script registrations (ADR 0030), so a deleted script's RPC was never forgotten. `_undefineInput` deleted only the editor's list entry, and redefining a stream with another schema (a script reload, or an action set asset changing, ADR 0433) registered a new `net.input:` kind while the old one stayed. The input kind's name format was parsed with `startsWith` in `session.ts` and `src/editor/netPlay.ts`.

**This was a bug across processes.** The hello lists every RPC and kind, and both ends number kinds by their sorted names. After a reload, an editor's hello listed stale entries that a process that loaded only the new scripts didn't: an RPC or input "only the client defines" refused the connection. A stale input kind whose stream id was still defined slipped past the mismatch check (it compares by name, and both descriptors had the same name), and then shifted every later kind's wire number, so snapshots and acks went to the wrong kinds.

## Decision

**The codec owns how each field type travels.** `RecordCodec` gains:
- `signature`: the schema and its encoding as the handshake compares them, from `schemaSignature(schema, encoding)` (`name:kind[~step]`, comma-separated) and `fieldSignature(kind, quantize)`. The RPC descriptor is `id(schemaSignature(schema))` (it includes `str` fields), the input kind `net.input:id(codec.signature)`. These strings are byte-identical to what was sent before, so `NET_PROTOCOL_VERSION` stays 7. `shapesKey` (a local cache key, never sent) uses `fieldSignature` too.
- `coerce(values)` and `coerceAt(i, value)`: a value as the receiver reads it (`unchangedValue` before). Input streams use them in place of `wire`.
- `sameAt(i, a, b)`: whether two values encode the same, as a delta write decides. `sameState` loops it; quantized fields now get the codec's out-of-range check.
- `quantizeAt(i)`: the field's step (0 for none). Replication's misprediction tolerances read it; `Layout.steps` and `Layout.kinds` are gone.

**One net message catalogue** (`net/catalogue.ts`) holds every message kind and RPC type this process can send:
- `defineMessage(name)` returns a local kind id; `forgetMessage(name)` takes the kind out of the handshake. `defineRpcEntry(entry)` / `forgetRpc(id)` / `hasRpc(id)` do the same for RPC types. `checkMessageId(what, id)` is the one id check.
- `handshakeSet()` captures what a connection's handshake lists and numbers, at once: the sorted RPC descriptors and kind names, the RPC entries in wire order, and the local kind ids in wire order.
- `describeKind(name)` says whether a kind name is an input stream's (with its descriptor) or the engine's; `inputKindName(id, signature)` builds one; `kindName(local)` names a local id. Nothing else parses kind names.

**Local kind ids are positions and never change.** Forgetting a kind removes it from the handshake set only; the id is never reused, and defining the name again returns it. Each connection captures `handshakeSet()` once: a client when it sends its hello (it numbers with that capture when welcomed, so a definition changing in between can't skew it), a server when it checks the hello. A connection already open keeps its numbering: a kind forgotten since still sends and arrives on it, and a kind defined since can't be sent on it (as before).

**What forgets.** `defineRpc` records its id (`ScriptRegistrations.rpcs`), and the editor's `unregisterScripts` forgets it (`_undefineRpc`). `_undefineInput` forgets the stream's kind and drops the stream. Redefining a stream with another schema (`defineInput` while reloading, `_redefineInput`) forgets its old kind.

## Alternatives considered

- **Bump `NET_PROTOCOL_VERSION` and use one signature format everywhere** — the RPC and input formats already agree (RPCs have no quantize), so keeping them byte-identical costs nothing; only the local `shapesKey` changed format.
- **Remove forgotten kinds from the list and renumber** — open connections hold wire numbers derived from local ids; renumbering under them would misroute their messages.
- **A `same(a, b)` over whole records** — no caller needs it: replication compares arrays field by field, and the codec's own write compares per field.

## Consequences

**Positive**
- Two processes whose scripts were loaded, reloaded and deleted in different orders agree in the handshake when they define the same things now.
- One place says how an `f32`, quantized `f32`, `i32` and `u8` travel; one place says what a kind's name means.

**Negative / costs**
- An input write of a quantized value too large for its step now throws at `write` rather than when the input is sent; `sameState` throws for such a value (or NaN) rather than letting the codec's write throw right after.

## Deprecates

`registerNetMessage` and `registerRpc` (`session.ts`; now `defineMessage` and `defineRpcEntry` in `catalogue.ts`), the session's RPC map and `messageKinds`, `rpc.ts`'s `defined` set, `input.ts`'s `wire` and `Stream.coerce`, `Layout.steps` and `Layout.kinds`, and the `startsWith("net.input:")` checks in `session.ts` and `netPlay.ts`: removed.

## Open questions

None.

## As built (2026-11-28)

- Tests: `codec.test.ts` (coerce matches a round trip, `sameAt`, signature formats), `session.test.ts` "the message catalogue" (a hello after a load, a reload that changes an input's schema and a deleted script equals the hello of a process that loaded only the new scripts; a forgotten kind keeps working on an open connection, leaves new handshakes, and gets its old id back when defined again).
- A server's input streams for a forgotten kind stop draining it; anything still arriving on it from an open connection sits in its capped queue.

## References

- `src/engine/net/catalogue.ts`, `net/codec.ts`, `net/session.ts`, `net/rpc.ts`, `net/input.ts`, `net/replication/layout.ts`, `core/registry.ts`, `engine/editor/index.ts`, `src/editor/scriptLoader.ts`, `src/editor/netPlay.ts`
