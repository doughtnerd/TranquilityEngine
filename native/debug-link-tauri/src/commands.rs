//! The debug link's listener commands (ADR 0376, 0379, 0380), shared by the editor's and the Studio's
//! Tauri shells: a page can't open a server socket, so the listening `websocket` transport
//! (`src/engine/debugLink/tauriListener.ts`) asks these commands to listen for it. A shell calls
//! `.manage(DebugLinkListeners::default())` and lists `myco_debuglink_listen_range`,
//! `myco_debuglink_listen`, `myco_debuglink_send` and `myco_debuglink_close` in `generate_handler!`
//! (as `debug_link_tauri::...`). The WebSocket server is `native/ws-listener` (tungstenite on std
//! threads), which builds and tests without Tauri; this file only turns it into commands.
//!
//! - `myco_debuglink_listen_range(host, firstPort, count, path, events)` binds the first free port of
//!   `firstPort .. firstPort + count - 1` (a `firstPort` of 0 means any free port, `count` 1) and
//!   resolves to `{ id, port }` with the port it got, or rejects with why.
//! - `myco_debuglink_listen(host, port, path, events)` is the single-port form: it binds and resolves to `{ id, port }`, or
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

use myco_ws_listener::{Limits, Listener, Sink, wire};
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
    let listener = Listener::bind(&host, port, &path, Limits::default(), event_sink(events))?;
    Ok(register(&state, window, listener.port(), listener))
}

#[tauri::command]
pub fn myco_debuglink_listen_range(
    webview: Webview,
    state: State<'_, DebugLinkListeners>,
    host: String,
    first_port: u16,
    count: u16,
    path: String,
    events: Channel<InvokeResponseBody>,
) -> Result<Listening, String> {
    let window = webview.label().to_string();
    let count = if first_port == 0 { 1 } else { count };
    let last = (first_port as u32 + count.max(1) as u32 - 1).min(u16::MAX as u32);
    let replaced: Vec<Owned> = {
        // A reloaded page listens on its old range again: drop its own listeners in the range first.
        let mut listeners = state.listeners.lock().unwrap();
        let ids: Vec<u32> = listeners
            .iter()
            .filter(|(_, o)| {
                first_port != 0
                    && o.window == window
                    && (first_port as u32..=last).contains(&(o.port as u32))
            })
            .map(|(id, _)| *id)
            .collect();
        ids.into_iter()
            .filter_map(|id| listeners.remove(&id))
            .collect()
    };
    drop(replaced);
    let (listener, port) = Listener::bind_range(
        &host,
        first_port,
        count,
        &path,
        Limits::default(),
        event_sink(events),
    )?;
    Ok(register(&state, window, port, listener))
}

fn event_sink(events: Channel<InvokeResponseBody>) -> Sink {
    Arc::new(move |event: wire::Event| {
        let _ = events.send(InvokeResponseBody::Raw(wire::encode_event(&event)));
    })
}

fn register(
    state: &DebugLinkListeners,
    window: String,
    port: u16,
    listener: Listener,
) -> Listening {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    state.listeners.lock().unwrap().insert(
        id,
        Owned {
            window,
            port,
            listener,
        },
    );
    Listening { id, port }
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

/// One network address of this machine, in the shape of Node's `os.networkInterfaces()` entries
/// (`NetworkInterfaceAddress` in `src/engine/debugLink/pairing/address.ts`).
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct InterfaceAddress {
    address: String,
    family: &'static str,
    internal: bool,
}

/// The pure part of `myco_debuglink_interfaces`: the primary address (when one was found) first, then loopback,
/// which is marked internal. An unspecified or loopback primary is no address.
pub fn interface_list(primary: Option<std::net::Ipv4Addr>) -> Vec<InterfaceAddress> {
    let mut list = Vec::new();
    if let Some(ip) = primary.filter(|ip| !ip.is_unspecified() && !ip.is_loopback()) {
        list.push(InterfaceAddress { address: ip.to_string(), family: "IPv4", internal: false });
    }
    list.push(InterfaceAddress { address: "127.0.0.1".into(), family: "IPv4", internal: true });
    list
}

/// The address the OS would use to reach the internet: a UDP socket `connect`ed to a public address picks the route
/// (and so the adapter) without sending a packet. None when there is no route (offline), or the route is IPv6.
fn primary_ipv4() -> Option<std::net::Ipv4Addr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) => Some(ip),
        std::net::IpAddr::V6(_) => None,
    }
}

/// This machine's IPv4 addresses for the pairing code (ADR 0380 "Address code"): the primary address, which is the
/// adapter the OS routes outward through, and loopback (internal). Std offers no adapter list, so a second adapter
/// (Wi-Fi beside Ethernet) or a VPN that isn't the default route doesn't appear; a person can type the full address.
#[tauri::command]
pub fn myco_debuglink_interfaces() -> Vec<InterfaceAddress> {
    interface_list(primary_ipv4())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn the_primary_address_comes_first_then_loopback_as_internal() {
        let list = interface_list(Some(Ipv4Addr::new(192, 168, 1, 20)));
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].address.as_str(), list[0].family, list[0].internal), ("192.168.1.20", "IPv4", false));
        assert_eq!((list[1].address.as_str(), list[1].internal), ("127.0.0.1", true));
    }

    #[test]
    fn no_route_or_an_unspecified_address_leaves_loopback_only() {
        for primary in [None, Some(Ipv4Addr::UNSPECIFIED), Some(Ipv4Addr::LOCALHOST)] {
            let list = interface_list(primary);
            assert_eq!(list, vec![InterfaceAddress { address: "127.0.0.1".into(), family: "IPv4", internal: true }]);
        }
    }
}
