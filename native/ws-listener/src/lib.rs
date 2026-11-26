//! A small WebSocket server for Myco's desktop editor (ADR 0379): the debug link (ADR 0376) listens
//! through it, because a page can't open a server socket. It moves binary messages and nothing
//! else; the page's WebSocket transport (`src/engine/net/transport/websocket.ts`) frames them, so
//! the protocol, limits and close rules stay in one place.
//!
//! Threads, not async: one accepts, one runs each connection. A connection thread reads with a
//! short timeout and writes what the page queued between reads, so a message waits at most
//! [`POLL`] to go out. Fine for a debug link (the editor polls every 33 ms); not a game server.
//!
//! The path works like the Node server's (ADR 0067): only upgrades to the listener's path are
//! accepted (the query is ignored), except that a listener at "/" accepts every path. Others get
//! HTTP 404.
use std::collections::HashMap;
use std::io::{self, ErrorKind};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::frame::CloseFrame;
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{Bytes, Error as WsError, Message, WebSocket};

pub mod wire;

pub use wire::{Event, Outgoing};

/// How long a connection thread waits for the peer before it sends what the page queued.
pub const POLL: Duration = Duration::from_millis(5);
/// How long the accept thread sleeps when nothing is waiting.
const ACCEPT_POLL: Duration = Duration::from_millis(10);
/// A peer that hasn't finished its handshake by then is dropped.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// After a local close, how long to wait for the peer's close frame.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(1);
/// A peer that takes none of what's been sent for this long is closed as too slow, even under the
/// backlog limit (the page may have stopped sending, or closed it and be waiting for nothing).
const STALL_TIMEOUT: Duration = Duration::from_secs(10);

/// Close codes (RFC 6455).
const GOING_AWAY: u16 = 1001;
const UNSUPPORTED: u16 = 1003;
const ABNORMAL: u16 = 1006;
const TOO_BIG: u16 = 1009;

/// What one listener accepts.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// The largest message from a peer, in bytes. A bigger one closes the connection (1009).
    pub max_message_bytes: usize,
    /// Bytes the page may queue for one connection before it's closed as too slow.
    pub max_backlog_bytes: usize,
}

impl Default for Limits {
    /// The page's transport checks its own, smaller limits (`websocket.ts`); these bound memory here.
    fn default() -> Self {
        Limits {
            max_message_bytes: 16 * 1024 * 1024,
            max_backlog_bytes: 8 * 1024 * 1024,
        }
    }
}

/// Where events go. Called from the listener's threads, in order per connection.
pub type Sink = Arc<dyn Fn(Event) + Send + Sync>;

enum Command {
    Send(Vec<u8>),
    /// Close with this code and reason; `report` when the page didn't ask for it (it gets a close event).
    Close {
        code: u16,
        reason: String,
        report: bool,
    },
}

struct Connection {
    commands: Sender<Command>,
    /// Bytes queued by the page and not yet written.
    queued: Arc<AtomicUsize>,
}

struct Shared {
    stop: AtomicBool,
    sink: Sink,
    path: String,
    limits: Limits,
    next_id: AtomicU32,
    connections: Mutex<HashMap<u32, Connection>>,
}

/// A WebSocket server bound to one address. Dropping it stops it and closes its connections.
pub struct Listener {
    shared: Arc<Shared>,
    accept: Option<JoinHandle<()>>,
    port: u16,
}

impl Listener {
    /// Binds `host:port` (port 0 picks one) and starts accepting upgrades to `path`. Fails at once
    /// when the address can't be bound: "port 7790 is already in use" and the like.
    pub fn bind(
        host: &str,
        port: u16,
        path: &str,
        limits: Limits,
        sink: Sink,
    ) -> Result<Listener, String> {
        let socket = TcpListener::bind((host, port)).map_err(|e| bind_error(host, port, &e))?;
        Listener::start(socket, path, limits, sink)
    }

    /// Starts accepting on an already bound socket.
    fn start(
        socket: TcpListener,
        path: &str,
        limits: Limits,
        sink: Sink,
    ) -> Result<Listener, String> {
        socket.set_nonblocking(true).map_err(|e| e.to_string())?;
        let port = socket.local_addr().map_err(|e| e.to_string())?.port();
        let shared = Arc::new(Shared {
            stop: AtomicBool::new(false),
            sink,
            path: if path.is_empty() {
                "/".into()
            } else {
                path.to_string()
            },
            limits,
            next_id: AtomicU32::new(1),
            connections: Mutex::new(HashMap::new()),
        });
        let accepting = shared.clone();
        let accept = thread::Builder::new()
            .name("myco-ws-accept".into())
            .spawn(move || accept_loop(socket, accepting))
            .map_err(|e| e.to_string())?;
        Ok(Listener {
            shared,
            accept: Some(accept),
            port,
        })
    }

