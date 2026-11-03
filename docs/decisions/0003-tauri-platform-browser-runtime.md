# 0003. Tauri platform, browser runtime

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0004, 0005

## Context

The engine runs on web technology (WebGL, Web Audio, WASM). Games need to ship as installable desktop apps with file access for saves and settings. The two common wrappers are Electron (bundles Chromium) and Tauri (Rust host using the operating system's own webview).

Tauri's webview differs per OS:

| OS | Webview | Engine |
| --- | --- | --- |
| Windows | WebView2 | Chromium |
| macOS | WKWebView | WebKit (Safari) |
| Linux | WebKitGTK | WebKit |

So "the browser" the engine runs in is not one browser. WebGL2, Web Audio and WASM work on all three. Newer features (WebGPU, some WASM extensions) vary, and WebKitGTK usually lags behind.

## Decision

- Games ship through **Tauri** (v2).
- The engine targets a **browser runtime**: everything runs in the webview's JavaScript. Rust-side code is limited to platform services (files, windowing, maybe Steam integration later), never game logic.
- Core never imports Tauri APIs. Platform access goes through a **platform adapter** interface with two implementations:
  - `browser`: dev server and web demos (saves go to IndexedDB or are disabled).
  - `tauri`: file system, window control, app paths.
- The **baseline** is WebGL2 + Web Audio + WASM (with SIMD where available, plus a fallback build). WebGPU is an optional enhancement only (see 0004).
- CI and manual testing include Linux/WebKitGTK early, since it is the most likely to break.

## Alternatives considered

- **Electron.** Same Chromium everywhere means fewer surprises, but much bigger app downloads and higher memory use. Rejected for size; the per-OS differences are handled by the conservative baseline instead.
- **Browser-only (itch.io / web).** Still supported through the browser adapter, but not the primary target because desktop features (files, fullscreen, Steam) are needed.
- **Native engine port.** Out of scope; contradicts the web-tech approach.

## Consequences

**Positive**
- Small installers, low memory overhead.
- The same build runs in a plain browser for development.

**Negative / costs**
- Three rendering engines to test against.
- WebGPU and the newest browser features can't be relied on.
- A webview may throttle `requestAnimationFrame` when the window is hidden or minimized; the frame loop must handle long gaps (see 0011).

## Deprecates

- Direct DOM setup in `src/index.ts` (creating the canvas and appending it to `document.body`) moves behind the platform adapter / engine bootstrap.

## Open questions

- ~~Where saves and settings live.~~ Resolved by [0024](0024-storage-via-platform-adapter.md).
- ~~Tauri asset protocol vs bundling.~~ Resolved for v1: assets are bundled by Vite and referenced by path ([0013](0013-data-driven-scene-format.md), [0015](0015-vite-build-tooling.md)).

## References

- https://v2.tauri.app/
