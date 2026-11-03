# 0024. Saves and settings through a platform Storage API

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0003

## Context

0003 puts platform services behind an adapter with browser and Tauri implementations, and leaves save/settings storage open. Games need saves, settings and small caches, both in the desktop build and in browser demos.

## Decision

- The engine exposes a **`Storage` API** from the platform adapter:

  ```ts
  await Storage.save("slot1", data);            // JSON-serializable or ArrayBuffer
  const data = await Storage.load("slot1");
  await Storage.delete("slot1");
  const keys = await Storage.list();
  ```

- Separate namespaces for `saves`, `settings` and `cache`.
- **Tauri adapter**: files in the app's data directory (one file per key, written atomically: write temp, then rename).
- **Browser adapter**: IndexedDB.
- Data is versioned by the game. The engine stores bytes and doesn't interpret save contents.

## Alternatives considered

- **Tauri files only.** Browser demos would have no saves.
- **localStorage.** Small quota, strings only, synchronous.
- **Defer.** Cheap to define now; avoids games calling Tauri APIs directly.

## Consequences

**Positive**
- Same game code saves in desktop and browser builds.

**Negative / costs**
- Async API everywhere (IndexedDB and file I/O are async).

## Deprecates

- Nothing.

## Open questions

- Cloud saves (e.g. Steam Cloud) as a later adapter feature.

## References

- [0003](0003-tauri-platform-browser-runtime.md)
