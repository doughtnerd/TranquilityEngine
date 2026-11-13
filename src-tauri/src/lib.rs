use std::sync::atomic::{AtomicU32, Ordering};

use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WindowEvent};

/// The editor window's label (tauri.conf.json, the capabilities, `EDITOR_WINDOW` in editorWindowStart.ts).
const EDITOR_WINDOW: &str = "main";

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
        .invoke_handler(tauri::generate_handler![create_editor_window])
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
