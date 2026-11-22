//! Native gamepads for Myco Engine's desktop shell (ADR 0333), through SDL3.
//!
//! A background thread owns SDL (initialised for gamepads, sensors and haptics only), waits on its
//! events and streams them to the page in batches over a Tauri channel; the page sends output
//! (rumble, trigger rumble, LEDs, sensor switching) back as commands. Under Tauri this is the only
//! gamepad source: the page never reads the browser Gamepad API there.
//!
//! This file is self-contained: the desktop export (src/export/desktop.ts) copies it verbatim into
//! exported games' generated Tauri projects, which need `sdl3`, `sdl3-sys` and `serde` with the
//! features in src-tauri/Cargo.toml, and the five commands below in `generate_handler!`.
//!
//! Wire indices (shared with the web adapter and `native/input`): buttons in the W3C "standard"
//! order then extras (0 south, 1 east, 2 west, 3 north, 4/5 shoulders, 6/7 triggers 0..1, 8 select,
//! 9 start, 10/11 stick presses, 12–15 d-pad up/down/left/right, 16 home, 17 misc1, 18 right paddle
//! 1, 19 left paddle 1, 20 right paddle 2, 21 left paddle 2, 22 touchpad press); axes 0..3 left X,
//! left Y, right X, right Y in -1..1 with +Y down. Buttons are positional: south is the bottom face
//! button whatever its label. Sensors are in SDL's units and axes (gyro rad/s, accelerometer m/s²;
//! +X right, +Y up, +Z towards the player). `time` is SDL's event timestamp in milliseconds
//! (monotonic, arbitrary origin); `id` is SDL's joystick instance id.
use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::OnceLock;
use std::time::Duration;

use sdl3::event::Event;
use sdl3::gamepad::{Axis, Button, Gamepad};
use sdl3::sensor::SensorType;
use serde::Serialize;
use tauri::ipc::Channel;

/// One change, as the page receives it (`{"t":"button","id":3,"index":0,"value":1,"time":1234.5}`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum GamepadEvent {
    #[serde(rename_all = "camelCase")]
    Connect {
        id: u32,
        name: String,
        vendor: u16,
        product: u16,
        /// 0 generic, 1 Xbox, 2 PlayStation, 3 Switch (`native/input`'s `family_of`).
        family: u8,
        sensors: bool,
        rumble: bool,
        trigger_rumble: bool,
        led: bool,
    },
    Disconnect { id: u32 },
    Button { id: u32, index: u8, value: f32, time: f64 },
    Axis { id: u32, index: u8, value: f32, time: f64 },
    Sensor { id: u32, kind: &'static str, x: f32, y: f32, z: f32, time: f64 },
}

/// Starts streaming gamepad events to `on_event`, replacing any previous listener. Pads already
/// open are announced (`connect`, then any held buttons and off-centre axes) straight away.
#[tauri::command]
pub fn myco_gamepad_listen(on_event: Channel<Vec<GamepadEvent>>) -> Result<(), String> {
    send(Command::Listen(on_event))
}

/// Rumbles a pad's low- and high-frequency motors (0..1) for `duration_ms`; 0, 0 stops it.
#[tauri::command]
pub fn myco_gamepad_rumble(id: u32, low: f32, high: f32, duration_ms: u32) -> Result<(), String> {
    send(Command::Rumble { id, low, high, duration_ms })
}

/// Rumbles a pad's trigger motors (0..1) for `duration_ms`, where it has them (Xbox One and later).
#[tauri::command]
pub fn myco_gamepad_trigger_rumble(id: u32, left: f32, right: f32, duration_ms: u32) -> Result<(), String> {
    send(Command::TriggerRumble { id, left, right, duration_ms })
}

/// Sets a pad's light (DualShock 4 and DualSense light bars, some third-party pads).
#[tauri::command]
pub fn myco_gamepad_set_led(id: u32, r: u8, g: u8, b: u8) -> Result<(), String> {
    send(Command::Led { id, r, g, b })
}

