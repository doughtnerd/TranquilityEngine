//! The desktop editor's debug link listener (ADR 0376, 0379): a page can't open a server socket, so
//! the editor's listening `websocket` transport (`src/editor/debugLink/tauriListener.ts`) asks this
//! module to listen for it. The WebSocket server is `native/ws-listener` (tungstenite on std
//! threads), which builds and tests without Tauri; this file only turns it into commands.
//!
//! - `myco_debuglink_listen(host, port, path, events)` binds and resolves to `{ id, port }`, or
//!   rejects with why ("port 7790 is already in use"). Events (accept, message, close, error) come
//!   on the `events` channel as raw bytes (`myco_ws_listener::wire`).
//! - `myco_debuglink_send` takes a raw outbox body (sends and closes, in order) and the listener id
//!   in the `myco-listener` header.
//! - `myco_debuglink_close(id)` stops a listener, frees its port and closes its connections.
//!
//! A window that listens on a port it already listens on replaces its old listener, so a reloaded
//! page (or a close that arrives after the next listen) never finds its own port taken.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use myco_ws_listener::{Limits, Listener, wire};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::{State, Webview};

struct Owned {
    window: String,
    port: u16,
    listener: Listener,
}

/// The listeners pages opened, by id.
#[derive(Default)]
pub struct DebugLinkListeners {
    next_id: AtomicU32,
    listeners: Mutex<HashMap<u32, Owned>>,
}

#[derive(Serialize)]
pub struct Listening {
    id: u32,
    port: u16,
}

#[tauri::command]
pub fn myco_debuglink_listen(
    webview: Webview,
    state: State<'_, DebugLinkListeners>,
    host: String,
    port: u16,
    path: String,
    events: Channel<InvokeResponseBody>,
) -> Result<Listening, String> {
    let window = webview.label().to_string();
    let replaced: Vec<Owned> = {
        let mut listeners = state.listeners.lock().unwrap();
        let ids: Vec<u32> = listeners
            .iter()
            .filter(|(_, o)| o.window == window && o.port == port && port != 0)
            .map(|(id, _)| *id)
            .collect();
        ids.into_iter()
            .filter_map(|id| listeners.remove(&id))
            .collect()
    };
    drop(replaced); // dropping closes them and frees the port before binding
    let sink = Arc::new(move |event: wire::Event| {
        let _ = events.send(InvokeResponseBody::Raw(wire::encode_event(&event)));
    });
    let listener = Listener::bind(&host, port, &path, Limits::default(), sink)?;
    let bound = listener.port();
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    state.listeners.lock().unwrap().insert(
        id,
        Owned {
            window,
            port: bound,
            listener,
        },
    );
    Ok(Listening { id, port: bound })
}

#[tauri::command]
pub fn myco_debuglink_send(
    state: State<'_, DebugLinkListeners>,
    request: Request<'_>,
) -> Result<(), String> {
    let id: u32 = request
        .headers()
        .get("myco-listener")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or("myco_debuglink_send needs a myco-listener header")?;
    let InvokeBody::Raw(body) = request.body() else {
        return Err("myco_debuglink_send takes a raw body".into());
    };
    let records = wire::decode_outbox(body)?;
    if let Some(owned) = state.listeners.lock().unwrap().get(&id) {
        owned.listener.apply(records);
    }
    Ok(())
}

#[tauri::command]
pub fn myco_debuglink_close(state: State<'_, DebugLinkListeners>, id: u32) {
    let closed = state.listeners.lock().unwrap().remove(&id);
    drop(closed);
}
