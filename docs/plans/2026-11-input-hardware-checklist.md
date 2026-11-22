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
