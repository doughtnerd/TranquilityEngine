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
        // Quitting destroys the other window and lets the app end with its last window: exiting with
        // a window still open makes WebView2 log "Failed to unregister class Chrome_WidgetWin_0".
        .on_window_event(|window, event| {
            let other = |label: &str| window.app_handle().get_webview_window(label);
            match (window.label(), event) {
                ("main", WindowEvent::Destroyed) => {
                    if let Some(projects) = other("projects") {
                        let _ = projects.destroy();
                    }
                }
                ("projects", WindowEvent::CloseRequested { api, .. }) => match other("main") {
                    Some(editor) if editor.is_visible().unwrap_or(false) => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    Some(editor) => {
                        let _ = editor.destroy(); // hidden, with no project open
                    }
                    None => {}
                },
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
