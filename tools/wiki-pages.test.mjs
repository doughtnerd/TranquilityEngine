// Tests for tools/wiki-pages.mjs (ADR 0407). Run: node --test tools/wiki-pages.test.mjs
// (Vitest's include is src/**, so a tool test uses node:test, as tools/music-tempo.test.mjs does.)
import test from "node:test";
import assert from "node:assert/strict";
import { apiPageName, headingAnchors, pageName, pageSlug, planWiki, rewriteLinks } from "./wiki-pages.mjs";

const REPO = "https://github.com/o/r";
const repoFiles = { "docs/decisions/0001-x.md": "file", "src/engine": "dir", "README.md": "file" };
const exists = (p) => repoFiles[p] ?? null;
const plan = (files, opts = {}) => planWiki({ sources: new Map(Object.entries(files)), repoUrl: REPO, exists, ...opts });

test("pages are named after their first heading, cleaned for the wiki", () => {
  assert.equal(pageName("docs/wiki/guide/physics.md", "# Physics\n"), "Physics");
  assert.equal(pageName("x/a.md", "# Loudness, targets and `Bus.loudness` (ADR 0171, amended by 0172)"), "Loudness targets and Bus loudness");
  assert.equal(pageName("x/a.md", "# Why is there no sound?"), "Why is there no sound");
  assert.equal(pageName("x/a.md", "# Sound events (replaced by playlists)"), "Sound events replaced by playlists");
  assert.equal(pageName("x/a.md", "```\n# not a heading\n```\n# Real"), "Real");
  assert.equal(pageName("x/a.md", "no heading"), null);
  assert.equal(pageName("docs/wiki/_Sidebar.md", "**nav**"), "_Sidebar");
  assert.equal(pageName("docs/wiki/Home.md", "# Welcome"), "Home");
  assert.equal(pageSlug("The debug link connecting tools"), "The-debug-link-connecting-tools");
});

test("API pages are named by kind", () => {
  assert.equal(apiPageName("README.md"), "API-Reference");
  assert.equal(apiPageName("classes/Animator.md"), "API-Class-Animator");
  assert.equal(apiPageName("type-aliases/Vec3.md"), "API-Type-Vec3");
  assert.equal(apiPageName("functions/defineRpc.md"), "API-Function-defineRpc");
});

test("heading anchors follow GitHub's rules, numbering repeats", () => {
  const a = headingAnchors("# Joints\n## Ball joints: limits\n## Joints\n```\n# Skip\n```\n### `Bus.gain`");
  assert.deepEqual([...a], ["joints", "ball-joints-limits", "joints-1", "busgain"]);
});

test("links in code fences and inline code are left alone", () => {
  const md = "[a](x.md) `[b](y.md)`\n```\n[c](z.md)\n```\n[d]: w.md";
  assert.equal(rewriteLinks(md, (t) => `<${t}>`), "[a](<x.md>) `[b](y.md)`\n```\n[c](z.md)\n```\n[d]: <w.md>");
});

