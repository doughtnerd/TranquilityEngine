// The standalone Audio Studio (ADR 0341): one window, "studio", loading the same `studio.html` the editor's
// app opens as its Studio window. The page does everything (opening project folders, watching them, the
// lock files); this shell only hosts it with the same plugins the editor's shell has.

/// This process's id, for the project lock files (`.myco/locks/studio.json`, ADR 0341). Same command as
/// the editor's shell (src-tauri/src/lib.rs), so the page needn't know which app hosts it.
#[tauri::command]
fn process_id() -> u32 {
    std::process::id()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Remembers the project folders the user granted across restarts (ADR 0116), after the fs plugin.
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_opener::init())
        // The debug link's listeners (ADR 0403), opened by the Studio's page.
        .manage(debug_link_tauri::DebugLinkListeners::default())
        .manage(debug_link_tauri::DebugDiscovery::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            process_id,
            // The debug link's WebSocket listener (ADR 0379, 0403), the same commands as the editor's shell.
            debug_link_tauri::commands::myco_debuglink_listen_range,
            debug_link_tauri::commands::myco_debuglink_listen,
            debug_link_tauri::commands::myco_debuglink_send,
            debug_link_tauri::commands::myco_debuglink_close,
            debug_link_tauri::commands::myco_debuglink_interfaces,
            debug_link_tauri::commands::myco_debuglink_advertise,
            debug_link_tauri::commands::myco_debuglink_unadvertise,
            debug_link_tauri::commands::myco_debuglink_browse,
            debug_link_tauri::commands::myco_debuglink_browse_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
