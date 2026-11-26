# 0407. User docs live in the repo, and CI publishes them and a generated API reference to the GitHub wiki

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0001, 0015, 0135

## Context

Myco's user-facing docs are 33 Markdown pages in `docs/guide/` (about 5,000 lines), indexed in the Guides table in `docs/README.md`. The same `docs/` folder holds contributor material: 400+ decision records, plans, RFCs and architecture notes. A user who opens the repo has to find the guide among them.

Other things exist only partly or not at all:

- **API reference:** none. The public surface is `src/myco.ts`, which re-exports `src/engine/index.ts` plus the runtime halves of the first-party plugins (ADR 0135). It already carries TSDoc comments, but nothing turns them into pages.
- **FAQ and update news:** none. `docs/guide/why-no-sound.md` is the only troubleshooting page.
- **Links into the docs:** the editor's Help > Documentation opens `DOCS_URL` (`src/editor/menuBar.ts`), which points at `tree/master/docs/guide`. `README.md` links to two guide pages, and an audio fallback warning in `src/plugins/audio/runtime/core/probe.ts` names `docs/guide/audio-minimum-versions.md`.
- **The wiki:** it's turned on for `doughtnerd/TranquilityEngine` and holds one page (`Home.md`, "Initial Home page"). Its git repo is `TranquilityEngine.wiki.git`.

The owner wants every user-facing doc on the wiki: guides, FAQ, update news and API docs, kept in step with the main repo.

A GitHub wiki is a separate git repository. It has no pull requests, no review and no CI. Its pages are named after their files, folders are ignored when links are resolved, and page names have to be unique across the whole wiki.

## Decision

**The repo is the source and the wiki is a build output.** User docs are written and reviewed in this repo. A GitHub Action rebuilds the wiki from them on every push to `master`. Nobody edits the wiki by hand.

**Source layout: `docs/wiki/`.**
- `docs/guide/` moves to `docs/wiki/guide/` (`git mv`, so history follows). That includes `navigation.md`: the navigation freeze covers code and samples, not docs, and the page's content is updated along with navigation when that work starts.
- New pages:
  - `docs/wiki/Home.md`: what Myco is, getting started, and links to each section.
  - `docs/wiki/FAQ.md`: short questions and answers that link into the guides.
  - `docs/wiki/News.md`: update notes, newest first. Each dated entry names what shipped and links to the guide pages and PRs.
  - `docs/wiki/_Sidebar.md`: the navigation, by section (Getting started, Guides by area, API reference, FAQ, News).
  - `docs/wiki/_Footer.md`: says the wiki is generated from the repo and that edits made on the wiki aren't kept. The build also ends every page (except the sidebar and footer) with a link to its source file in the repo.
- Files keep their kebab-case names in the repo. Each wiki page is named after the file's first `# ` heading (`guide/physics.md` → `Physics`). The build fails if two pages end up with the same name.
- Pages in `docs/wiki/` are written for users. They don't depend on readers following ADR links. Links into contributor docs (`../decisions/…`, `../architecture/…`) become absolute GitHub URLs on `master`.

**Build script: `tools/build-wiki.mjs`, run as `npm run docs:wiki -- --out DIR`.** It writes the complete wiki tree into `DIR`, and CI and local previews run the same script (`--no-api` skips TypeDoc for a quick check). The page naming and link rewriting are a pure module, `tools/wiki-pages.mjs`, tested by `tools/wiki-pages.test.mjs`. TypeDoc's options are in `typedoc.json`. The script does four things:
1. Copies `docs/wiki/` and gives each page its heading name.
2. Rewrites links between pages (`[x](physics.md#joints)` → `[x](Physics#joints)`) and makes links that leave `docs/wiki/` absolute. Images under `docs/wiki/images/` are copied across with their links fixed.
3. Generates the API reference with **TypeDoc** and **`typedoc-plugin-markdown`** (Markdown output), with `src/myco.ts` as the entry point. The pages are prefixed `API-` and an `API-Reference` index page is added. Only what `myco` exports gets documented, so Babylon, three.js and Rapier types never appear (ADR 0010). A symbol without a TSDoc comment still gets a page with its signature.
4. Fails on a link to a page that doesn't exist, or to a heading a page doesn't have, so a broken link fails the PR check instead of reaching the wiki. Page names drop characters that break a wiki link: commas, parentheses, `?` and `:` are removed and dots become spaces (`Bus.loudness` → `Bus loudness`). Links to generated pages are written as bare names (`API-Reference`), which `tools/check-doc-links.mjs` skips under `docs/wiki/`.

