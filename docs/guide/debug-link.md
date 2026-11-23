# The debug link: connecting tools to a running game

The debug link lets the Audio Studio and the editor reach a game while it runs: record a take from it, follow its
audio profile live, change its mix, and inspect its animation. It works with an exported game on this machine or
another one on the same network, and with the editor's own Play. Release exports carry none of it.

Records: [0376](../decisions/0376-a-debug-link-connects-running-builds-to-the-editor-and-the-studio.md) (the link),
[0379](../decisions/0379-the-desktop-editor-listens-for-the-debug-link-through-a-native-websocket-server.md) (the
desktop listener), [0380](../decisions/0380-debug-link-pairing-reaches-every-native-and-browser-endpoint-on-one-network.md)
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

The editor's Play is a build too: while Play runs, its code shows at the top of the editor's builds menu, so the Studio
can record takes from Play.

## In the Studio

With a build connected and chosen in the builds menu:

- **Take:** **Start take**, type a marker text and **Mark**, **Stop**, then **Save into takes/**. The take uploads
  ("Chunks received") and opens; it is named after the build and the time.
- **Profiler:** **Follow build** shows the build's live capture on the timeline. If nothing arrives for 3 seconds the
  status says the build's Play may have stopped.
- **Mixer:** your edits apply to the Studio's mix and to the build's live mix. A capture on the build records them
  with the origin `debugLink`.

## Network checklist

- Both machines on the same network, not a guest network with client isolation.
- Windows: the first time a game listens, Windows Firewall asks; allow it on **Private networks**. The Wi-Fi network
  must use the **Private** profile (Settings > Network & Internet > Wi-Fi > your network); a Public profile blocks it.
- Android games built through the Tauri CLI: the generated `gen/android/` project needs cleartext traffic to private
  addresses allowed in debug builds (a network security config), and a multicast lock for discovery. These come with
  the M3 work; until then use the desktop.

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
   **Stop**, **Save into takes/**. The progress fills and the take opens with the mark `OP1`. For a byte check, save the
   same take on the desktop too (F10 if the export has `audioTake` on) and compare the two files (`fc /b`).
8. **Move a bus.** In the Studio's Mixer, drag the Music fader. The desktop game's music level follows within a frame
   or two. Move it back.
9. **Network profile.** If step 4 failed: check the desktop's Wi-Fi uses the Private profile and that the app is
   allowed on Private networks (Windows Security > Firewall & network protection > Allow an app through firewall),
   then repeat from step 2.

Record pass or what you saw for each step. Steps 4 and 7 are the milestone's pass/fail.
