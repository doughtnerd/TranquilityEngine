//! The debug link's Tauri commands, shared by the editor's and the Studio's shells (ADR 0379, 0380; the
//! commands and their contract are documented in `commands`). Plain commands, not a plugin: a shell calls
//! `.manage(DebugLinkListeners::default())` and lists `debug_link_tauri::commands::{myco_debuglink_listen_range,
//! myco_debuglink_listen, myco_debuglink_send, myco_debuglink_close}` in its `generate_handler!`.
pub mod commands;

pub use commands::DebugLinkListeners;
