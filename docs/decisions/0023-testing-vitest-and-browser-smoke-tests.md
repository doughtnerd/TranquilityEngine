# 0023. Testing: Vitest on the headless core, browser smoke tests

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0003, 0011, 0015

## Context

The legacy repo has no tests. The new architecture keeps core free of three.js, DOM and Tauri imports, and the loop can be stepped by hand (`engine.step(dt)`, 0011), so most engine behavior can be tested headless. The three.js, audio and WebKit-specific behavior still needs a real browser.

## Decision

- **Vitest** for unit and integration tests of the headless core: World/storage, lifecycle order, deferred structural changes, scene loading and serialization round-trips, prefab overrides, the physics interface (Rapier runs in Node), waits (0018).
- **Playwright** smoke tests that boot a demo in a real browser, run a few hundred frames, and check for errors and rough visual output. They run on **Chromium and WebKit**; WebKit approximates the macOS and Linux Tauri webviews.
- Tests run in GitHub Actions on every push.
- Vitest fits the Vite toolchain (0015) and shares its config.

## Alternatives considered

- **Vitest only.** Misses webview and rendering issues.
- **Defer tests.** The core rewrite is exactly when tests pay off most.
- **Jest.** Works, but duplicates transform config that Vitest gets from Vite.

## Consequences

**Positive**
- Lifecycle and serialization rules from the decision records become executable checks.
- Early warning for WebKit-specific breakage.

**Negative / costs**
- Browser tests are slower and can be flaky; keep them few.

## Deprecates

- Nothing.

## Open questions

- Whether to add golden-image screenshot comparisons, and how tolerant they should be.

## References

- https://vitest.dev/
- https://playwright.dev/
