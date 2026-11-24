mod game_build;
mod gamepad;

use std::sync::atomic::{AtomicU32, Ordering};

use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
use tauri::{AppHandle, DragDropEvent, Manager, WebviewUrl, WebviewWindow, WindowEvent};
use tauri_plugin_fs::FsExt;

/// The editor window's label (tauri.conf.json, the capabilities, `EDITOR_WINDOW` in editorWindowStart.ts).
const EDITOR_WINDOW: &str = "main";

/// The Audio Studio's window label (ADR 0341; tauri.conf.json, the capabilities, `create_studio_window`).
const STUDIO_WINDOW: &str = "studio";

/// Detached panel windows (ADR 0174) are labelled `panel-window-<n>`.
const PANEL_WINDOW_PREFIX: &str = "panel-window-";

static PANEL_WINDOWS: AtomicU32 = AtomicU32::new(0);

/// Creates the hidden editor window from its tauri.conf.json entry (`create: false`, ADR 0082). The
/// Projects window calls this instead of creating it from JavaScript, because only a window built
/// in Rust can carry an `on_new_window` handler: the editor's detached panel windows (ADR 0174) are
/// opened with `window.open` and must stay linked to it. Async so it runs off the main thread
/// (building a window in a synchronous command deadlocks on Windows). Does nothing if it exists.
#[tauri::command]
async fn create_editor_window(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window(EDITOR_WINDOW).is_some() {
        return Ok(());
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == EDITOR_WINDOW)
        .cloned()
        .ok_or_else(|| format!("tauri.conf.json has no \"{EDITOR_WINDOW}\" window"))?;
    let opener = app.clone();
    WebviewWindowBuilder::from_config(&app, &config)
        .map_err(|e| e.to_string())?
        .on_new_window(move |url, features| open_panel_window(&opener, url, features))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Opens the Audio Studio's window (ADR 0341) from its tauri.conf.json entry (`create: false`), or shows,
/// unminimises and focuses it when it is open. The editor's Window > Audio Studio and Open in Audio
/// Studio call this, then hand the Studio the project over Tauri events (`myco://studio-open`). The
/// Studio is its own app: it stays open when the editor closes, and the app ends with its last window.
/// Async for the same reason as `create_editor_window`. Resolves to whether it created the window.
#[tauri::command]
async fn create_studio_window(app: AppHandle) -> Result<bool, String> {
    if let Some(studio) = app.get_webview_window(STUDIO_WINDOW) {
        let _ = studio.unminimize();
        studio.show().map_err(|e| e.to_string())?;
        studio.set_focus().map_err(|e| e.to_string())?;
        return Ok(false);
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == STUDIO_WINDOW)
        .cloned()
        .ok_or_else(|| format!("tauri.conf.json has no \"{STUDIO_WINDOW}\" window"))?;
    WebviewWindowBuilder::from_config(&app, &config)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// This process's id, for the project lock files (`.myco/locks/<app>.json`, ADR 0341).
#[tauri::command]
fn process_id() -> u32 {
    std::process::id()
}

/// The editor's `window.open` (ADR 0174, detached panel windows): a Tauri window built with the
/// opener's window features, so the webview is related to the editor's (same process / environment /
/// configuration), `window.opener` is set and the editor's scripts render into it same-origin. The
/// page is a static `panel-window.html`; the editor's JavaScript does all the rendering, so the child
/// needs no IPC and no capability. Titled from the page; closed with the editor window (on_window_event).
///
/// Verified against tauri 2.12.5 / tauri-runtime-wry 2.12.3 / wry 0.57.1 source: `window_features`
/// applies the requested position and size and links the webview on every desktop platform
/// (`with_related_view` on Linux/WebKitGTK, `with_environment` on Windows/WebView2,
/// `with_webview_configuration` on macOS/WKWebView). Compiled (`cargo check`) on Linux only; not yet
/// run on Windows or macOS.
fn open_panel_window(
    app: &AppHandle,
    url: tauri::Url,
    features: tauri::webview::NewWindowFeatures,
) -> NewWindowResponse<tauri::Wry> {
    let Some(editor) = app.get_webview_window(EDITOR_WINDOW) else {
        return NewWindowResponse::Deny;
    };
    // Only the editor's own pages (same origin as the editor window); anything else is refused.
    let same_origin = editor
        .url()
        .map(|own| own.origin() == url.origin())
        .unwrap_or(false);
    if !same_origin {
        return NewWindowResponse::Deny;
    }
    let label = format!(
        "{PANEL_WINDOW_PREFIX}{}",
        PANEL_WINDOWS.fetch_add(1, Ordering::Relaxed) + 1
    );
    // The webview loads the requested URL itself once handed back; the builder's own URL is a placeholder.
    let placeholder = WebviewUrl::External("about:blank".parse().expect("valid URL"));
    let builder = WebviewWindowBuilder::new(app, label, placeholder)
        .window_features(features)
        .title("Myco Engine")
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        });
    match own_by_editor(builder, &editor).and_then(|b| b.build()) {
        Ok(window) => NewWindowResponse::Create { window },
        Err(err) => {
            log::error!("couldn't open a detached panel window: {err}");
            NewWindowResponse::Deny
        }
    }
}

