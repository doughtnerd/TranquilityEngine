# 0384. Desktop save files name their keys so no two collide on any disk

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0024, 0317
- **Amended by:** [0387](0387-desktop-save-files-shorten-long-keys-to-a-prefix-and-a-hash.md) (long keys: a prefix and a hash, the key kept inside the file; answers the open question below)

## Context

Under Tauri, player storage keeps one file per key, `<root>/<namespace>/<key>.json` (or `.bin`), and since 0024
the file name has been `encodeURIComponent(key)` (`tauriRecords.ts`). That encoding leaves upper-case letters and
`! ' ( ) * ~` as they are, so:

- on a case-insensitive disk (Windows, macOS by default) the keys `Slot` and `slot` share one file, and what one
  saves the other reads;
- a key with `*` gives a file name Windows refuses, and a key such as `CON` or `nul.cfg` names a Windows device;
- a stray file in a namespace folder whose name isn't valid percent-encoding (`100%.json`) made `keys()` (so
  `Storage.list`) throw.

Players already have save files under the old names, so whatever replaces it must still read them.

## Decision

We will name a key's file by a canonical encoding that is distinct, under case folding, for every key:

- URI-encode the key, then percent-encode every remaining character other than `a-z 0-9 . _ -` (upper-case letters,
  `! ' ( ) * ~`), always with upper-case hex digits. Two different keys can then never give names that differ only
  in case.
- When the name, up to its first dot, is a Windows device name (`con`, `prn`, `aux`, `nul`, `com0-9`, `lpt0-9`),
  percent-encode its first letter (`%63on.json`).
- Names are still read back with `decodeURIComponent`, so files written before this record decode to their keys.
- The first time a namespace is used (put, get, remove or keys), files whose names aren't today's encoding of the
  key they decode to are renamed to it, before anything is read or written: on a case-insensitive disk a new
  `slot1.json` would otherwise land in an old `Slot1.json`. A file whose new name is taken is left alone, and a
  failure is logged, not thrown.
- `keys()` skips a file whose name doesn't decode (a stray file), as it already skipped other extensions.

Keys made of `a-z 0-9 . _ -` (most keys: `best`, `history-x.a`, `audio%2Fvolume` for `audio/volume`) keep the
file names they had.

## Alternatives considered

- **Hash the key** (`sha1(key).json`) — always safe, but the folder no longer shows what is in it, and listing keys
  would need an index file to map names back.
- **Read the old name as a fallback on every miss** instead of renaming once — on a case-insensitive disk an
  `exists` check can't tell `Slot1.json` from `slot1.json`, so the fallback could hand one key another's file.
- **Refuse unsafe keys** — games choose keys at runtime (player names, level ids); refusing them would turn a
  storage detail into a game bug.

## Consequences

**Positive**
- Every key gets its own file on every desktop OS; no key names a device or a refused file name.
- A stray file in a save folder no longer breaks `Storage.list`.

**Negative / costs**
- Keys with upper-case letters or punctuation give longer, less readable file names (`%53lot1.json`).
- The first use of a namespace lists its folder once more, to rename old files.
- Keys that collided before this record (two keys in one file) can't be pulled apart: the file goes to the key its
  name spells.

## Deprecates

The plain `encodeURIComponent` file names of 0024 / 0317; files with them are renamed on first use, as above.

## Open questions

Very long keys can still exceed a file system's name length limit (255 bytes on most); nothing shortens them yet.

## References

- `src/engine/platform/tauriRecords.ts` (`fileNameOf`, `recordOf`, `TauriRecords.renameLegacy`)
- `src/engine/tests/storage.test.ts` ("files (Tauri): keys as file names")
