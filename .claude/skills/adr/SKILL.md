---
name: adr
description: Write, update and act on Myco Engine's architecture decision records (docs/decisions/NNNN-*.md, short-form RFC/ADR) - proposing a design before building it, recording alternatives, accepting, amending or superseding records, and keeping the decisions index and implementation status in step. Use whenever the user asks for an ADR, a design doc, a proposal, "write up the decision", "ADR first", "discuss first", asks you to design a feature or architectural change before building it, approves or accepts ADRs ("Accept, start building"), or a change contradicts or extends an existing decision.
---

# Decision records in Myco Engine

Myco (repo folder `tranquility_engine`) records every design decision as a short-form RFC/ADR. The user reviews
designs as records before code is written, approves them ("Accept", "I approve of the ADRs"), and then expects the
build to follow the record. Records are how future sessions learn why things are the way they are, so they must stay
true: when the build changes a decision, the record changes too.

## Where things live

- `docs/decisions/NNNN-kebab-title.md`, one decision per file; `0000-template.md` is the template.
- `docs/README.md` has the **Decision records** table: `| [NNNN](decisions/NNNN-....md) | Summary | Status |`.
- `docs/architecture/implementation-status.md` has a row per record once something is built: what's done, where the
  code is, what tests cover it, and what isn't verified.
- `docs/architecture/open-questions.md` holds open questions that outlive a record.
- `CLAUDE.md` names key records (e.g. "three.js never appears in the public API (ADR 0010)"); respect them.

## Writing a new record

1. **Research first.** Before proposing, look for existing, maintained libraries and tools that already do the job
   (the user dislikes reinventing the wheel, and also dislikes extra UI frameworks: one UI library, Preact, with
   xyflow for graphs). Read the related records (`grep -l` the topic in `docs/decisions/`) so the new one fits them.
   When the user asks questions before agreeing (value, cost, trade-offs, better alternatives), answer them in chat
   first; that's "discuss first".
2. **Number:** one past the highest existing record (`ls docs/decisions | tail -1`). Never reuse a number.
3. **Copy the template** and fill every section:
   - **Title:** the decision itself, as a statement ("The desktop editor opens on a Projects window while the editor
     loads hidden"), with `# NNNN. ` before it.
   - **Header:** Status `Proposed`, today's date, Deciders `Chris Carlson`, Supersedes (`—` or a number), Related
     (the numbers it builds on).
   - **Context:** the problem and what exists today, factually, with measurements where there are any (start-up
     times, bundle sizes).
   - **Decision:** what we will do, plainly, with the concrete rules, file names and interfaces that follow. Bold
     lead-ins for each part.
   - **Alternatives considered:** each with what it is and why not, in a line or two.
   - **Consequences:** Positive and Negative / costs, honest about both.
   - **Deprecates:** what it retires and what happens to it, or "Nothing".
   - **Open questions** and **References** (files, docs, benchmarks).
4. **Add the row** to the table in `docs/README.md` with status `Proposed`.
5. **Present it** in a few lines (the decision, the main alternative and why not, the cost) and ask for approval.
   Don't build before the user accepts, unless they said to go ahead.

## When the user accepts

- Set **Status: Accepted** in the record and in the README table.
- Build to the record. If building shows the record was wrong or incomplete, update the record (and say so) rather
  than letting code and record drift.
- When something is built, add or update its row in `implementation-status.md`: Done / Partly done, the files, the
  tests, and what isn't covered by an automated test.

## Changing an earlier decision

- **Amended:** the old record stays in force, partly changed. Its status becomes `Accepted, amended by NNNN (what
  changed)`, and the new record lists it under Related.
- **Superseded:** the new record replaces the old one. Old status: `Superseded by NNNN`; new header: `Supersedes:
  NNNN`. Partial replacement: `Accepted; partly superseded by NNNN (what)`.
- Update both rows in the README table.

## Style

Short and specific: a record is read in a couple of minutes. Measured facts over adjectives; file paths in backticks;
bullets with bold lead-ins; no marketing. Explain terms the user asked about (they asked "why can't subgraphs output
textures?", "what are shader keywords or variants?") in the record when they bear on the decision.

## Plans built from records

Big records are often built in waves of parallel tasks with a review after each ("Start wave N", "Review wave N
first"). See the `coordinate-subagents` skill for running those; the plan document should name the record it builds.
