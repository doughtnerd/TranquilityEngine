# 0347. Audio packages are named BioPak

- **Status:** Proposed (held: not built on the animation branch, owner 2026-11-22)
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** audio 0337 (the package file's name, extension and magic only)
- **Related:** 0341

## Context

Audio 0337 (audio branch, merging first) ships audio in loadable packages, built as `audio/packages/<name>.mycopak`: the magic `MYCOPAK1`, a JSON TOC `myco.audiopack@1`, and 16-byte-aligned entries. The audio plugin will be renamed **Biosonic** after the audio work.

The owner decided (2026-11-22):
- Audio packages are called **BioPak**.
- A package of mixed assets (sounds, animation clips, pose databases, models) would get a different name and convention, in its own record later.
- Neither change is built on the animation branch.

## Decision

When this record is built, after the animation work:

- **File:** `audio/packages/<name>.biopak`, magic `BIOPAK01`, TOC format `myco.biopak@1`. The TOC's fields and the entry layout stay as audio 0337 defines them.
- **Names:** BioPak in the Studio's Packages screen, the export report, docs and messages. The `AudioPackage` API and `audio.json` `packages` keep their names.
- **Audio only.** BioPaks hold audio. Other asset kinds never go into them.
- **Old files:** `.mycopak` outputs are rebuilt on the next export. Readers refuse `MYCOPAK1` with a message to re-export (audio 0337's capture rule: refuse rather than misread, no migration of build outputs).

## Alternatives considered

- **Engine-wide BioPaks holding every asset kind.** Too large an asset-pipeline change for the animation branch, and the owner wants mixed-asset packages under a different name.
- **Keep `.mycopak`.** The owner prefers the audio system's own naming ahead of the Biosonic rename.

## Consequences

**Positive**
- A small, contained rename inside the audio plugin.

**Negative / costs**
- Builds made before it must be re-exported.
- Animation clips and pose databases have no loadable packages until the mixed-asset package record exists. They load as individual assets.

## Deprecates

The `.mycopak` extension, the `MYCOPAK1` magic and `myco.audiopack@1`, once built.

## Open questions

- The name, convention and scope of the mixed-asset package (its own record, after the animation build).

## References

Audio 0337 §7 (packages), `src/engine/audio/packaging/format.ts` (audio branch).