/// Turns a pad's gyroscope and accelerometer events on or off (off by default: they arrive at
/// hundreds of hertz).
#[tauri::command]
pub fn myco_gamepad_sensors(id: u32, enabled: bool) -> Result<(), String> {
    send(Command::Sensors { id, enabled })
}

enum Command {
    Listen(Channel<Vec<GamepadEvent>>),
    Rumble { id: u32, low: f32, high: f32, duration_ms: u32 },
    TriggerRumble { id: u32, left: f32, right: f32, duration_ms: u32 },
    Led { id: u32, r: u8, g: u8, b: u8 },
    Sensors { id: u32, enabled: bool },
}

/// The SDL thread's command queue, started on first use; an error if SDL couldn't start.
static THREAD: OnceLock<Result<Sender<Command>, String>> = OnceLock::new();

fn send(command: Command) -> Result<(), String> {
    let sender = THREAD.get_or_init(start).as_ref().map_err(|e| e.clone())?;
    sender.send(command).map_err(|_| "the gamepad thread has stopped".to_string())
}

/// Spawns the SDL thread and waits until SDL is up (or has failed to start).
fn start() -> Result<Sender<Command>, String> {
    let (commands, inbox) = mpsc::channel();
    let (ready, started) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("myco-gamepads".into())
        .spawn(move || run(inbox, ready))
        .map_err(|e| format!("couldn't start the gamepad thread: {e}"))?;
    started
        .recv()
        .map_err(|_| "the gamepad thread stopped while starting".to_string())??;
    Ok(commands)
}

/// How long the thread waits for an SDL event before checking for commands again.
const WAIT: Duration = Duration::from_millis(4);