test("links between pages become wiki page names, with anchors kept and checked", () => {
  const { pages, problems } = plan({
    "docs/wiki/Home.md": "# Home\nSee [physics](guide/physics.md#joints) and [faq](FAQ.md).",
    "docs/wiki/FAQ.md": "# FAQ\n[home](Home.md)",
    "docs/wiki/guide/physics.md": "# Physics\n## Joints\n[top](#physics) [sound](why.md)",
    "docs/wiki/guide/why.md": "# Why is there no sound?",
  });
  assert.deepEqual(problems, []);
  assert.match(pages.get("Home.md"), /\[physics\]\(Physics#joints\) and \[faq\]\(FAQ\)/);
  assert.match(pages.get("Physics.md"), /\[top\]\(#physics\) \[sound\]\(Why-is-there-no-sound\)/);
  assert.deepEqual([...pages.keys()].sort(), ["FAQ.md", "Home.md", "Physics.md", "Why-is-there-no-sound.md"]);
});

test("links that leave docs/wiki become GitHub URLs; files and folders are told apart", () => {
  const { pages, problems } = plan({
    "docs/wiki/guide/a.md": "# A\n[adr](../../decisions/0001-x.md#context) [code](../../../src/engine) [readme](../../../README.md)",
  });
  assert.deepEqual(problems, []);
  const a = pages.get("A.md");
  assert.match(a, /\(https:\/\/github\.com\/o\/r\/blob\/master\/docs\/decisions\/0001-x\.md#context\)/);
  assert.match(a, /\(https:\/\/github\.com\/o\/r\/tree\/master\/src\/engine\)/);
  assert.match(a, /\(https:\/\/github\.com\/o\/r\/blob\/master\/README\.md\)/);
});

test("each page ends with a link to its source, except the sidebar and footer", () => {
  const { pages } = plan({ "docs/wiki/guide/a.md": "# A\n", "docs/wiki/_Sidebar.md": "[A](guide/a.md)", "docs/wiki/_Footer.md": "f" });
  assert.match(pages.get("A.md"), /\[Source of this page\]\(https:\/\/github\.com\/o\/r\/blob\/master\/docs\/wiki\/guide\/a\.md\)\n$/);
  assert.equal(pages.get("_Sidebar.md"), "[A](A)");
  assert.equal(pages.get("_Footer.md"), "f");
});

test("broken links, missing anchors, missing headings and clashing names are problems", () => {
  const { problems } = plan({
    "docs/wiki/a.md": "# Same\n[x](missing.md) [y](b.md#nope) [z](#gone) [w](../decisions/none.md)",
    "docs/wiki/b.md": "# Same",
    "docs/wiki/c.md": "no heading",
  });
  assert.equal(problems.length, 6, problems.join("\n"));
  assert.ok(problems.some((p) => p.includes("missing.md (no such file)")));
  assert.ok(problems.some((p) => p.includes('no heading "#nope"')));
  assert.ok(problems.some((p) => p.includes('no heading "#gone" on this page')));
  assert.ok(problems.some((p) => p.includes("none.md (no such file)")));
  assert.ok(problems.some((p) => p.includes('"Same" is also used by')));
  assert.ok(problems.some((p) => p.includes('c.md: no "# " heading')));
});

test("API pages are flattened, their links rewritten, and the index retitled", () => {
  const api = new Map([
    ["README.md", "# myco\n\n## Classes\n\n- [Animator](classes/Animator.md)"],
    ["classes/Animator.md", "# Class: Animator\n[`Component`](Component.md#constructor) [mode](../type-aliases/Mode.md) [src](https://github.com/o/r/blob/master/src/a.ts#L1)"],
    ["classes/Component.md", "# Class: Component"],
    ["type-aliases/Mode.md", "# Type: Mode\n[gone](../classes/Gone.md)"],
  ]);
  const { pages, problems } = plan({ "docs/wiki/Home.md": "# Home\n[API](API-Reference)" }, { api });
  assert.deepEqual(problems, ["API type-aliases/Mode.md:2: ../classes/Gone.md (no such API page)"]);
  assert.match(pages.get("API-Reference.md"), /^# API reference\n/);
  assert.match(pages.get("API-Reference.md"), /\[Animator\]\(API-Class-Animator\)/);
  assert.match(pages.get("API-Class-Animator.md"), /\(API-Class-Component#constructor\) \[mode\]\(API-Type-Mode\) \[src\]\(https:/);
  assert.match(pages.get("Home.md"), /\[API\]\(API-Reference\)/);
});

test("a link to an API page is a problem unless the API was built or deliberately left out", () => {
  const files = { "docs/wiki/Home.md": "# Home\n[API](API-Reference)" };
  assert.equal(plan(files).problems.length, 1);
  assert.deepEqual(plan(files, { apiOmitted: true }).problems, []);
});

test("other files in docs/wiki are copied and linked by their raw wiki URL", () => {
  const { pages, copies, problems } = plan({ "docs/wiki/guide/a.md": "# A\n![shot](../images/s.png)", "docs/wiki/images/s.png": "" });
  assert.deepEqual(problems, []);
  assert.deepEqual([...copies], [["images/s.png", "docs/wiki/images/s.png"]]);
  assert.match(pages.get("A.md"), /!\[shot\]\(https:\/\/raw\.githubusercontent\.com\/wiki\/o\/r\/images\/s\.png\)/);
});
