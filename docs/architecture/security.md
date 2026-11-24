# Known security limitations

What the editor and its desktop shell trust today, the risk that leaves, and how it would be closed. These are accepted for now (owner decision, November 2026 bug check, B71, Q6 and Q7); nothing here is a promise of when they change. A change to any of them is a decision record of its own.

## The debug link admits any connection from this machine

**What happens.** The desktop editor's debug link ([0376](../decisions/0376-a-debug-link-connects-running-builds-to-the-editor-and-the-studio.md), [0379](../decisions/0379-the-desktop-editor-listens-for-the-debug-link-through-a-native-websocket-server.md)) listens at `ws://127.0.0.1:7790/myco-debug` (every interface with the LAN toggle on, off by default). A connection from a loopback address is admitted as a local build with no prompt (`isLocalRemote` in `src/editor/debugLink/debugLinkLogic.ts`, `EditorDebugLink` in `editorLink.ts`); only connections from other machines get the accept prompt. The listener (`native/ws-listener`) checks the upgrade's path, not its `Origin` header, and asks for no token.

**Since pairing ([0403](../decisions/0403-debug-link-pairing-reaches-every-native-and-browser-endpoint-on-one-network.md)).** The editor, the Studio and debug games can now listen on 7790–7799, and a listener also answers the rendezvous at `/myco-rendezvous` on the same port. A connection from another machine must present a single-use pairing token (5 minutes, locked for a minute after 5 wrong tries) or be accepted at a prompt. A connection from this machine still needs neither (the token gate's same-machine rule), so everything below still holds, now for each of those listeners. Network discovery advertises name, platform and path, never a token.

**Risk.** A browser does let any web page open a WebSocket to `127.0.0.1`. So any page open in the user's browser while the editor runs, and any other local process, can connect as a "build": it shows in the connected-builds menu, can feed the debugger made-up data (Animator graphs, frames), and receives the subscriptions and commands the editor sends to builds. It can't read project files through the link, but every byte it sends reaches the editor's envelope and topic parsers, so a parser bug becomes reachable from the web.

**Likely mitigations.**
- Refuse upgrades whose `Origin` header is present and isn't a known build origin (a browser always sends `Origin`; a native or Node build sends none or its own). The listener's handshake callback is the place (`check` in `native/ws-listener/src/lib.rs`, which already refuses other paths with 404).
- Or require a per-session token: the editor generates one, hands it to builds it launches (the `--debug-link` launch flag and `npm run export -- --debug-link`), and refuses an upgrade without it (a query parameter, as `?myco-rtc=1` already is).
- Prompting for local connections too, as for remote ones, is the fallback if neither fits.

## The desktop editor can open any path, and its windows have no CSP

**What happens.** `src-tauri/capabilities/default.json` grants `opener:allow-open-path` for `{ "path": "**" }`: the editor's windows (`main`, `projects`, `studio`) can ask the OS to open any file with its default app, executables included. It's there so the Code panel's **Open Externally** opens a script in the system's code editor ([0030](../decisions/0030-in-editor-scripting.md)). `src-tauri/tauri.conf.json` sets `"csp": null`, so the windows run under no Content Security Policy. The same windows hold `fs:write-all` over the project folders the user picked ([0003](../decisions/0003-tauri-platform-browser-runtime.md), [0026](../decisions/0026-editor-scene-document-and-commands.md)).

**Risk.** Anything that runs script in an editor window has these permissions: project scripts and plugins running in Play mode ([0139](../decisions/0139-third-party-plugins-load-through-the-script-and-package-pipeline.md) treats plugins as trusted code), an npm package a project imports, or content injected through a bug. With no CSP, injected markup can load and run script from anywhere. Such script could write a native executable into a project folder with `fs:write-all` and launch it with `opener`, which turns "opened an untrusted project" into "ran native code".

**Likely mitigations.**
- Limit `opener:allow-open-path` to the extensions the editor opens externally (scripts, shaders, images, audio and model assets) instead of `**`, so an executable can't be launched through it; `revealItemInDir` covers "show in folder" for the rest.
- Set a CSP in `tauri.conf.json`: `script-src 'self'` plus what the editor really needs (`'wasm-unsafe-eval'` for the wasm modules, the dev server in `devCsp`). The player already works under a strict CSP (no `eval`, see [0094](../decisions/0094-gpu-particle-simulation-backends.md) and [0250](../decisions/0250-one-shader-source-module-writes-shader-functions-once-with-wgsl-glsl-and-javascript-outputs.md)); the editor's script compiler and plugin loading need checking first.
- Longer term, run Play-mode project code in a window or worker without the editor's file and opener permissions.

Game builds aren't affected: a desktop export is a generated Tauri app with `tauri-plugin-fs` only and file access to the app data folder ([0041](../decisions/0041-game-builds.md)).
