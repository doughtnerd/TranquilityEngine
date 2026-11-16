# 0219. Storybook is the editor's component library, and stories test its components through their real props

- **Status:** Accepted
- **Date:** 2026-11-16
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0015, 0025, 0171, 0172, 0173

## Context

The editor's UI is Preact components (ADR 0025). Their unit tests run under Node with no DOM, so a component that uses
hooks can't go through Preact's own `render`. `src/editor/testRender.ts` fills the gap: a test mocks `preact/hooks` with it,
it expands the tree itself and hands back host elements with their props, and the test calls handlers such as `onClick`
or `onKeyDown` with hand-made event objects. Seven audio editor test files render this way (the ducking section, the Mixer
panel, the Profiler panel, bar and tables, opening a capture). It works, but what it checks is a stand-in: no layout, no
real events, no focus, no scrolling, no CSS, and a second implementation of Preact's hooks that has to keep up with the
real one. A handler can pass with an event object no browser would send.

There is also no place to look at one component in each of its states (empty, typical, error, many rows) without opening
the whole editor and building that state by hand, and no shared view of the components a plugin's editor half can reuse.

The owner approved Storybook as the editor's UI component library and as the way to test editor components by running
their stories. Its packages are dev dependencies: `storybook`, `@storybook/preact-vite`, `@storybook/addon-vitest`,
`@vitest/browser` and `@vitest/browser-playwright`.

## Decision

We will use Storybook as the editor's component library, and a component's stories as its tests, run in a real browser.

- **Where stories live.** Beside their component, as `<Component>.stories.tsx` (`MixerPanel.tsx` and
  `MixerPanel.stories.tsx`). Storybook collects `src/**/*.stories.tsx`. A lower-case module keeps its own name
  (`profilerTables.stories.tsx`), so `npm run check:filenames` never sees two names that differ only in case.
- **Stories use the public interface.** A story renders the real exported component with its real props, or, for a
  registered panel, the panel as the shell renders it. It feeds data through the same real deps and spies the headless
  tests use (an in-memory project through `MemoryFileSystem` and `openFolderProject`, a real `ProfilerController`, the
  real capture Worker, `spyOn` on the play mixer's public surface). A small harness in the story file may hold state the
  way the component's real owner does (the Project Settings panel's draft). No export, prop, hook or flag is added to a
  component for its stories: CLAUDE.md's testing rule applies to stories as it does to tests.
- **A play function asserts.** Each story's `play` uses `storybook/test` (`expect`, `userEvent`, `fireEvent`, `within`,
  `waitFor`, `fn`, `spyOn`) and drives the component the way a user does: clicks, typing in a filter, keys, a pointer drag
  on a fader, a file dropped on the panel, scrolling a list.
- **The theme decorator.** `.storybook/preview.tsx` installs the editor theme with `installTheme` (`src/editor/theme.ts`),
  the same call the editor's boot makes, imports `src/editor/ui/editor.css`, and wraps every story in a panel-coloured
  frame. A toolbar switch picks one of the built-in presets (`PRESETS`) by setting the editor's own `themePreset`, so a
  story looks exactly as it does for a user who chose that theme.
- **One set of Vite settings.** `componentViteConfig()` in `vite.shared.ts` holds the editor's settings for rendering its
  components outside the editor page: `typescriptTranspile()` with `oxc: false` (standard decorators, Preact JSX),
  ES-module workers with the same transpile, `engineTypes()`, the `"myco"` alias (`MYCO_ALIASES`, which
  `vitest.config.mts` uses too) and Preact's JSX runtime pre-bundled. Storybook builds from `.storybook/vite.config.ts`,
  which is that config, instead of the dev server's `vite.config.ts` (which also serves the samples and the player).
- **How story tests run.** `vitest.stories.config.mts` is a separate Vitest config: the same settings plus the
  `storybookTest` plugin, in browser mode with the Playwright provider and headless Chromium. Every story is a test.
  `npm test` keeps its own config, runs under Node, includes only `src/**/*.test.ts`, and never collects a story.
- **Scripts.** `npm run storybook` (the dev server on :6006), `npm run build:storybook` (a static build in
  `dist/storybook/`) and `npm run test:stories` (the story tests). `npm run typecheck` covers the stories (they are under
  `src/`) and `.storybook/` (`preview.tsx` in `tsconfig.json`; `main.ts` and `vite.config.ts` in `tsconfig.node.json`).

## Alternatives considered

- **Keep `testRender.ts` and extend it.** No new dependency, but it stays a second hooks implementation with no layout,
  no real events and no focus; every new hook or Preact change has to be mirrored in it. Not chosen.
- **A DOM library under Node (jsdom or happy-dom) with Preact's own `render`.** Real hooks and a DOM, but no layout, no
  scrolling and no real CSS, so the windowed tables and the fader drag still test a simulation; and it gives no component
  library to look at. Not chosen.
- **Playwright specs against the whole editor.** Real, but slow, and a component's states (a 33rd ducking rule, a capture
  of another wire) take a long setup through the editor UI. They stay the tool for whole-editor flows (tests/e2e/).

## Consequences

**Positive**
- Editor components are tested in a real browser, through real events, focus, layout and CSS, with the real hooks.
- Each component's states can be looked at in isolation, in each built-in theme, and the stories document how the
  component is used.
- One place to build a plugin editor half's components against before they are wired into a panel.

**Negative / costs**
- Story tests need Chromium (`npm run test:e2e:install` installs it); they run in `npm run test:stories`, not `npm test`.
- Five dev dependencies, and a Storybook build that takes about a minute.
- A story that depends on module state (the profiler's slots, the Mixer host) restores it in its `beforeEach` cleanup.

## Deprecates

`src/editor/testRender.ts`, and the `vi.mock("preact/hooks", ...)` pattern with it. The seven test files that render
through it (`audioSettingsSection.ducking.test.ts`, `mix/mixerPanelView.test.ts`, `mix/mixerSettings.test.ts`,
`mix/ProfilerBar.test.ts`, `mix/ProfilerPanel.test.ts`, `mix/openCapture.test.ts`, `mix/profilerTables.test.ts`) have
stories that assert the same behaviour. Their rendering cases, and `testRender.ts`, are removed once the story tests have
run green; until then both run, so coverage keeps running headless. Their cases that render nothing (models, the
controller, the op log, colour-literal checks) stay unit tests.

## Open questions

- Whether the story tests join CI beside `npm test`, and on which browsers (WebKit as well as Chromium).
- Stories for the rest of the editor's components, which have no testRender tests today.

## References

- `src/editor/testRender.ts`; `.storybook/`; `vitest.stories.config.mts`; `vite.shared.ts` (`componentViteConfig`).
- Storybook 10 and its Vitest addon: https://storybook.js.org/docs/writing-tests/integrations/vitest-addon
