# Input: hardware checklist (ADR 0335–0337)

What automated tests can't cover: real controllers, and the desktop builds on Windows and macOS. Run each section on each platform and note the result beside it (pass / fail with what happened).

**Platforms:**
- Windows 11, desktop editor and an exported desktop game (`npm run tauri:dev`; `npm run export -- <project> --target desktop`, then `tauri build`)
- macOS, the same two
- Linux, the same two
- Browsers: Chrome, Firefox and Safari, web export (`npm run export -- <project>`, then `node serve.mjs`)

**Controllers, where available:** Xbox Series (USB and Bluetooth), DualSense (USB and Bluetooth), DualShock 4, Switch Pro, one generic or third-party pad.

## 1. Connection

- [ ] **Already plugged in:** a pad connected before the game starts appears as a device node under `Input` (editor play mode, hierarchy) with the right family.
- [ ] **Hot-plug:** plugging in during play adds the node with the next free slot, and unplugging removes it the frame after. Re-plugging takes the lowest free slot.
- [ ] **Two of the same model:** two identical pads get distinct slots.
- [ ] **Desktop only:** the browser Gamepad API isn't used. A pad works with the window unfocused and refocused; Space/Enter in the editor UI don't reach the game.

## 2. Mapping

- [ ] **Face buttons:** pressing buttonSouth on each family gives `<Gamepad>/buttonSouth` (A, Cross, B on Switch Pro: the bottom position).
- [ ] **Sticks:** up gives `move.y` > 0. Resting sticks read 0 (dead zone).
- [ ] **Triggers:** analog 0..1. `rightTrigger` performs a button action past half way.
- [ ] **D-pad:** works on every pad, including web pads the browser doesn't map (generic pad on Firefox/Linux).
- [ ] **Extra buttons:** Home and Share/Capture/Mute map to `home` and `misc1`. On desktop, the DualSense touchpad click maps to `touchpadPress`.

## 3. Output (desktop; web where noted)

- [ ] **Rumble:** `player.rumble(0.3, 0.8, 300)` rumbles on Xbox and DualSense. On the web, it rumbles in Chrome.
- [ ] **Trigger rumble:** `player.rumbleTriggers(…)` on an Xbox Series pad (desktop; Chrome on the web).
- [ ] **Light bar:** `player.setLight(255, 0, 0)` on DualSense and DualShock 4.
- [ ] **Motion:** after `player.setSensors(true)`, `<Gamepad>/gyro` reads rotation on DualSense and Switch Pro, and stops after `setSensors(false)`.

## 4. Players and prompts

- [ ] **onePerDevice:** with `input.join: "onePerDevice"`, keyboard and mouse are player 0 and each pad its own player. Unplugging a pad removes its player.
- [ ] **pressToJoin:** a pad joins on its first press.
- [ ] **Prompts:** `player.prompt("jump").label` follows the device last used (A → Cross → Space).
- [ ] **Rebinding:** rebinding with a pad captures the next gamepad press, Escape cancels, and `saveBindings`/`loadBindings` survive a restart.

## 5. Netcode

- [ ] **Two machines:** two machines in a networked sample. The pad drives the predicted pawn without visible correction at normal latency.

## 6. Platform specifics

- [ ] **macOS:** SDL runs on its own thread in the Tauri process. Check hot-plug and Bluetooth pads specifically (SDL's macOS backends prefer the main thread).
- [ ] **Windows:** Xbox pads over the Xbox Wireless adapter, and DualSense with Steam running (Steam Input may grab the pad).
- [ ] **Linux:** pads appear without root (udev rules), and Flatpak/AppImage builds if we ship those.

## Recording

While running this checklist, record anything a test should keep: a controller nobody else has, a pad that reads wrong, a hot-plug that misbehaves. A recording holds the controller's raw input as it reached the engine's adapter, so a test replays it through the same driver code without the hardware.

**Recording a fixture:**
1. Open the **Input Debugger** (Window › Input Debugger). Record works while editing and while playing.
2. Connect the controller first. Over WebHID, open it before recording too (`Input.requestHidGamepads()`): the adapter keeps each device's setup (its report descriptor, feature-report replies, and the reports exchanged until its driver was ready), so a recording started later can replay it.
3. Click **Record**, do what the test needs (press each button, sweep the sticks, unplug and replug), then click **Stop**.
4. The file is saved as `recordings/input-<date>-<time>.input-recording.json` in the project (downloaded instead from a read-only project, such as a sample). The panel says what it holds: its WebHID devices, SDL, Gamepad API, events and length.

What it records, by adapter:
- **WebHID** (Chromium on the web): every input report (report id and bytes) of each open device, with the device's name, vendor, product, collections, feature-report replies and setup exchange.
- **SDL** (the desktop editor): every batch the native side sends (`NativeGamepadEvent[]`), and the pads connected when recording began.
- **Gamepad API** (other browsers, pads WebHID doesn't open): each poll whose reading changed (every pad's buttons and axes), and the OS whose controller database maps it.

Each event has its time in milliseconds from the start. The format (`"format": "myco-input-recording"`, `"version": 1`) is documented on `InputRecording` in `src/engine/input/recording.ts`.

**Committing it:**
- Put fixtures in `src/engine/tests/fixtures/input/`, named after the controller and what they show: `dualsense-bt-sticks.input-recording.json`. Trim what the test doesn't need, and keep them small (seconds, not minutes).
- A recording names the controller (its product string), and for the Gamepad API the OS family (windows, mac, linux), nothing else about the machine. Check it before committing anyway.
- `sample.input-recording.json` there is a constructed example (no real controller): a DualSense and a Switch Pro over WebHID, an SDL pad and a Gamepad API pad.

**Using it in a test:** `replayInputRecording(recording, sink)` (`src/engine/input/replay.ts`) feeds it through the real adapters (stand-in HID devices opened by the WebHID adapter and its drivers, SDL batches through `applyNativeBatch`, a stand-in `navigator` read by the Gamepad API adapter) into any `DeviceEventSink`: a test's own, or `Input.inject` to drive a headless Engine.

```ts
const recording = JSON.parse(readFileSync(new URL("./fixtures/input/dualsense-bt-sticks.input-recording.json", import.meta.url), "utf8"));
const replay = replayInputRecording(recording, sink);
await replay.ready;                         // devices set up, pads connected
await replay.advanceTo(500);                // the first half second
await replay.finish();                      // the rest
replay.stop();
```

`src/engine/tests/inputRecording.test.ts` replays the sample and checks the sink's events.
