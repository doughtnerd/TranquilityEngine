# 0155. Games export to Android through Tauri 2's mobile support, as the web build in a generated Tauri project

- **Status:** Proposed
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0003, 0024, 0041, 0050, 0055, 0075, 0081, the audio-core record (numbered 0149 on branch `claude/fmod-integration-d19dbb`, "Audio runs on an engine-owned Rust core in an AudioWorklet"; its number collides with master's 0149 and will change when it merges)

## Context

On 2026-11-09 the owner fixed the platform targets: the editor runs on desktop (Windows, macOS, Linux) and in the browser; **published games run on the web, desktop and Android**, and Android through Tauri is one reason Tauri was chosen (0003). 0041 builds games as a prebuilt web player plus the project's files (`--target web`) and wraps that folder in a generated Tauri v2 project for desktop (`--target desktop`, `src/export/desktop.ts`). It lists mobile targets as an open question.

What exists that Android can reuse:

- The generated Rust shell already has `#[cfg_attr(mobile, tauri::mobile_entry_point)]` on `run()` and only `tauri` + `tauri-plugin-fs`, both of which support Android. Saves go through `TauriStorage` in the app data folder (0024), which the fs plugin maps to the app's private storage on Android.
- Input is pointer events on the canvas (`src/engine/input/Input.ts`): one pointer, button 0 for mouse or touch. There is no multi-touch API.
- `detectPlatform()` (`src/engine/core/graphics.ts`) returns `"desktop"` whenever Tauri's marker is present, before looking at the user agent, so a Tauri app on Android would get desktop quality defaults (0050).
- Rendering is Babylon on `WebGPUEngine`, with WebGL2 kept as a fallback that "isn't a target" (0075).
- The audio-core record needs AudioWorklet, WebAssembly `simd128`, transferable buffers and `getOutputTimestamp`; where they're missing it switches to the Babylon fallback backend. Its soak gate names one low-end device: an Android phone on the lowest Android version Google Play accepts for publishing, in Chrome and the Android System WebView.

What the research found (checked 2026-11-09; sources under References):

- **Tauri 2 mobile.** `tauri android init` generates an Android Studio/Gradle project in `src-tauri/gen/android/`; `tauri android build` builds it (`--aab` for Play, `--apk` for sideloading and testing, `--target aarch64|armv7|i686|x86_64`, `--split-per-abi`, `--debug`). The universal AAB lands in `gen/android/app/build/outputs/bundle/universalRelease/`. The frontend (`frontendDist`) is embedded in the Rust library, as on desktop, so each ABI's `.so` carries its own copy of the game.
- **Toolchain.** Android SDK (Platform, Platform-Tools, Build-Tools, Command-line Tools), the NDK, a JDK (`JAVA_HOME`, usually Android Studio's bundled JBR), `ANDROID_HOME` and `NDK_HOME`, and the rustup targets `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`, `x86_64-linux-android`.
- **Minimum SDK.** Tauri supports Android 7.0 (API 24) and up; `bundle.android.minSdkVersion` raises it. Version codes come from `version` (major×1,000,000 + minor×1,000 + patch) unless `bundle.android.versionCode` is set.
- **Signing.** Release builds are signed by a keystore that `keystore.properties` in `gen/android/` names, read by a `signingConfigs.release` block the user adds to `gen/android/app/build.gradle.kts`. Tauri doesn't automate this or Play uploads. On Play, this key is the *upload key*; Play App Signing holds the app signing key.
- **Google Play.** New apps must be AABs. New apps and updates must **target** Android 16 (API 36) since 2026-08-31. Native libraries in apps targeting Android 15+ must support **16 KB memory pages** (enforced for updates since 2026-05 according to secondary sources; NDK r28+ aligns by default). The first upload is manual in the Play Console. **Play sets no floor on `minSdkVersion`**: the lowest version an app can support is the developer's choice, so for us it's Tauri's floor, API 24.
- **The WebView's update model.** The WebView is updatable from Play, not frozen with the OS: on Android 7–9 Chrome supplies it, on Android 10+ the Android System WebView app does. But Chrome stops shipping to old Android: **Chrome 119 was the last for Android 7.x** and **Chrome 138 the last for 8–9** (Chrome 139 requires Android 10, API 29). So the WebView on an Android 7 phone is at most Chromium 119, on 8–9 at most 138, and only Android 10+ keeps getting updates (and security fixes).
- **Feature availability.** WebGL2, AudioWorklet (Chromium 66) and `simd128` (Chromium 91) are all inside Chromium 119, so Android 7's last WebView has what the audio core needs. **WebGPU** on Android shipped in Chrome 121 only for Android 12+ with Qualcomm or ARM GPUs; whether the WebView exposes it is not confirmed by a primary source. A low-end Android phone will run Babylon's WebGL2 engine.
- **Secure context.** Tauri on Android serves the app from `http://tauri.localhost` by default; `app.windows[].useHttpsScheme` (Tauri 2.1+) serves `https://tauri.localhost`. AudioWorklet requires a secure context.

## Decision

We will add **`--target android`** to the exporter. It writes the same web build and the same generated Tauri project as `--target desktop`, adds the Android settings to it, runs `tauri android init` once, patches a few marked, exporter-owned blocks in the generated Gradle project, and builds an AAB or APK when the toolchain is present. The game runs in the Android System WebView unchanged; runtime differences are detected features, not a separate player.

### The command

```
npm run export -- <projectDir> --target android
    [--out DIR]                 default <projectDir>/dist/android
    [--format aab|apk]          default aab (Play); apk for sideloading and the emulator
    [--debug]                   a debug-signed APK, no keystore needed (implies --format apk)
    [--abis LIST]               default aarch64,armv7; x86_64 for the emulator
    [--keystore PATH]           release signing (see Signing)
    [--build|--no-build]        as for desktop
    [--scene PATH]
```

- `--format aab` without `--debug` is a release build and needs a keystore; without one the export writes the project, builds nothing, and says why.
- The editor's **Build / Export** dialog gains an **Android** target that, like desktop, writes the project through the platform `FileSystem` and shows the CLI command for the build (the editor runs no toolchain).

### What the export writes

```
<out>/web/                       the web build (0041), unchanged
<out>/src-tauri/                 the generated Tauri project (desktop.ts), shared with desktop:
    tauri.conf.json              + bundle.android { minSdkVersion, versionCode }, + app.windows[0].useHttpsScheme
    Cargo.toml  src/  build.rs   unchanged; capabilities/default.json unchanged (fs in app data only)
    gen/android/                 `tauri android init` output, created once and kept across re-exports
                                 (like target/), with exporter-owned blocks patched in place
<out>/README.txt                 the commands, the toolchain list, signing and Play notes
```

- **Shared generator.** `desktopProjectFiles` becomes `tauriProjectFiles(options, target)` in `src/export/tauriProject.ts`; Android-only parts live in `src/export/android.ts` (pure: config values, Gradle and manifest patches, README) and `src/export/androidToolchain.ts` (detection, Node only). File access stays in `node.ts`.
- **`gen/android/` is generated, then patched.** `tauri android init` runs when the folder is missing or was made by an older Tauri CLI major/minor than the repo's (`@tauri-apps/cli` in `package.json`). The exporter then rewrites only blocks fenced by `// myco-export:begin <name>` / `// myco-export:end <name>` comments (Gradle, Kotlin) or `<!-- myco-export:… -->` (XML), adding them where missing, so the user's other edits in Android Studio survive re-exports. The blocks are:
  - `app/build.gradle.kts`: `signingConfigs.release` reading `keystore.properties` if it exists; `targetSdk = 36` (the current Play requirement, a constant in `android.ts` bumped yearly) when Tauri's template sets lower; `ndk { abiFilters }` from `--abis`.
  - `AndroidManifest.xml`: `android:screenOrientation` on the activity from `build.android.orientation`.
  - `MainActivity.kt`: immersive full-screen (system bars hidden, shown on swipe) and keep-screen-on while the activity is resumed, which games expect and Tauri doesn't offer.
- **Window.** Mobile ignores window size; the player already fills the page and letterboxes to `display`'s aspect ratio (0041).

### Project settings

New optional, exporter-only keys under `project.json`'s `build` (0041), not part of `ProjectSettings`:

- `build.android.orientation`: `"landscape"` | `"portrait"` | `"sensor"`. Default: `landscape` if `display`'s width ≥ height, else `portrait`.
- `build.android.versionCode`: an integer that must increase with every Play upload. Default: Tauri's derivation from `build.version`.
- `build.android.minSdk`: default **24** (see The low-end device). Values below 24 are refused (Tauri's floor).
- `build.android.iconBackground`: the adaptive icon's background colour. Default: `display.backgroundColor`.
- **Identifier.** Android application ids allow only letters, digits and `_` in each dot-separated part, each starting with a letter. `build.identifier` is validated against that for `--target android` (the error names the offending part). The default for Android is `com.myco.game.<slug>` with `-` replaced by `_`; desktop's default keeps its dashes so existing desktop saves don't move (open question).

### Icons

`tauri icon` (already run for desktop over `build.icon` or the neutral generated icon) writes the Android launcher mipmaps into `gen/android/` when that folder exists, so the exporter runs it after `android init`. The adaptive icon's background comes from `build.android.iconBackground`. A project icon must be at least 512×512 for Play's listing icon; smaller ones get a warning.

### How game assets are packaged

- The web build is embedded in the Rust library by Tauri's `generate_context!`, exactly as on desktop. No Android `assets/` folder, no separate loader.
- Each ABI's library carries a copy, so the AAB grows with the ABI count, but Play delivers one ABI per device. Hence the default ABIs: `aarch64` (Play's 64-bit requirement, nearly every phone) and `armv7` (32-bit-only low-end phones, which our low-end target can be). `x86_64` is for emulators.
- Play limits the compressed download of the base module to 200 MB; larger games need Play Asset Delivery. The exporter reports the per-ABI download size after a build and **warns above 150 MB**, but doesn't refuse.

### Toolchain detection and errors

`androidToolchain.ts` checks, before any build, and reports **every** problem at once with the fix for each (as 0041 does for scripts):

| Check | Found by | Error names |
|---|---|---|
| Rust | `cargo`, `rustup` on `PATH` | the rustup installer |
| Rust targets for `--abis` | `rustup target list --installed` | `rustup target add …` for the missing ones |
| JDK 17+ | `JAVA_HOME`, else Android Studio's `jbr` in its standard install paths | where to point `JAVA_HOME` |
| Android SDK | `ANDROID_HOME`, else `ANDROID_SDK_ROOT`, else the platform's default SDK folder | the SDK Manager packages to install |
| SDK platform for `targetSdk` and build-tools | `platforms/android-36`, `build-tools/*` under the SDK | `sdkmanager "platforms;android-36"` |
| NDK r28+ | `NDK_HOME`, else the newest `ndk/*` under the SDK (its `source.properties` version) | that r28+ is needed for 16 KB pages |
| Release keystore | see Signing | the `keytool` command in the README |

Found paths are passed to the Tauri CLI as environment variables, so users needn't set them globally. A failed check with `--build` exits non-zero; without `--build`, and when `cargo` is missing (as for desktop), the project and README are written and the problems printed. `tauri android build` output is streamed; on failure the exporter adds the most likely cause it can match (missing target, NDK, Gradle download blocked) but never hides the original output.

### Signing and keystores

- **The keystore never lives in the project.** `project.json` is committed, so it holds no keystore path or password. The keystore comes from `--keystore PATH` or `MYCO_ANDROID_KEYSTORE`; the alias from `MYCO_ANDROID_KEY_ALIAS` (default `upload`); the password from `MYCO_ANDROID_KEYSTORE_PASSWORD`, else a hidden prompt on an interactive terminal.
- The exporter writes `gen/android/keystore.properties` just before `tauri android build` and **deletes it afterwards**, success or failure; `gen/android/.gitignore` lists it anyway.
- The exporter **doesn't create keystores**. The README gives the `keytool` command (RSA 2048, alias `upload`, Windows variant) and says: enrol in Play App Signing, so this key is only the upload key and can be reset through Google if lost; back it up anyway, because sideloaded APKs signed with it can't be updated without it.
- `--debug` builds use the Android debug key Gradle creates, for emulators and test devices only.

### Runtime: the WebView's features

The player is unchanged; these are detections in the engine and player, true on any host:

- **Platform.** `detectPlatform()` checks for an Android or iOS user agent **before** the Tauri marker, so a Tauri app on a phone is `"mobile"` and gets the mobile quality defaults (0050) and auto-detection (0055).
- **Secure context.** The Android build sets `useHttpsScheme: true`, so the page is `https://tauri.localhost` without relying on `*.localhost` being treated as trustworthy. (Changing it later would change the origin; nothing of ours depends on origin storage, since saves are files.)
- **Rendering.** WebGPU where the WebView exposes it, else Babylon's WebGL2 engine. **On Android, WebGL2 is a supported path, not just a fallback** (a partial amendment of 0075's "isn't a target"): the Low quality tier must render correctly on it, and higher tiers may turn features off as 0075 allows. A WebView without WebGL2 gets a full-page message ("This game needs a newer Android System WebView", with a link to its Play page) instead of a blank canvas.
- **Audio.** The audio core's own rule applies: AudioWorklet + `simd128` + a secure context run the core; anything less gets the Babylon fallback, with one warning. Android's minimum WebViews (Chromium 119 on 7.x) have all of these, so the fallback is for broken or disabled WebViews.
- **Gate on features, never on version strings.** The README states the expected floor (Chromium 91 for the audio core, WebGL2 for rendering) for players who ask.
- **Lifecycle.** The WebView fires `visibilitychange` when the app goes to the background; `requestAnimationFrame` stops while the page is hidden, so frames stop. Audio must also stop: the audio backend suspends its `AudioContext` on `hidden` and resumes on `visible`. This record requires that of every audio backend (the core and the fallback); whether today's backend already does it is unverified.

### Touch input

- **No new input API in this record.** Touch already arrives as pointer button 0, so pointer-driven games (Flappy) work. The player page gets `touch-action: none` and `overscroll-behavior: none` on the canvas and a non-scalable viewport, so taps and drags don't scroll, zoom or pull-to-refresh, and a first touch counts as the user gesture that unlocks audio.
- **Multi-touch, gestures and on-screen controls** (virtual sticks and buttons in the UI system, 0069) are a separate record; a keyboard-only game exports but can't be played on a phone, and the README says so.
- **The Back button/gesture** closes the activity by default. v1 maps it to the `Escape` key for one frame (games commonly pause on Escape) and lets a second press within 2 s exit. Whether games want a dedicated `Input` query is an open question.

### The low-end device and minimum Android version

- The owner's rule: the low-end device is an Android phone on the lowest Android version Google Play accepts for publishing, as a starting point that moves up if features show significant gaps.
- Google Play has no `minSdkVersion` floor, so the lowest version a Myco game can publish for is **Tauri's floor, Android 7.0 (API 24)**. That's the default `minSdk` and the version of the low-end test phone (the same phone as the audio core's soak gate).
- **The first likely step up is Android 10 (API 29)**: Android 7's WebView is frozen at Chromium 119 and 8–9's at 138, with no security fixes, while Android 10+ still updates. If testing on 7.x shows significant gaps (rendering bugs in an old WebView, memory, the audio core falling back), we raise `minSdk` and the test phone together and record it in this record's status.
- `targetSdk` is always Play's current requirement (36 today); that's unrelated to the minimum.

### Testing

- **Unit (Vitest, headless):** `tauriProjectFiles` for android (config values, identifier validation and default, versionCode, orientation default), the marked-block patcher (adds missing blocks, replaces its own, leaves other edits alone, idempotent), toolchain detection over a fake environment and file system (every row of the table, all problems at once), keystore handling (properties file written and removed on failure; never written without a keystore), and `detectPlatform` with Tauri + Android user agent.
- **Emulator smoke (`npm run test:android`, manual and opt-in CI, not in `test:e2e`):** export Flappy with `--debug --abis x86_64`, boot two AVDs (API 24 and API 36, x86_64, Google APIs images), `adb install`, launch, attach **Playwright's Android support** (`_android`, which drives Android WebViews over adb) to the app's WebView, wait for the player's ready flag, tap to flap, check a save survives an app restart, and screenshot. The heavy toolchain (SDK, NDK, emulator) keeps this out of the default suite; it runs before releases and on changes to `src/export/android*.ts`, `tauriProject.ts` and the player.
- **Real low-end device (manual checklist, per release while Android is new):** a release AAB through Play's internal testing track to the Android 7.x phone; boot to first frame time; 10 minutes of play at the Low tier; touch and Back; background/resume with audio; saves across restarts; and the audio core's 30-minute soak gate on the same phone. Results go in `implementation-status.md`. A gap found here is the trigger for moving the minimum up.
- **Play pre-launch:** the first internal-track upload of a sample confirms the 16 KB page check, target API and signing pass Play's checks.

## Alternatives considered

- **A hand-written native Android shell (Kotlin + `WebView`) instead of Tauri.** Smaller and fully ours, but it duplicates what Tauri gives (fs plugin storage, icons, signing flow, one Rust shell for desktop and mobile) and drops the reason Tauri was chosen. The desktop generator already has the mobile entry point.
- **Capacitor or a Trusted Web Activity.** Capacitor is a second shell stack beside Tauri. A TWA runs the game in the user's Chrome from a hosted URL: no offline install, saves in Chrome's storage, and it needs hosting and Digital Asset Links. Neither reuses the desktop path.
- **Copy the user-facing Tauri docs' approach: hand-edit `gen/android` once and commit it.** Fine for one app, but every exported game would need manual Gradle edits for signing and orientation; marked blocks keep re-exports automatic while preserving the user's own edits.
- **Regenerate `gen/android/` on every export.** Simplest to reason about, but it throws away Android Studio edits and slows every export with a Gradle sync. Kept unless missing or made by another Tauri CLI version.
- **Serve game assets from the APK's `assets/` folder** (one copy for all ABIs). Smaller AABs, but needs a custom Tauri protocol handler on Android and differs from desktop; per-ABI copies cost little on Play, which ships one ABI. Revisit with Play Asset Delivery.
- **minSdk 29 (Android 10) from the start.** Safer WebViews, but it contradicts the owner's rule of starting at the lowest publishable version and moving up on evidence.
- **Keystore path in `project.json`.** Convenient, but `project.json` is committed and shared; secrets and machine paths stay in flags and environment variables.

## Consequences

**Positive**
- Any project becomes an installable Android game with one command, through the same web build and Tauri shell as desktop; the player is still tested once.
- Re-exports are automatic, signing secrets never touch the project, and the user can still open `gen/android/` in Android Studio.
- Android's WebView is treated as another browser: every runtime difference is a feature detection that also helps mobile web players.

**Negative / costs**
- A heavy toolchain (Android SDK, NDK r28+, JDK, four Rust targets, Gradle downloads; several GB) and a first build of many minutes; the editor can't build Android packages itself.
- WebGL2 becomes a path we must keep working on Android, which 0075 avoided; Low-tier visual regressions there are now bugs.
- Android 7's WebView is frozen at Chromium 119 without security fixes; shipping to it is a deliberate, revisitable choice.
- Each ABI carries a copy of the game; big games will hit the 200 MB base-module limit before Play Asset Delivery is supported.
- `targetSdk` must be bumped every year to keep Play uploads working.
- Patching generated Gradle/Kotlin ties us to Tauri's template layout; a Tauri update can move files and needs the patcher's tests updated.

## Deprecates

Nothing. It resolves 0041's open question on mobile targets for Android (iOS stays out of scope: games target web, desktop and Android).

## Open questions

- **Identifier consistency:** change desktop's default identifier to underscores too (moving existing desktop saves), or keep the two defaults different?
- **Back button:** keep the Escape mapping, or add an `Input` query and a project setting for "Back exits"?
- **Multi-touch and on-screen controls:** a separate record (pointer list in `Input`, UI virtual stick/buttons).
- **WebGPU in Android WebView:** confirm on real devices (Android 12+, Qualcomm/ARM) whether the WebView exposes it, and whether any high-end tier should require it on Android.
- **Play Asset Delivery** for games over the base-module limit, and per-ABI asset deduplication.
- **Automating Play uploads** (Play Developer API) and `adb install` after a debug build (`--install`).
- **Which Android 7.x phone** is the test device (and whether it should be 32-bit armv7, the likeliest low-end case), and the threshold for "significant gaps" that moves the minimum to Android 10.
- **Exact Play dates** (16 KB enforcement, next target-API bump) are from secondary sources; recheck in the Play Console before the first upload.

## References

- 0041 and `src/export/` (`desktop.ts`, `node.ts`, `main.ts`, `cli.mjs`, `images.ts`); `src/engine/core/graphics.ts` (`detectPlatform`); `src/engine/input/Input.ts`; `src/engine/core/Engine.ts` (`TauriStorage`).
- The audio-core record and `docs/design/0149-audio-core/` on branch `claude/fmod-integration-d19dbb` (Platforms and minimum versions; soak gate).
- Tauri: [prerequisites (Android)](https://v2.tauri.app/start/prerequisites/), [Android code signing](https://v2.tauri.app/distribute/sign/android/), [Google Play distribution](https://v2.tauri.app/distribute/google-play/), [develop on mobile](https://v2.tauri.app/develop/), [2.1.0 release notes (`useHttpsScheme`)](https://tauri.app/release/tauri/v2.1.0/).
- Google Play: [target API level requirements](https://developer.android.com/google/play/requirements/target-sdk), [16 KB page sizes](https://developer.android.com/guide/practices/page-sizes).
- Chrome on old Android: [Chromium PSA: Android 8/9 deprecated (Chrome 138 last)](https://groups.google.com/a/chromium.org/g/chromium-dev/c/vEZz0721rUY), [Chrome 120 drops Android 7 (ghacks)](https://www.ghacks.net/?p=203825).
- WebGPU on Android: [What's New in WebGPU (Chrome 121)](https://developer.chrome.com/blog/new-in-webgpu-121).
- Playwright Android (`_android`, WebView automation over adb): https://playwright.dev/docs/api/class-android
