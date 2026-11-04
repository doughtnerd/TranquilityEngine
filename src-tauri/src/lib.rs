use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
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
        // Two windows (ADR 0059): "projects" shows at start-up while the editor window ("main")
        // loads hidden, and they take turns. Closing the editor quits; so does closing the Projects
        // window while the editor is hidden. (The editor's own guard asks about unsaved changes first.)
        .on_window_event(|window, event| match (window.label(), event) {
            ("main", WindowEvent::Destroyed) => window.app_handle().exit(0),
            ("projects", WindowEvent::CloseRequested { api, .. }) => {
                let editor_shown = window
                    .app_handle()
                    .get_webview_window("main")
                    .and_then(|w| w.is_visible().ok())
                    .unwrap_or(false);
                if editor_shown {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    window.app_handle().exit(0);
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