/// On Windows the panel window is owned by the editor (stays above it, hides when it is minimised,
/// destroyed with it). Elsewhere it stays independent (macOS child windows move with their parent,
/// and GTK transient windows are dialogs); on_window_event closes it with the editor.
fn own_by_editor<'a>(
    builder: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
    editor: &WebviewWindow,
) -> tauri::Result<WebviewWindowBuilder<'a, tauri::Wry, AppHandle>> {
    #[cfg(windows)]
    return builder.owner(editor);
    #[cfg(not(windows))]
    {
        let _ = editor;
        Ok(builder)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Remembers the folders the user granted (project folders picked in the dialog) across
        // restarts (ADR 0116). Registered after the fs plugin, whose scope it restores.
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_opener::init())
        // The debug link's listeners (ADR 0376, 0379), opened by the editor's page.
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
        // Two windows (ADR 0059): "projects" shows at start-up and, once it has painted, creates the
        // editor window ("main", `create: false`), which loads hidden (ADR 0082); they take turns. Closing the editor quits; so does closing the Projects
        // window while the editor is hidden. (The editor's own guard asks about unsaved changes first.)
        // Quitting destroys the other window and lets the app end with its last window: exiting with
        // a window still open makes WebView2 log "Failed to unregister class Chrome_WidgetWin_0".
        .invoke_handler(tauri::generate_handler![
            create_editor_window,
            create_studio_window,
            process_id,
            // Native gamepads (ADR 0335).
            gamepad::myco_gamepad_listen,
            gamepad::myco_gamepad_rumble,
            gamepad::myco_gamepad_trigger_rumble,
            gamepad::myco_gamepad_set_led,
            gamepad::myco_gamepad_sensors,
            gamepad::myco_gamepad_trigger_effect,
            // The debug link's WebSocket listener (ADR 0379).
            debug_link_tauri::commands::myco_debuglink_listen_range,
            debug_link_tauri::commands::myco_debuglink_listen,
            debug_link_tauri::commands::myco_debuglink_send,
            debug_link_tauri::commands::myco_debuglink_close,
            debug_link_tauri::commands::myco_debuglink_interfaces,
            debug_link_tauri::commands::myco_debuglink_advertise,
            debug_link_tauri::commands::myco_debuglink_unadvertise,
            debug_link_tauri::commands::myco_debuglink_browse,
            debug_link_tauri::commands::myco_debuglink_browse_stop,
            // Desktop game builds from the editor with the host's toolchain (ADR 0406).
            game_build::myco_build_toolchain,
            game_build::myco_build_desktop_app
        ])
        .on_window_event(|window, event| {
            let other = |label: &str| window.app_handle().get_webview_window(label);
            match (window.label(), event) {
                ("main", WindowEvent::Destroyed) => {
                    if let Some(projects) = other("projects") {
                        let _ = projects.destroy();
                    }
                    // Detached panel windows (ADR 0174) go with the editor (its page's pagehide closes them too).
                    for (label, panel) in window.app_handle().webview_windows() {
                        if label.starts_with(PANEL_WINDOW_PREFIX) {
                            let _ = panel.destroy();
                        }
                    }
                }
                // The launcher (ADR 0380) handed a project to the Studio and hid: it shows again when the Studio
                // window closes while the editor isn't showing, so the app never runs with no window to see.
                (STUDIO_WINDOW, WindowEvent::Destroyed) => {
                    let editor_showing = other(EDITOR_WINDOW).is_some_and(|w| w.is_visible().unwrap_or(false));
                    if let Some(projects) = other("projects") {
                        if !editor_showing {
                            let _ = projects.show();
                            let _ = projects.set_focus();
                        }
                    }
                }
                // ADR 0408: a take file dropped on the launcher joins Recorded takes and opens as a takes workspace of
                // its folder, which lists the folder and writes the take's notes beside it. The fs plugin scopes only
                // the dropped file, so its folder (not below it) is allowed too; persisted-scope keeps it.
                ("projects", WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. })) => {
                    for path in paths {
                        let is_take = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("sporesample"));
                        if let (true, Some(folder)) = (is_take && path.is_file(), path.parent()) {
                            let _ = window.app_handle().fs_scope().allow_directory(folder, false);
                        }
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
                    None => {} // not created yet: the app ends with this window (the editor's page checks too)
                },
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
