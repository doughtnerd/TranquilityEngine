# 0387. Desktop save files shorten long keys to a prefix and a hash

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0384)
- **Related:** 0024, 0317, 0384

## Context

0384 names a key's save file by a canonical encoding of the key (`tauriRecords.ts`), and left one question open:
a long key can give a name longer than the file system allows. Most file systems cap a name at 255 bytes, and on
Windows the whole path (app data folder, namespace and name) runs into the 260-character `MAX_PATH` in many tools.
The encoding makes names longer than their keys: an upper-case letter or punctuation mark takes three characters,
a non-ASCII letter six or more. Games pick keys at runtime (level ids, player names, paths), so a key long enough
to fail is plausible, and the write then fails with an OS error.

## Decision

We will shorten a long key's file name, and keep the full key inside the file:

- When a key's 0384 encoding is longer than **100 characters** (before the extension), its file is named
  `<prefix>~<hash>.json` (or `.bin`): the encoding's first 64 characters (cut before an escape that the 64th
  character would split), then `~`, then the first 32 hex digits (128 bits) of the SHA-256 of the key's UTF-8
  bytes. The name is at most 97 characters plus the extension, ASCII, and still shows what the file is about.
  `~` never appears bare in a 0384 name, so a shortened name can't be another key's whole name.
- A shortened file's content starts with the key as a JSON string and a newline (`"level-…"\n`), then the record:
  the JSON text for `.json`, the bytes (after the line's UTF-8) for `.bin`. JSON never writes a bare newline, so
  the first newline ends the key. Keys within the limit keep 0384's names and unchanged content.
- `get` reads the key from a shortened file and returns the record only when it is the key asked for, so a hash
  collision (or a hand-edited file) reads as no record, never as another key's data.
- `keys()` reads the key from each shortened file, and checks that it hashes to the name. A name that only looks
  shortened (an earlier build's plain URI-encoding left `~` bare) but whose content doesn't check out is read as a
  whole name, as before.
- 0384's once-per-namespace rename also moves a long key's file named in full (written by an earlier build where
  the disk allowed it) to its shortened name, writing the key inside, then removes the old file. As in 0384, a file
  whose new name is taken is left alone and a failure is logged.

**Unrecoverable:** keys that already shared a file under the encoding before 0384 (`Slot` and `slot` on a
case-insensitive disk) can't be separated. The file holds whichever was written last and goes to the key its name
spells; the other key's earlier value is lost. Neither 0384 nor this record can tell from the file which key wrote
it, and nothing tries.

## Alternatives considered

- **Hash every key's name** — uniform, but the folder no longer shows what is in it, and every file would need
  its key inside; most keys are short and never needed it.
- **An index file mapping short names to keys** — a second file that must stay in step with the records, and a
  write that can be torn between the two; keeping the key in the record's own file is written atomically with it.
- **A sidecar `.key` file per shortened record** — the same tearing between two files, and twice the files.
- **Truncate without a hash** — two long keys with the same start would share a file.
- **Use the full 64-digit hash** — 128 bits already makes an accidental collision unreachable, and `get` checks
  the key anyway; the shorter name leaves room in Windows paths.

## Consequences

**Positive**
- Any key, however long, saves on every desktop file system; names stay at most about 100 characters.
- Saves written before keep loading: short keys' files are untouched, long ones are moved on first use.

**Negative / costs**
- A shortened file isn't the bare record: tools reading save files directly must skip its first line.
- `keys()` reads each shortened file (to learn its key), which costs one read per long key per listing.
- Files once named in full are rewritten (not renamed) on first use.

## Deprecates

0384's open question on long keys, which this answers. Nothing else.

## Open questions

None.

## References

- `src/engine/platform/tauriRecords.ts` (`nameOf`, `wrap`, `unwrap`, `TauriRecords.recordFile`, `TauriRecords.renameLegacy`)
- `src/engine/tests/storage.test.ts` ("files (Tauri): long keys (ADR 0387)")