**CI: `.github/workflows/wiki.yml`.**
- **On pull requests that touch `docs/wiki/`, `src/myco.ts` or `src/engine/`:** runs `npm run docs:wiki` and fails on build errors or broken links. Nothing is published.
- **On push to `master`:** builds, clones `TranquilityEngine.wiki.git` with the workflow's `GITHUB_TOKEN` (`contents: write`; if that can't push to the wiki, the owner swaps in a repository-scoped token stored as a secret), replaces its contents with the build output, and pushes one commit named after the source commit (`Sync from <sha>`). Nothing is pushed if nothing changed.
- **Protection against hand edits:** before pushing, the job checks that the wiki's latest commit is one of its own sync commits. If someone edited the wiki on the web since the last sync, the job fails and names those commits instead of overwriting them. The owner then moves the edits into `docs/wiki/` (or discards them) and re-runs the job.

**Links into the docs move to the wiki.**
- `DOCS_URL` in `src/editor/menuBar.ts` becomes `https://github.com/doughtnerd/TranquilityEngine/wiki`.
- The guide links in `README.md` point at wiki pages.
- The probe warning names the wiki page.
- The Guides table in `docs/README.md` becomes one line pointing at `docs/wiki/` and the wiki. Everything else in `docs/` stays where it is.

**What stays out of the wiki:** decision records, plans, RFCs, architecture notes, implementation status and `GLOSSARY.md`. They're contributor docs that change with the code. The wiki links to them on GitHub but doesn't copy them.

## Alternatives considered

- **Wiki repo as a git submodule at `wiki/`.** Each docs change takes two commits and two pushes, and PRs show only a submodule pointer instead of the doc diff. Worktrees and parallel agents also handle submodules badly, and this project uses both heavily.
- **Wiki as the only source, edited on the web.** No setup, but docs aren't reviewed with the code that changes them, nothing catches broken links or stale pages, and the API reference would be hand-maintained.
- **A docs site (VitePress, Docusaurus) on GitHub Pages instead of the wiki.** Better search, theming and versioning, but it's another site to host and style, and the owner asked for the wiki. The `docs/wiki/` source and the TypeDoc step would carry over if we ever switch.
- **API Extractor + API Documenter instead of TypeDoc.** It's built for API review (`.api.md` reports) and needs a `.d.ts` rollup first. TypeDoc reads the TypeScript source directly and its Markdown plugin is maintained, which is all we need.
- **`typedoc-github-wiki-theme`.** A preset for the same plugin that writes wiki-style links and a sidebar. It's worth trying in the build, but our script rewrites links and owns `_Sidebar.md` anyway, so the plain Markdown plugin plus our own index page is enough to start.

## Consequences

**Positive**
- Docs change in the same PR as the code, and reviewers see both.
- Broken links and API reference build failures fail CI instead of reaching readers.
- Users get a wiki with only user docs. Contributor docs stay in `docs/`.
- The API reference regenerates on every push to `master`, so it can't fall behind the exports.

**Negative / costs**
- Two new dev dependencies: `typedoc` and `typedoc-plugin-markdown`. They have to track the project's TypeScript version.
- The wiki can't be edited on the web in practice. The job refuses to overwrite hand edits, but someone has to move them into the repo.
- The wiki shows `master` only, with no docs per version. That's fine while the engine has no tagged releases.
- Moving `docs/guide/` changes the paths that other ADRs, plans and open branches link to. Those links need a one-time rewrite, and branches made before the move need a rebase.
- The quality of the API reference depends on the TSDoc comments. Undocumented exports show up as bare signatures until someone writes their comments.

## Deprecates

- `docs/guide/` as a location. Its pages move to `docs/wiki/guide/`. Links to the old paths elsewhere in `docs/` are rewritten in the same change.
- `DOCS_URL`'s `tree/master/docs/guide` target, which is replaced by the wiki URL.
- The wiki's current `Home.md`, which is replaced by `docs/wiki/Home.md` on the first sync.

## Open questions

- **News:** hand-written now. It could be built from a changelog or from release notes once there are tagged releases.
- **Opening a page from the editor:** whether Help menu items and panel help buttons should open the relevant page (`…/wiki/Physics`) instead of the wiki home. That's left for a follow-up.

## References

- `docs/guide/`, `docs/README.md` (Guides table), `src/myco.ts`, `src/engine/index.ts`
- `src/editor/menuBar.ts` (`DOCS_URL`), `src/plugins/audio/runtime/core/probe.ts`, `README.md`
- GitHub docs: "About wikis", "Adding or editing wiki pages" (cloning `<repo>.wiki.git`)
- TypeDoc (typedoc.org), `typedoc-plugin-markdown` (typedoc-plugin-markdown.org)
