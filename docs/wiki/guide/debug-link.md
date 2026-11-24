# The debug link: connecting tools to a running game

The debug link lets the Audio Studio and the editor reach a game while it runs: record a take from it, follow its
audio profile live, change its mix, and inspect its animation. It works with an exported game on this machine or
another one on the same network, and with the editor's own Play. Release exports carry none of it.

Records: [0376](../../decisions/0376-a-debug-link-connects-running-builds-to-the-editor-and-the-studio.md) (the link),
[0379](../../decisions/0379-the-desktop-editor-listens-for-the-debug-link-through-a-native-websocket-server.md) (the
desktop listener), [0403](../../decisions/0403-debug-link-pairing-reaches-every-native-and-browser-endpoint-on-one-network.md)
(pairing). Takes: [audio-takes.md](audio-takes.md).

## Turning it on in a game

Export with debugging on. On the command line:

```
npm run export -- samples/flappy --target desktop --debug-listen --debug-lan
```

| Flag | `game.json` | Effect |
|---|---|---|
| `--debug-link <address>` | `debug.link` | The game connects out to a tool listening at that address (the editor and the Studio listen on `ws://localhost:7790/myco-debug` by default). |
| `--debug-listen` | `debug.listen` | The game listens for tools (desktop and Android games; a browser page can't listen). |
| `--debug-lan` | `debug.lan` | It listens on the network, not only this machine. Off by default. |
| `--debug-port N` | `debug.port` | The first port it tries (default 7790); when one is taken it tries the next nine. |
| `--debug-rendezvous <url>` | `debug.rendezvous` | A rendezvous you run yourself (`ws://` or `wss://`), for room codes when nothing on your network hosts one. No public one exists. |

A listen-only export (listening flags without `--debug-link`) doesn't also dial the default address.

A desktop debug export writes the listener's Rust sources into its generated Tauri project, so `tauri build` compiles
them in. Players never need Rust; release exports get none of it.

At launch, a desktop game also takes `--debug-link <address>` and `--debug-code <code>`; a web build takes
`?debug-link=` and `?debug-code=` in its URL.

## Pairing

A listening game shows a **pairing code** in a corner box: two groups of five characters, like `3F9QK-7KD2X`. **F8**
shows or hides it. The box hides once a tool connects and comes back when the last one leaves.

In the Studio or the editor, open the builds menu in the status bar and choose **Connect to a build…**. Type the code
(case and spaces don't matter), or an address such as `192.168.1.20:7790`.

- A code is used once and lasts five minutes; the game shows the next one after each pairing.
- Five wrong codes in a row lock the game's network connections for a minute.
- Tools on the same machine need no code.
- The other way round works too: the Studio or editor listens, and the game is launched with
  `--debug-link <address> --debug-code <code>`. A game that arrives from another machine without a code waits for you
  to accept it.

**Nearby builds.** In the desktop editor and Studio, the dialog also lists listening games found on your network
(mDNS, `_myco-debug._tcp`), as "flappy — desktop, 192.168.1.20". Choosing one fills in its address; you still type
the code it shows, because being listed isn't being trusted, and the code's token is what the game checks. A picked
build and a room code don't go together (the dialog says so); editing the address clears the pick. Only games with
**LAN** on advertise themselves (a localhost-only listener isn't reachable from elsewhere). A browser page can't use
mDNS, so in a browser the list doesn't appear: type the code or the address.

The editor's Play is a build too: while Play runs, its code shows at the top of the editor's builds menu, so the Studio
can record takes from Play.

### Room codes: browser pages

A browser page can't listen, so a listening web build opens a **room** on a rendezvous instead and shows a **room
code** (ADR 0404). The rendezvous only passes the handshake between the two sides; the link itself then runs
directly between them over WebRTC.

- A debug web export's `serve.mjs` hosts the rendezvous on its own port (the export copies `rendezvous.mjs` beside
  it); so do `npm run dev`, the desktop editor, the Studio and listening desktop games. A room code names a
  rendezvous on one of a fixed set of ports: 7790–7799, 3000 or 8080. Serve the build on one of them
  (`node serve.mjs 7790`).
- Open the page by its **network address** (`http://192.168.1.20:7790/`) so its code works from other machines. From
  `localhost` the code pairs only with tools on the same machine, and the box says so.
- A tool types the room code in **Connect to a build…** as it would any code.
- The other way round: in a browser Studio or editor, **Offer a room…** in the builds menu shows a room code; open
  the game with `?debug-code=<code>` (or launch a desktop game with `--debug-code <code>`).
- `npm run build:rendezvous` builds the rendezvous as one file, `dist/rendezvous/rendezvous.mjs`, which you can run
  yourself (`node rendezvous.mjs --port 7790`) and name in Preferences > Debug link > Rendezvous URL and in an export's
  `--debug-rendezvous`. A page served over https can only pair through a `wss://` rendezvous like that.

## In the Studio

With a build connected and chosen in the builds menu:

- **Take:** **Start take**, type a marker text and **Mark**, **Stop**, then **Save into recordings/**. The take uploads
  ("Chunks received") and opens; it is named after the build and the time.
- **Profiler:** **Follow build** shows the build's live capture on the timeline. If nothing arrives for 3 seconds the
  status says the build's Play may have stopped.
- **Mixer:** your edits apply to the Studio's mix and to the build's live mix. A capture on the build records them
  with the origin `debugLink`.

## Network checklist

- Both machines on the same network, not a guest network with client isolation.
- Windows: the first time a game listens, Windows Firewall asks; allow it on **Private networks**. The Wi-Fi network
  must use the **Private** profile (Settings > Network & Internet > Wi-Fi > your network); a Public profile blocks it.
- Discovery (Nearby builds) uses mDNS: multicast on UDP port 5353. A VPN, a firewall rule against it, or a router that
  filters multicast between Wi-Fi clients leaves the list empty; the code still pairs.
- Android games: see the next section.

## Running a debug game on Android

An Android game is built from a debug desktop export with the Tauri CLI or Android Studio.

1. **Export** with debugging on and LAN listening: `npm run export -- <project> --target desktop --debug-listen
   --debug-lan --no-build`. The Tauri project is in `src-tauri/` of the export folder.
2. **Toolchain:** Android Studio with the SDK and NDK, `JAVA_HOME` set, and `rustup target add aarch64-linux-android`.
3. **Build:** in the export folder, `npx @tauri-apps/cli android init`, then `npx @tauri-apps/cli android build
   --debug` (or open `src-tauri/gen/android` in Android Studio). Install the APK on the phone.
4. **Network:** the phone and the tool's machine on the same Wi-Fi, without client isolation. The game shows its code
   as on the desktop and appears in Nearby builds as "android".
5. **Cleartext:** the link uses plain `ws://`. Tauri's generated manifest sets `android:usesCleartextTraffic` from a
   placeholder that its debug build type sets to `true`, so a `--debug` build needs nothing more. A release-profile APK
   with the link on needs a network security config: add `android:networkSecurityConfig="@xml/network_security_config"`
   to `<application>` in `gen/android/app/src/main/AndroidManifest.xml`, and create
   `gen/android/app/src/main/res/xml/network_security_config.xml`:

   ```xml
   <?xml version="1.0" encoding="utf-8"?>
   <network-security-config>
       <base-config cleartextTrafficPermitted="false" />
       <domain-config cleartextTrafficPermitted="true">
           <domain includeSubdomains="false">localhost</domain>
           <!-- the tool machine's LAN address: Android matches hosts, not address ranges -->
           <domain includeSubdomains="false">192.168.1.20</domain>
       </domain-config>
   </network-security-config>
   ```

   Running `tauri android init` again regenerates `gen/android/`: add the file back afterwards.
6. **Discovery:** Android drops multicast for apps that hold no Wi-Fi multicast lock. A debug export includes the
   `myco-multicast` plugin (`native/tauri-plugin-myco-multicast`), which takes the lock when the game starts and
   releases it when it closes; its manifest asks for `CHANGE_WIFI_MULTICAST_STATE` and `ACCESS_WIFI_STATE`. Without
   the lock, type the code.

The export's gamepad module builds SDL3 from source; it hasn't been tried for Android yet. If `tauri android build`
fails in `sdl3-sys`, report it.

## OP1: a desktop game and a laptop Studio on one Wi-Fi (owner procedure)

You need a Windows desktop and a laptop with the Tauri Studio, on one Wi-Fi network. Use `samples/flappy`. The
headless walker for these steps is `src/plugins/audio/editor/debugLink/op1.walk.test.ts`.

1. **Export.** On the desktop: `npm run export -- samples/flappy --target desktop --debug-listen --debug-lan`. You
   should get an export folder with a built app.
2. **Launch cold.** Start the app from its build folder (not `tauri dev`) and don't touch anything. You should see the
   game and the code box in a corner. Write the code down. Press **F8**: the box hides; F8 again shows it.
3. **Firewall.** If Windows asks, allow the app on Private networks. If you denied it, step 4 fails: see step 9.
4. **Pair.** On the laptop, in the Studio's builds menu, choose **Connect to a build…**, type the code, press Connect.
   The dialog closes and the game appears in the builds menu. On the desktop the code box hides.
5. **Next code.** On the desktop press **F8**: a different code shows. Pair a second tool with it (a second Studio
   window, or the editor's **Connect to a build…**): it pairs. Try the first code again: it is refused as already
   used. Both tools stay connected.
6. **The reverse.** Close the game. The Studio listens on this machine by default; turn on the network in its builds
   menu's **Debug link settings…** and note the address shown. Launch the game as
   `<app>.exe --debug-link ws://<laptop-address>:7790/myco-debug`. The Studio asks whether to accept it; accept. Then
   launch it again with `--debug-code` and a code the Studio shows (if it shows one) to check it arrives without asking.
7. **Record a take.** In the Studio's Take screen: **Start take**, play for about 10 seconds, type `OP1` and **Mark**,
   **Stop**, **Save into recordings/**. The progress fills and the take opens with the mark `OP1`. For a byte check, save the
   same take on the desktop too (F10 if the export has `audioTake` on) and compare the two files (`fc /b`).
8. **Move a bus.** In the Studio's Mixer, drag the Music fader. The desktop game's music level follows within a frame
   or two. Move it back.
9. **Network profile.** If step 4 failed: check the desktop's Wi-Fi uses the Private profile and that the app is
   allowed on Private networks (Windows Security > Firewall & network protection > Allow an app through firewall),
   then repeat from step 2.

Record pass or what you saw for each step. Steps 4 and 7 are the milestone's pass/fail.

## OP2: a web build and a browser tool by room code (owner procedure)

You need two machines on one Wi-Fi (a third tab works for the tool). The headless check for these steps is
`tests/e2e/debuglink-webrtc.spec.ts`.

1. **Export.** On machine A: `npm run export -- samples/flappy --debug-listen --debug-lan`. The export folder holds
   `serve.mjs` and `rendezvous.mjs`.
2. **Serve.** In the export folder on A: `node serve.mjs 7790`. It prints the game's address, its network addresses,
   and "Pairing rendezvous at ws://…/myco-rendezvous". Allow Node through the firewall on Private networks if asked.
3. **Open the game.** On machine B, open `http://<A's address>:7790/`. The game runs, and a box in a corner shows a
   code (`XXXXX-XXXXX`) with no note about localhost.
4. **Connect.** On machine A (or a third machine), open the browser editor or Studio from `npm run dev`. In the
   builds menu choose **Connect to a build…**, type the code, press Connect. "Connecting…" shows for a few seconds,
   the dialog closes, and the button reads "1 build". On B the code box hides.
5. **List.** The builds menu shows the game as "flappy (web, <address>, through a room)". The room's token never
   shows.
6. **Wrong code.** Disconnect, press F8 on B for the new code, and type it with one character changed: the dialog
   shows a red line and stays open. Type the right code: it pairs.
7. **Take (browser Studio).** In the Studio's Take screen: **Start take**, play a few seconds on B, **Stop**, **Save
   into recordings/**. The take opens.

Record pass or what you saw for each step. Steps 4 and 7 are the milestone's pass/fail.

## OP3: Nearby builds and an Android game (owner procedure)

You need the desktop, the laptop and the phone on one Wi-Fi. The headless checks are `cargo test -- --ignored` in
`native/debug-discovery` (advertise, then browse, on this machine's multicast) and the dialog's `discovery.test.ts`.

1. **Desktop game.** On the desktop, export and build `samples/flappy` with `--target desktop --debug-listen
   --debug-lan` and start the app from its build folder.
2. **List.** On the laptop, start the desktop Studio and open **Connect to a build…**. Within a few seconds "Nearby
   builds" lists "flappy — desktop, <desktop's address>". Pass: it appears without typing anything.
3. **Pick and pair.** Choose it, type the code the game shows, press Connect: the build pairs and the code box hides.
   Then disconnect, pick it again and type a wrong code: the dialog refuses it.
4. **Gone.** Close the game's window: within a few seconds the row leaves the list. (A game that crashes or is killed
   sends no goodbye and stays listed for up to 75 minutes; picking it just fails to connect.)
5. **Android.** Build the same export for Android (the section above) and start it on the phone. In the laptop's
   Studio, the dialog lists "flappy — android, <phone's address>". Pick it, type its code: it pairs. Record a take
   from it in the Take screen (as in OP1 step 7).
6. **Browser.** Open the browser Studio from `npm run dev`: the dialog shows no Nearby builds section.

Record pass or what you saw for each step. Steps 2, 3 and 5 are the milestone's pass/fail; if step 5 fails, note
whether the phone's game showed a code (listening works) and whether typing the code pairs (only discovery fails).