    /// Binds the first free port of `first_port..first_port + count` on `host` and returns the listener
    /// with the port it got. A port in use moves on to the next; any other error fails at once. When
    /// every port is taken the error says so ("ports 7790-7799 are all in use"). `count` 0 binds nothing.
    pub fn bind_range(
        host: &str,
        first_port: u16,
        count: u16,
        path: &str,
        limits: Limits,
        sink: Sink,
    ) -> Result<(Listener, u16), String> {
        let last = (first_port as u32 + count as u32)
            .saturating_sub(1)
            .min(u16::MAX as u32) as u16;
        if count == 0 {
            return Err("no ports to try".into());
        }
        for port in first_port..=last {
            match TcpListener::bind((host, port)) {
                Ok(socket) => return Ok((Listener::start(socket, path, limits, sink)?, port)),
                Err(e) if e.kind() == ErrorKind::AddrInUse => continue,
                Err(e) => return Err(bind_error(host, port, &e)),
            }
        }
        if first_port == last {
            Err(format!("port {first_port} is already in use"))
        } else {
            Err(format!("ports {first_port}-{last} are all in use"))
        }
    }

    /// The bound port (the real one for port 0).
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Queues `data` as one binary message to `connection`. A connection that has gone is ignored
    /// (its close event is on its way); one whose queue is over the backlog limit is closed.
    pub fn send(&self, connection: u32, data: Vec<u8>) {
        let connections = self.shared.connections.lock().unwrap();
        let Some(c) = connections.get(&connection) else {
            return;
        };
        let queued = c.queued.fetch_add(data.len(), Ordering::AcqRel) + data.len();
        if queued > self.shared.limits.max_backlog_bytes {
            let _ = c.commands.send(Command::Close {
                code: TOO_BIG,
                reason: format!("too slow: {queued} bytes waiting to send"),
                report: true,
            });
            return;
        }
        let _ = c.commands.send(Command::Send(data));
    }

    /// Closes `connection` after what's already queued for it. No close event follows: the page
    /// asked for it.
    pub fn close_connection(&self, connection: u32, code: u16, reason: String) {
        if let Some(c) = self.shared.connections.lock().unwrap().remove(&connection) {
            let _ = c.commands.send(Command::Close {
                code,
                reason,
                report: false,
            });
        }
    }

    /// Applies one outbox (see [`wire`]) in order.
    pub fn apply(&self, records: Vec<Outgoing>) {
        for record in records {
            match record {
                Outgoing::Send { connection, data } => self.send(connection, data),
                Outgoing::Close {
                    connection,
                    code,
                    reason,
                } => self.close_connection(connection, code, reason),
            }
        }
    }

    /// Stops accepting, frees the port and closes every connection (1001). Returns once the port is
    /// free, so a new listener can bind it straight away.
    pub fn close(&mut self) {
        self.shared.stop.store(true, Ordering::Release);
        if let Some(accept) = self.accept.take() {
            let _ = accept.join();
        }
        for (_, c) in self.shared.connections.lock().unwrap().drain() {
            let _ = c.commands.send(Command::Close {
                code: GOING_AWAY,
                reason: "The listener closed.".into(),
                report: false,
            });
        }
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.close();
    }
}

fn bind_error(host: &str, port: u16, error: &io::Error) -> String {
    match error.kind() {
        ErrorKind::AddrInUse => format!("port {port} is already in use"),
        ErrorKind::AddrNotAvailable => format!("{host} isn't an address of this machine"),
        ErrorKind::PermissionDenied => format!("not allowed to listen on port {port}"),
        _ => error.to_string(),
    }
}

