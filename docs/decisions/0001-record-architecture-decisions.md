# 0001. Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** —

## Context

The project went dormant from 2021 to 2026. When work resumed, the design reasoning from an earlier working session had been lost: nothing about the intended architecture (three.js, hidden ECS, Godot-like nodes, Tauri) was written down, and the code in `src/` reflects an older design. Context had to be reconstructed from memory.

## Decision

We will record significant design decisions as short-form records in `docs/decisions/`, one decision per file, numbered sequentially, using [0000-template.md](0000-template.md).

- A decision is "significant" if it is hard to reverse, affects more than one module, picks a third-party dependency, or changes the public scripting API.
- Records state context, the decision, alternatives considered, consequences, and what the decision **deprecates**.
- Accepted records are immutable apart from status changes and typo fixes. Changing course means a new record that supersedes (or amends) the old one.
- An accepted record's **open questions** may be marked resolved in place (struck through, with the answer or a link to the record that answers it), as long as the answer refines the decision rather than changing it.
- Proposed records can be edited freely until accepted.
- [docs/README.md](../README.md) keeps the index and current statuses.
- Agents and humans working on the engine read `docs/README.md` before making structural changes.

## Alternatives considered

- **No written decisions; rely on code and commit messages.** This is what happened before and is the reason this record exists.
- **One long design doc.** Easy to start, but hard to see what changed and why, and old reasoning gets silently overwritten.
- **Full-length RFCs.** Too heavy for a one-person project; short records get written, long ones don't.

## Consequences

**Positive**
- Design intent survives breaks and handoffs between sessions.
- Alternatives that were already rejected don't get re-litigated without new information.

**Negative / costs**
- Small overhead per decision.
- Records can drift from code if not updated when decisions are superseded.

## Deprecates

Nothing.

## Open questions

None.

## References

- Michael Nygard, "Documenting Architecture Decisions" (2011), the origin of the ADR format.