fn run(inbox: Receiver<Command>, ready: mpsc::SyncSender<Result<(), String>>) {
    // SDL owns no window here, so it can't tell when the app has focus: the page decides.
    sdl3::hint::set("SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS", "1");
    let started = (|| {
        let sdl = sdl3::init().map_err(|e| e.to_string())?;
        let gamepads = sdl.gamepad().map_err(|e| e.to_string())?;
        // Haptics and sensors are optional: pads still work without them.
        let haptic = sdl.haptic().ok();
        let sensor = sdl.sensor().ok();
        let pump = sdl.event_pump().map_err(|e| e.to_string())?;
        Ok::<_, String>((sdl, gamepads, haptic, sensor, pump))
    })();
    let (_sdl, gamepads, _haptic, _sensor, mut pump) = match started {
        Ok(parts) => {
            let _ = ready.send(Ok(()));
            parts
        }
        Err(e) => {
            let _ = ready.send(Err(format!("SDL couldn't start gamepads: {e}")));
            return;
        }
    };

    let mut state = State { pads: HashMap::new(), listener: None, batch: Vec::new() };
    loop {
        loop {
            match inbox.try_recv() {
                Ok(command) => state.command(command),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }
        if let Some(event) = pump.wait_event_timeout(WAIT) {
            state.event(&gamepads, event);
            while let Some(event) = pump.poll_event() {
                state.event(&gamepads, event);
            }
        }
        state.flush();
    }
}

struct State {
    pads: HashMap<u32, Gamepad>,
    listener: Option<Channel<Vec<GamepadEvent>>>,
    batch: Vec<GamepadEvent>,
}

impl State {
    fn flush(&mut self) {
        if self.batch.is_empty() {
            return;
        }
        let batch = std::mem::take(&mut self.batch);
        if let Some(listener) = &self.listener {
            if listener.send(batch).is_err() {
                self.listener = None; // the page went away
            }
        }
    }

    fn command(&mut self, command: Command) {
        let unit = |v: f32| (v.clamp(0.0, 1.0) * 65535.0).round() as u16;
        match command {
            Command::Listen(channel) => {
                self.flush(); // what's queued belongs to the old listener
                self.listener = Some(channel);
                let now = now_ms();
                let mut ids: Vec<u32> = self.pads.keys().copied().collect();
                ids.sort_unstable();
                for id in ids {
                    let pad = &self.pads[&id];
                    self.batch.push(connect_event(id, pad));
                    current_state(id, pad, now, &mut self.batch);
                }
                self.flush();
            }
            Command::Rumble { id, low, high, duration_ms } => {
                if let Some(pad) = self.pads.get_mut(&id) {
                    let _ = pad.set_rumble(unit(low), unit(high), duration_ms);
                }
            }
            Command::TriggerRumble { id, left, right, duration_ms } => {
                if let Some(pad) = self.pads.get_mut(&id) {
                    let _ = pad.set_rumble_triggers(unit(left), unit(right), duration_ms);
                }
            }
            Command::Led { id, r, g, b } => {
                if let Some(pad) = self.pads.get_mut(&id) {
                    let _ = pad.set_led(r, g, b);
                }
            }
            Command::Sensors { id, enabled } => {
                if let Some(pad) = self.pads.get(&id) {
                    for kind in [SensorType::Gyroscope, SensorType::Accelerometer] {
                        // SAFETY: `pad` is an open gamepad.
                        if unsafe { pad.has_sensor(kind) } {
                            let _ = pad.sensor_set_enabled(kind, enabled);
                        }
                    }
                }
            }
        }
    }

    fn event(&mut self, gamepads: &sdl3::GamepadSubsystem, event: Event) {
        match event {
            Event::GamepadAdded { which, .. } => {
                let id = which.raw();
                if self.pads.contains_key(&id) {
                    return;
                }
                if let Ok(pad) = gamepads.open(which) {
                    self.batch.push(connect_event(id, &pad));
                    current_state(id, &pad, now_ms(), &mut self.batch);
                    self.pads.insert(id, pad);
                }
            }
            Event::GamepadRemoved { which, .. } => {
                if self.pads.remove(&which.raw()).is_some() {
                    self.batch.push(GamepadEvent::Disconnect { id: which.raw() });
                }
            }
            Event::GamepadButtonDown { timestamp, which, button } => self.button(which.raw(), button, 1.0, timestamp),
            Event::GamepadButtonUp { timestamp, which, button } => self.button(which.raw(), button, 0.0, timestamp),
            Event::GamepadAxisMotion { timestamp, which, axis, value } => {
                let id = which.raw();
                if self.pads.contains_key(&id) {
                    self.batch.push(axis_event(id, axis, value, ms(timestamp)));
                }
            }
            Event::GamepadSensorUpdated { timestamp, which, sensor, data } => {
                let id = which.raw();
                let kind = match sensor {
                    SensorType::Gyroscope => "gyro",
                    SensorType::Accelerometer => "accel",
                    _ => return,
                };
                if self.pads.contains_key(&id) {
                    let [x, y, z] = data;
                    self.batch.push(GamepadEvent::Sensor { id, kind, x, y, z, time: ms(timestamp) });
                }
            }
            _ => {}
        }
    }

    fn button(&mut self, id: u32, button: Button, value: f32, timestamp: u64) {
        if let (true, Some(index)) = (self.pads.contains_key(&id), button_index(button)) {
            self.batch.push(GamepadEvent::Button { id, index, value, time: ms(timestamp) });
        }
    }
}

fn connect_event(id: u32, pad: &Gamepad) -> GamepadEvent {
    let name = pad.name().unwrap_or_default();
    let vendor = pad.vendor_id().unwrap_or(0);
    let product = pad.product_id().unwrap_or(0);
    // SAFETY: `pad` is an open gamepad; these read its properties.
    let (sensors, rumble, trigger_rumble, led) = unsafe {
        (
            pad.has_sensor(SensorType::Gyroscope) || pad.has_sensor(SensorType::Accelerometer),
            pad.has_rumble(),
            pad.has_rumble_triggers(),
            pad.has_led(),
        )
    };
    GamepadEvent::Connect { id, family: family_of(vendor, &name), name, vendor, product, sensors, rumble, trigger_rumble, led }
}

/// A pad's held buttons and off-centre axes, so a listener starts from its real state.
fn current_state(id: u32, pad: &Gamepad, time: f64, out: &mut Vec<GamepadEvent>) {
    for button in BUTTONS {
        if let (true, Some(index)) = (pad.button(button), button_index(button)) {
            out.push(GamepadEvent::Button { id, index, value: 1.0, time });
        }
    }
    for axis in [Axis::LeftX, Axis::LeftY, Axis::RightX, Axis::RightY, Axis::TriggerLeft, Axis::TriggerRight] {
        let value = pad.axis(axis);
        if value != 0 {
            out.push(axis_event(id, axis, value, time));
        }
    }
}

/// The buttons with a wire index, for [`current_state`].
const BUTTONS: [Button; 21] = [
    Button::South,
    Button::East,
    Button::West,
    Button::North,
    Button::LeftShoulder,
    Button::RightShoulder,
    Button::Back,
    Button::Start,
    Button::LeftStick,
    Button::RightStick,
    Button::DPadUp,
    Button::DPadDown,
    Button::DPadLeft,
    Button::DPadRight,
    Button::Guide,
    Button::Misc1,
    Button::RightPaddle1,
    Button::LeftPaddle1,
    Button::RightPaddle2,
    Button::LeftPaddle2,
    Button::Touchpad,
];

/// A button's wire index; `None` for the ones the engine doesn't name (misc2–misc6).
fn button_index(button: Button) -> Option<u8> {
    Some(match button {
        Button::South => 0,
        Button::East => 1,
        Button::West => 2,
        Button::North => 3,
        Button::LeftShoulder => 4,
        Button::RightShoulder => 5,
        Button::Back => 8,
        Button::Start => 9,
        Button::LeftStick => 10,
        Button::RightStick => 11,
        Button::DPadUp => 12,
        Button::DPadDown => 13,
        Button::DPadLeft => 14,
        Button::DPadRight => 15,
        Button::Guide => 16,
        Button::Misc1 => 17,
        Button::RightPaddle1 => 18,
        Button::LeftPaddle1 => 19,
        Button::RightPaddle2 => 20,
        Button::LeftPaddle2 => 21,
        Button::Touchpad => 22,
        _ => return None,
    })
}

/// Sticks become axes 0..3 in -1..1 (+Y down, as SDL reports them); triggers become buttons 6/7 in 0..1.
fn axis_event(id: u32, axis: Axis, value: i16, time: f64) -> GamepadEvent {
    let unit = (value as f32 / 32767.0).clamp(-1.0, 1.0);
    let stick = |index| GamepadEvent::Axis { id, index, value: unit, time };
    let trigger = |index| GamepadEvent::Button { id, index, value: unit.max(0.0), time };
    match axis {
        Axis::LeftX => stick(0),
        Axis::LeftY => stick(1),
        Axis::RightX => stick(2),
        Axis::RightY => stick(3),
        Axis::TriggerLeft => trigger(6),
        Axis::TriggerRight => trigger(7),
    }
}

/// SDL timestamps are nanoseconds.
fn ms(timestamp_ns: u64) -> f64 {
    timestamp_ns as f64 / 1_000_000.0
}

fn now_ms() -> f64 {
    // SAFETY: SDL is initialised on this thread; SDL_GetTicksNS has no other requirement.
    ms(unsafe { sdl3::sys::timer::SDL_GetTicksNS() })
}

/// The controller family: 0 generic, 1 Xbox, 2 PlayStation, 3 Switch. The same rules as
/// `family_of` in native/input/crates/input-map (duplicated so this file stands alone).
pub fn family_of(vendor: u16, name: &str) -> u8 {
    match vendor {
        0x045e => return 1,
        0x054c => return 2,
        0x057e => return 3,
        _ => {}
    }
    let name = name.to_ascii_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| name.contains(w));
    if has(&["xbox", "xinput", "x-box"]) {
        1
    } else if has(&["dualshock", "dualsense", "playstation", "ps3", "ps4", "ps5"]) {
        2
    } else if has(&["pro controller", "joy-con", "joycon", "nintendo", "switch"]) {
        3
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_serialise_as_the_page_reads_them() {
        let connect = GamepadEvent::Connect {
            id: 3,
            name: "Pad".into(),
            vendor: 0x054c,
            product: 0x0ce6,
            family: 2,
            sensors: true,
            rumble: true,
            trigger_rumble: false,
            led: true,
        };
        assert_eq!(
            serde_json::to_string(&connect).unwrap(),
            r#"{"t":"connect","id":3,"name":"Pad","vendor":1356,"product":3302,"family":2,"sensors":true,"rumble":true,"triggerRumble":false,"led":true}"#
        );
        assert_eq!(serde_json::to_string(&GamepadEvent::Disconnect { id: 3 }).unwrap(), r#"{"t":"disconnect","id":3}"#);
        assert_eq!(
            serde_json::to_string(&GamepadEvent::Button { id: 1, index: 6, value: 0.5, time: 12.25 }).unwrap(),
            r#"{"t":"button","id":1,"index":6,"value":0.5,"time":12.25}"#
        );
        assert_eq!(
            serde_json::to_string(&GamepadEvent::Axis { id: 1, index: 1, value: -1.0, time: 2.0 }).unwrap(),
            r#"{"t":"axis","id":1,"index":1,"value":-1.0,"time":2.0}"#
        );
        assert_eq!(
            serde_json::to_string(&GamepadEvent::Sensor { id: 1, kind: "gyro", x: 0.5, y: 0.0, z: -0.25, time: 1.0 }).unwrap(),
            r#"{"t":"sensor","id":1,"kind":"gyro","x":0.5,"y":0.0,"z":-0.25,"time":1.0}"#
        );
    }

    #[test]
    fn axes_and_triggers() {
        assert_eq!(axis_event(1, Axis::LeftY, 32767, 0.0), GamepadEvent::Axis { id: 1, index: 1, value: 1.0, time: 0.0 });
        assert_eq!(axis_event(1, Axis::RightX, -32768, 0.0), GamepadEvent::Axis { id: 1, index: 2, value: -1.0, time: 0.0 });
        assert_eq!(axis_event(1, Axis::TriggerRight, 32767, 0.0), GamepadEvent::Button { id: 1, index: 7, value: 1.0, time: 0.0 });
        assert_eq!(ms(1_500_000), 1.5);
    }

    #[test]
    fn button_indices_are_the_wire_order() {
        let indices: Vec<u8> = BUTTONS.iter().filter_map(|b| button_index(*b)).collect();
        assert_eq!(indices, [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
        assert_eq!(button_index(Button::Misc2), None);
    }

    #[test]
    fn sdl_starts_on_its_own_thread() {
        // Commands for pads that aren't open are ignored; this one only needs the thread up.
        assert_eq!(myco_gamepad_sensors(u32::MAX, false), Ok(()));
        assert_eq!(myco_gamepad_rumble(u32::MAX, 1.0, 1.0, 10), Ok(()));
    }

    #[test]
    fn families() {
        assert_eq!(family_of(0x045e, ""), 1);
        assert_eq!(family_of(0x0f0d, "HORI DualShock 4"), 2);
        assert_eq!(family_of(0x2dc8, "8BitDo Pro Controller"), 3);
        assert_eq!(family_of(0x2dc8, "8BitDo SN30"), 0);
    }
}