fn accept_loop(socket: TcpListener, shared: Arc<Shared>) {
    let mut failing = false;
    while !shared.stop.load(Ordering::Acquire) {
        match socket.accept() {
            Ok((stream, remote)) => {
                failing = false;
                let s = shared.clone();
                let _ = thread::Builder::new()
                    .name("myco-ws-connection".into())
                    .spawn(move || run_connection(stream, remote, s));
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::Interrupted => {
                thread::sleep(ACCEPT_POLL)
            }
            Err(e) => {
                // Out of file descriptors and the like: report once per run of failures, keep trying.
                if !failing {
                    (shared.sink)(Event::Error {
                        message: format!("accepting connections failed: {e}"),
                    });
                }
                failing = true;
                thread::sleep(ACCEPT_POLL * 10);
            }
        }
    }
}

/// Whether an upgrade to `uri_path` reaches a listener at `listen_path`.
fn path_matches(listen_path: &str, uri_path: &str) -> bool {
    listen_path == "/" || listen_path == uri_path
}

fn run_connection(stream: TcpStream, remote: SocketAddr, shared: Arc<Shared>) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT));
    let path = shared.path.clone();
    // The path the upgrade asked for, kept for the accept event (a listener at "/" serves several paths).
    let asked = Arc::new(Mutex::new(String::new()));
    let asked_in_check = asked.clone();
    #[allow(clippy::result_large_err)] // the error type is tungstenite's
    let check = move |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
        if path_matches(&path, request.uri().path()) {
            *asked_in_check.lock().unwrap() = request.uri().path().to_string();
            return Ok(response);
        }
        let mut refusal = ErrorResponse::new(Some("Not Found".into()));
        *refusal.status_mut() = tungstenite::http::StatusCode::NOT_FOUND;
        Err(refusal)
    };
    let config = WebSocketConfig::default()
        .max_message_size(Some(shared.limits.max_message_bytes))
        .max_frame_size(Some(shared.limits.max_message_bytes));
    let Ok(mut ws) = tungstenite::accept_hdr_with_config(stream, check, Some(config)) else {
        return;
    };
    if shared.stop.load(Ordering::Acquire) {
        let _ = ws.close(Some(close_frame(GOING_AWAY, "The listener closed.")));
        return;
    }
    let _ = ws.get_mut().set_read_timeout(Some(POLL));
    // Writes never block for long either: a peer that stops reading must not hold this thread,
    // or the backlog limit could never close it (see `pump`).
    let _ = ws.get_mut().set_write_timeout(Some(POLL));

    let id = shared.next_id.fetch_add(1, Ordering::Relaxed);
    let (commands, inbox) = mpsc::channel();
    let queued = Arc::new(AtomicUsize::new(0));
    shared.connections.lock().unwrap().insert(
        id,
        Connection {
            commands,
            queued: queued.clone(),
        },
    );
    let path = asked.lock().unwrap().clone();
    (shared.sink)(Event::Accept {
        connection: id,
        remote: remote.to_string(),
        path,
    });

    let ended = pump(&mut ws, id, &inbox, &queued, &shared);
    shared.connections.lock().unwrap().remove(&id);
    if let Some((code, reason)) = ended {
        (shared.sink)(Event::Close {
            connection: id,
            code,
            reason,
        });
    }
}

