# Audio core: minimum browser and webview versions (ADR 0157)

The audio core (`audio.backend: "core"`, the default) runs in an `AudioWorklet` and uses WebAssembly SIMD. Before it loads, the engine probes for the features it needs (never version strings). An engine that lacks one logs **one warning** naming the missing feature and these minimums, then plays sound through the `"babylon"` backend instead: basic playback, no effects (the other limits are listed in [audio-mixer.md](audio-mixer.md#limits)).

The core also needs a `Worker` and WebAssembly: clips decode on a worker running the engine's own decoder (`myco_audio_decode.wasm`), never with the browser's `decodeAudioData`. If that worker crashes, the engine restarts it and retries the decodes in flight (up to 3 times a minute). If it can't run at all, or its wasm doesn't match the engine build, clips fail to load with one warning each. Once the core has started it does not switch to the browser's decoder; only the choice made at load, the Babylon fallback above, uses the browser to decode.

## What the core needs

| Feature | Chrome / Edge | Firefox | Safari | Android System WebView |
|---|---|---|---|---|
| `AudioWorklet` | 66 (Edge 79) | 76 | 14.1 | 66 |
| WebAssembly `simd128` (the binding limit) | 91 | 89 | 16.4 | 91 |
| `AudioContext.getOutputTimestamp` | 57 (Edge 79) | 70 | 14.1 | 57 |
| Transferable `ArrayBuffer` (`MessageChannel`) | long supported | 41 | 5 | 4.4 |

**Effective minimums: Chrome and Edge 91, Firefox 89, Safari 16.4, Android System WebView 91.** Source: [MDN browser-compat-data 8.1.8](https://github.com/mdn/browser-compat-data) (`api.AudioWorklet`, `api.AudioContext.getOutputTimestamp`, `webassembly.fixed-width-SIMD`); the engine's own probe is `src/plugins/audio/runtime/core/probe.ts`.

Desktop shells: WebView2 is evergreen and follows Edge, so it passes. WKWebView (macOS) follows the system Safari, so it needs macOS with Safari 16.4 or later. WebKitGTK needs the release matching Safari 16.4 or later (likely 2.40; A0.7 confirms on a real build).

## Checks run for A0.6 (2026-11-09)

**Suspended-context `audioWorklet.addModule`.** ADR 0157 loads the core into a suspended context so the first gesture only calls `resume()`. Run with Playwright 1.64.1 (WebKit "Version/27.2" build, Firefox 157.0, Chromium 156) in the Playwright Linux container (`mcr.microsoft.com/playwright:v1.64.1-noble`), because Playwright's Windows WebKit has no Web Audio and its Windows Firefox won't launch here:

| Engine | Context after `new AudioContext()` | `addModule` while suspended | `new AudioWorkletNode` | SIMD validate | `getOutputTimestamp` |
|---|---|---|---|---|---|
| WebKit | `suspended` | resolves | works | true | present |
| Firefox | `suspended` | resolves | works | true | present |
| Chromium | `running` (headless allows autoplay) | resolves | works | true | present |

So **no fallback to creating the context inside the gesture is needed** for these engines. Caveat: these are Playwright's builds, not a shipped Safari or WebKitGTK, and no audio device was present, so this proves loading, not sound. Real Safari and WebKitGTK are covered by A0.7 and the soak.

**Android System WebView.** MDN browser-compat-data lists `webview_android` at 66 for `AudioWorklet`/`AudioWorkletNode`, 57 for `getOutputTimestamp` and 91 for fixed-width SIMD, the same as Chrome. WebView is a Chromium build that updates through Google Play, so on a device with updates the WebView version, not the Android version, decides:
- Chrome and WebView stopped shipping to Android 7 after 119 ([Chrome 120 raises the floor to Android 8](https://www.ghacks.net/?p=203825)) and to Android 8 and 9 after 138; Chrome 139 and later need Android 10 ([notice](https://groups.google.com/a/chromium.org/g/chromium-dev/c/vEZz0721rUY), [coverage](https://heise.de/-10457380)). Every one of those last versions is well above 91, so **any updated WebView on a device Tauri supports has both features**.
- Tauri 2's minimum is Android 7.0 (API 24) ([Tauri docs](https://v2.tauri.app/distribute/google-play/)); Google Play's target-API rule (Android 16, API 36, from 2026-08-31, [Play Console help](https://support.google.com/googleplay/android-developer/answer/11926878)) sets no minimum OS. Google Play does not set a floor on the OS version a phone runs, so the soak phone's WebView version, not its Android version, is what to read.
- The risk is a device whose WebView was never updated (no Play services, updates disabled): its WebView is whatever the system image shipped, which on Android 7 and 8 can be below 91. Those get the warning and the Babylon fallback. When picking the soak phone, record its WebView version from `chrome://version` or the Play listing.

Not verified here: the exact WebView version of any particular phone, and Google's own WebView release notes did not list a stable minimum OS (third-party APK listings show current WebView builds requiring Android 10).
