//! The debug link's Tauri commands, shared by the editor's and the Studio's shells (ADR 0379, 0403; the
//! commands and their contract are documented in `commands`). Plain commands, not a plugin: a shell calls
//! `.manage(DebugLinkListeners::default())` and lists `debug_link_tauri::commands::{myco_debuglink_listen_range,
//! myco_debuglink_listen, myco_debuglink_send, myco_debuglink_close, myco_debuglink_interfaces}` in its
//! `generate_handler!`. Discovery (ADR 0403, `native/debug-discovery`) adds `.manage(DebugDiscovery::default())` and
//! `myco_debuglink_advertise`, `myco_debuglink_unadvertise`, `myco_debuglink_browse` and `myco_debuglink_browse_stop`.
pub mod commands;

pub use commands::{DebugDiscovery, DebugLinkListeners};