/// Runs a connection until it ends. Returns the close event to report, or None when the page (or
/// the listener) closed it.
fn pump(
    ws: &mut WebSocket<TcpStream>,
    id: u32,
    inbox: &Receiver<Command>,
    queued: &AtomicUsize,
    shared: &Shared,
) -> Option<(u16, String)> {
    // Set once this end has sent its close frame: wait for the peer's, then stop. The report, if any, goes with it.
    let mut closing: Option<(Instant, Option<(u16, String)>)> = None;
    // Set while tungstenite holds output the peer hasn't taken: since when. Nothing more is taken
    // from the inbox meanwhile, so `queued` keeps counting what waits and the backlog limit applies.
    let mut stalled: Option<Instant> = None;
    loop {
        if closing.is_none() {
            if let Some(since) = stalled {
                match ws.flush() {
                    Ok(()) => stalled = None,
                    Err(WsError::Io(e)) if would_block(&e) => {
                        let waiting = queued.load(Ordering::Acquire);
                        if waiting > shared.limits.max_backlog_bytes
                            || since.elapsed() > STALL_TIMEOUT
                        {
                            // Sending a close frame would stall too: just drop the connection.
                            return Some((
                                TOO_BIG,
                                format!("too slow: {waiting} bytes waiting to send"),
                            ));
                        }
                    }
                    Err(e) => return Some((ABNORMAL, format!("connection lost: {e}"))),
                }
            }
        }
        if closing.is_none() && stalled.is_none() {
            loop {
                match inbox.try_recv() {
                    Ok(Command::Send(data)) => {
                        queued.fetch_sub(data.len(), Ordering::AcqRel);
                        // `write` buffers the frame before it flushes, and a flush that would block
                        // keeps what it couldn't write, so a stall loses nothing.
                        let sent = ws
                            .write(Message::Binary(Bytes::from(data)))
                            .and_then(|()| ws.flush());
                        match sent {
                            Ok(()) => {}
                            Err(WsError::Io(e)) if would_block(&e) => {
                                stalled = Some(Instant::now());
                                break;
                            }
                            Err(e) => return Some((ABNORMAL, format!("connection lost: {e}"))),
                        }
                    }
                    Ok(Command::Close {
                        code,
                        reason,
                        report,
                    }) => {
                        let report = report.then(|| (code, reason.clone()));
                        let _ = ws.close(Some(close_frame(code, &reason)));
                        closing = Some((Instant::now(), report));
                        break;
                    }
                    // Disconnected: the listener was dropped without closing (it always closes first).
                    Err(TryRecvError::Disconnected) => {
                        let _ = ws.close(Some(close_frame(GOING_AWAY, "The listener closed.")));
                        closing = Some((Instant::now(), None));
                        break;
                    }
                    Err(TryRecvError::Empty) => break,
                }
            }
        }
        if let Some((since, report)) = &closing {
            if since.elapsed() > CLOSE_TIMEOUT {
                return report.clone();
            }
        }
        match ws.read() {
            Ok(Message::Binary(data)) => {
                if closing.is_none() {
                    (shared.sink)(Event::Message {
                        connection: id,
                        data: data.to_vec(),
                    });
                }
            }
            Ok(Message::Text(_)) => {
                if closing.is_none() {
                    let _ = ws.close(Some(close_frame(
                        UNSUPPORTED,
                        "protocol error: text message",
                    )));
                    closing = Some((
                        Instant::now(),
                        Some((UNSUPPORTED, "protocol error: text message".into())),
                    ));
                }
            }
            Ok(Message::Close(frame)) => {
                // The peer closed (or answered ours); tungstenite queues the reply. Keep reading until it's done.
                if closing.is_none() {
                    let (code, reason) = frame
                        .map(|f| (u16::from(f.code), f.reason.to_string()))
                        .unwrap_or((1005, String::new()));
                    closing = Some((Instant::now(), Some((code, reason))));
                }
            }
            Ok(_) => {} // ping, pong: tungstenite answers pings itself
            Err(WsError::Io(e)) if would_block(&e) => {}
            Err(WsError::ConnectionClosed) | Err(WsError::AlreadyClosed) => {
                return match closing {
                    Some((_, report)) => report,
                    None => Some((ABNORMAL, "connection lost".into())),
                };
            }
            Err(WsError::Capacity(e)) => {
                let reason = format!("message too big ({e})");
                let _ = ws.close(Some(close_frame(TOO_BIG, &reason)));
                return Some((TOO_BIG, reason));
            }
            Err(e) => {
                return match closing {
                    Some((_, report)) => report,
                    None => Some((ABNORMAL, format!("connection lost: {e}"))),
                };
            }
        }
        if shared.stop.load(Ordering::Acquire) && closing.is_none() {
            let _ = ws.close(Some(close_frame(GOING_AWAY, "The listener closed.")));
            closing = Some((Instant::now(), None));
        }
    }
}

/// Whether an I/O error is a socket timeout (WouldBlock on Unix, TimedOut on Windows), not a failure.
fn would_block(e: &io::Error) -> bool {
    e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut
}

/// A close frame; the reason is cut to the 123 bytes a close frame allows.
fn close_frame(code: u16, reason: &str) -> CloseFrame {
    let mut cut = reason.to_string();
    while cut.len() > 123 {
        cut.pop();
    }
    CloseFrame {
        code: CloseCode::from(code),
        reason: cut.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpStream;
    use std::sync::mpsc::RecvTimeoutError;

    const WAIT: Duration = Duration::from_secs(5);

    fn listen(host: &str, port: u16, path: &str) -> (Listener, Receiver<Event>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let listener = Listener::bind(
            host,
            port,
            path,
            Limits::default(),
            Arc::new(move |e| {
                let _ = tx.lock().unwrap().send(e);
            }),
        )
        .expect("binds");
        (listener, rx)
    }

    fn connect(port: u16, path: &str) -> Result<WebSocket<TcpStream>, WsError> {
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(WAIT)).unwrap();
        tungstenite::client(format!("ws://127.0.0.1:{port}{path}"), stream)
            .map(|(ws, _)| ws)
            .map_err(|e| match e {
                tungstenite::HandshakeError::Failure(e) => e,
                tungstenite::HandshakeError::Interrupted(_) => {
                    panic!("blocking handshake interrupted")
                }
            })
    }

    fn next(rx: &Receiver<Event>) -> Event {
        rx.recv_timeout(WAIT).expect("an event")
    }

    #[test]
    fn a_client_connects_exchanges_binary_messages_and_closes() {
        let (listener, rx) = listen("127.0.0.1", 0, "/myco-debug");
        let mut client = connect(listener.port(), "/myco-debug?myco-rtc=1").expect("connects");
        let Event::Accept {
            connection, remote, ..
        } = next(&rx) else {
            panic!("accept first")
        };
        assert!(remote.starts_with("127.0.0.1:"), "{remote}");

        client
            .send(Message::Binary(Bytes::from_static(&[0, 1, 2, 255])))
            .unwrap();
        assert_eq!(
            next(&rx),
            Event::Message {
                connection,
                data: vec![0, 1, 2, 255]
            }
        );

        listener.send(connection, vec![9, 8, 7]);
        listener.send(connection, vec![]);
        assert_eq!(
            client.read().unwrap(),
            Message::Binary(Bytes::from_static(&[9, 8, 7]))
        );
        assert_eq!(client.read().unwrap(), Message::Binary(Bytes::new()));

        client.close(Some(close_frame(1000, "done"))).unwrap();
        while client.read().is_ok() {}
        assert_eq!(
            next(&rx),
            Event::Close {
                connection,
                code: 1000,
                reason: "done".into()
            }
        );
    }

    #[test]
    fn accept_reports_the_path_the_upgrade_asked_for() {
        let (listener, rx) = listen("127.0.0.1", 0, "/");
        let _client = connect(listener.port(), "/myco-rendezvous?x=1").expect("accepted");
        let Event::Accept { path, .. } = next(&rx) else {
            panic!("accept first")
        };
        assert_eq!(path, "/myco-rendezvous");
    }

    #[test]
    fn the_page_closing_a_connection_sends_its_code_and_reports_nothing() {
        let (listener, rx) = listen("127.0.0.1", 0, "/");
        let mut client =
            connect(listener.port(), "/any/path").expect("a listener at / takes any path");
        let Event::Accept { connection, .. } = next(&rx) else {
            panic!("accept first")
        };
        listener.apply(vec![
            Outgoing::Send {
                connection,
                data: vec![1],
            },
            Outgoing::Close {
                connection,
                code: 4000,
                reason: "refused".into(),
            },
        ]);
        assert_eq!(
            client.read().unwrap(),
            Message::Binary(Bytes::from_static(&[1]))
        );
        match client.read().unwrap() {
            Message::Close(Some(frame)) => {
                assert_eq!(u16::from(frame.code), 4000);
                assert_eq!(frame.reason.as_str(), "refused");
            }
            other => panic!("expected a close, got {other:?}"),
        }
        while client.read().is_ok() {}
        assert_eq!(
            rx.recv_timeout(Duration::from_millis(300)),
            Err(RecvTimeoutError::Timeout)
        );
        listener.send(connection, vec![2]); // gone: ignored
    }

    #[test]
    fn a_port_in_use_is_reported() {
        let (first, _rx) = listen("127.0.0.1", 0, "/");
        let error = Listener::bind(
            "127.0.0.1",
            first.port(),
            "/",
            Limits::default(),
            Arc::new(|_| {}),
        )
        .err()
        .expect("refused");
        assert_eq!(error, format!("port {} is already in use", first.port()));
    }

    fn range(first: u16, count: u16) -> Result<(Listener, u16), String> {
        Listener::bind_range(
            "127.0.0.1",
            first,
            count,
            "/",
            Limits::default(),
            Arc::new(|_| {}),
        )
    }

    #[test]
    fn bind_range_takes_the_next_port_when_one_is_in_use() {
        let (first, _rx) = listen("127.0.0.1", 0, "/");
        let start = first.port();
        let (second, port) = range(start, 50).expect("binds a later one");
        assert!(port > start && port < start + 50); // other tests may hold the ports just above
        assert_eq!(second.port(), port);
    }

    #[test]
    fn bind_range_reports_when_every_port_is_taken() {
        // Two neighbouring ports held here (retried, as other tests bind ports at the same time).
        let (start, _held) = (0..50)
            .find_map(|_| {
                let a = TcpListener::bind(("127.0.0.1", 0)).ok()?;
                let port = a.local_addr().ok()?.port();
                let b = TcpListener::bind(("127.0.0.1", port.checked_add(1)?)).ok()?;
                Some((port, (a, b)))
            })
            .expect("two neighbouring ports");
        assert_eq!(
            range(start, 1).err().expect("refused"),
            format!("port {start} is already in use")
        );
        assert_eq!(
            range(start, 2).err().expect("refused"),
            format!("ports {start}-{} are all in use", start + 1)
        );
    }

    #[test]
    fn closing_frees_the_port_at_once_and_closes_connections() {
        let (mut listener, rx) = listen("127.0.0.1", 0, "/");
        let port = listener.port();
        let mut client = connect(port, "/").unwrap();
        let Event::Accept { .. } = next(&rx) else {
            panic!("accept first")
        };
        listener.close();
        match client.read() {
            Ok(Message::Close(Some(frame))) => assert_eq!(u16::from(frame.code), GOING_AWAY),
            other => panic!("expected a close, got {other:?}"),
        }
        let (again, _rx2) = listen("127.0.0.1", port, "/");
        assert_eq!(again.port(), port);
    }

    #[test]
    fn another_path_is_refused_with_404() {
        let (listener, rx) = listen("127.0.0.1", 0, "/myco-debug");
        match connect(listener.port(), "/game") {
            Err(WsError::Http(response)) => assert_eq!(response.status(), 404),
            Err(e) => panic!("expected HTTP 404, got {e}"),
            Ok(_) => panic!("expected HTTP 404, got a connection"),
        }
        assert_eq!(
            rx.recv_timeout(Duration::from_millis(200)),
            Err(RecvTimeoutError::Timeout)
        );
    }

    #[test]
    fn a_text_message_closes_the_connection() {
        let (listener, rx) = listen("127.0.0.1", 0, "/");
        let mut client = connect(listener.port(), "/").unwrap();
        let Event::Accept { connection, .. } = next(&rx) else {
            panic!("accept first")
        };
        client.send(Message::text("hello")).unwrap();
        while client.read().is_ok() {}
        assert_eq!(
            next(&rx),
            Event::Close {
                connection,
                code: UNSUPPORTED,
                reason: "protocol error: text message".into()
            }
        );
    }

    #[test]
    fn a_message_over_the_limit_closes_with_1009() {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let limits = Limits {
            max_message_bytes: 16,
            ..Limits::default()
        };
        let listener = Listener::bind(
            "127.0.0.1",
            0,
            "/",
            limits,
            Arc::new(move |e| {
                let _ = tx.lock().unwrap().send(e);
            }),
        )
        .unwrap();
        let mut client = connect(listener.port(), "/").unwrap();
        let Event::Accept { connection, .. } = next(&rx) else {
            panic!("accept first")
        };
        client
            .send(Message::Binary(Bytes::from(vec![0u8; 64])))
            .unwrap();
        while client.read().is_ok() {}
        match next(&rx) {
            Event::Close {
                connection: c,
                code,
                ..
            } => assert_eq!((c, code), (connection, TOO_BIG)),
            other => panic!("expected a close, got {other:?}"),
        }
    }

    #[test]
    fn a_peer_that_stops_reading_is_closed_once_the_backlog_is_over_the_limit() {
        let (listener, rx) = listen("127.0.0.1", 0, "/");
        let _client = connect(listener.port(), "/").unwrap(); // never reads
        let Event::Accept { connection, .. } = next(&rx) else {
            panic!("accept first")
        };
        // Far more than the peer's socket buffers hold, so the writes stall and the queue grows.
        for _ in 0..32 {
            listener.send(connection, vec![0u8; 1024 * 1024]);
        }
        match next(&rx) {
            Event::Close {
                connection: c,
                code,
                reason,
            } => {
                assert_eq!((c, code), (connection, TOO_BIG));
                assert!(reason.starts_with("too slow"), "{reason}");
            }
            other => panic!("expected a close, got {other:?}"),
        }
    }

    #[test]
    fn paths_match_like_the_node_server() {
        assert!(path_matches("/", "/anything"));
        assert!(path_matches("/myco-debug", "/myco-debug"));
        assert!(!path_matches("/myco-debug", "/myco-debug/x"));
    }
}
