//! What crosses between the listener and the page (ADR 0379). Everything is binary, so WebSocket
//! messages reach the page without a JSON round trip. Numbers are big-endian; text is UTF-8.
//!
//! **Events** (listener → page), one per channel message: `[kind u8][connection u32][rest]`.
//! - `1` accept: `rest` is the peer's address (`127.0.0.1:51234`, `[::1]:51234`), then a newline and the path
//!   the upgrade asked for (`/myco-rendezvous`; the query is dropped), so a page that listens at "/" can
//!   route each connection by path. A page may meet a listener that sends the address alone.
//! - `2` message: `rest` is one binary WebSocket message.
//! - `3` close: `rest` is `[code u16][reason]`. Sent when the peer or the network ends the
//!   connection, never for a close the page asked for.
//! - `4` error: connection 0; `rest` is a message about the listener itself.
//!
//! **Outbox** (page → listener), one invoke body holding records in order:
//! `[op u8][connection u32][length u32][length bytes]`.
//! - `1` send: the bytes are one binary WebSocket message.
//! - `2` close: the bytes are `[code u16][reason]`.
//!
//! `src/editor/debugLink/tauriListener.ts` is the page's side of the same format.

/// Something that happened on the listener.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// A WebSocket handshake finished; `remote` is the peer's address, `path` the one the upgrade asked for.
    Accept {
        connection: u32,
        remote: String,
        path: String,
    },
    /// One binary message from the peer.
    Message { connection: u32, data: Vec<u8> },
    /// The peer or the network ended the connection.
    Close {
        connection: u32,
        code: u16,
        reason: String,
    },
    /// The listener itself failed (accepting stopped working).
    Error { message: String },
}

const ACCEPT: u8 = 1;
const MESSAGE: u8 = 2;
const CLOSE: u8 = 3;
const ERROR: u8 = 4;

/// The bytes the page receives for `event`.
pub fn encode_event(event: &Event) -> Vec<u8> {
    let (kind, connection, rest): (u8, u32, Vec<u8>) = match event {
        Event::Accept {
            connection,
            remote,
            path,
        } => (ACCEPT, *connection, format!("{remote}\n{path}").into_bytes()),
        Event::Message { connection, data } => (MESSAGE, *connection, data.clone()),
        Event::Close {
            connection,
            code,
            reason,
        } => {
            let mut rest = code.to_be_bytes().to_vec();
            rest.extend_from_slice(reason.as_bytes());
            (CLOSE, *connection, rest)
        }
        Event::Error { message } => (ERROR, 0, message.as_bytes().to_vec()),
    };
    let mut out = Vec::with_capacity(5 + rest.len());
    out.push(kind);
    out.extend_from_slice(&connection.to_be_bytes());
    out.extend_from_slice(&rest);
    out
}

/// One thing the page asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outgoing {
    Send {
        connection: u32,
        data: Vec<u8>,
    },
    Close {
        connection: u32,
        code: u16,
        reason: String,
    },
}

const SEND: u8 = 1;
const CLOSE_OP: u8 = 2;

/// The records of an outbox body, in order. A malformed body is refused whole.
pub fn decode_outbox(body: &[u8]) -> Result<Vec<Outgoing>, String> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while at < body.len() {
        if body.len() - at < 9 {
            return Err(format!("outbox record at byte {at} is cut short"));
        }
        let op = body[at];
        let connection = u32::from_be_bytes(body[at + 1..at + 5].try_into().unwrap());
        let length = u32::from_be_bytes(body[at + 5..at + 9].try_into().unwrap()) as usize;
        at += 9;
        if body.len() - at < length {
            return Err(format!(
                "outbox record for connection {connection} is cut short"
            ));
        }
        let bytes = &body[at..at + length];
        at += length;
        out.push(match op {
            SEND => Outgoing::Send {
                connection,
                data: bytes.to_vec(),
            },
            CLOSE_OP => {
                if bytes.len() < 2 {
                    return Err(format!(
                        "outbox close for connection {connection} has no code"
                    ));
                }
                Outgoing::Close {
                    connection,
                    code: u16::from_be_bytes([bytes[0], bytes[1]]),
                    reason: String::from_utf8_lossy(&bytes[2..]).into_owned(),
                }
            }
            _ => return Err(format!("unknown outbox op {op}")),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An outbox body holding `records`, as the page builds one.
    fn encode_outbox(records: &[Outgoing]) -> Vec<u8> {
        let mut out = Vec::new();
        for record in records {
            let (op, connection, bytes) = match record {
                Outgoing::Send { connection, data } => (SEND, *connection, data.clone()),
                Outgoing::Close {
                    connection,
                    code,
                    reason,
                } => {
                    let mut bytes = code.to_be_bytes().to_vec();
                    bytes.extend_from_slice(reason.as_bytes());
                    (CLOSE_OP, *connection, bytes)
                }
            };
            out.push(op);
            out.extend_from_slice(&connection.to_be_bytes());
            out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            out.extend_from_slice(&bytes);
        }
        out
    }

    #[test]
    fn events_encode_kind_connection_and_rest() {
        assert_eq!(
            encode_event(&Event::Accept {
                connection: 2,
                remote: "a".into(),
                path: "/p".into()
            }),
            vec![1, 0, 0, 0, 2, b'a', b'\n', b'/', b'p']
        );
        assert_eq!(
            encode_event(&Event::Message {
                connection: 258,
                data: vec![9]
            }),
            vec![2, 0, 0, 1, 2, 9]
        );
        assert_eq!(
            encode_event(&Event::Close {
                connection: 1,
                code: 1000,
                reason: "x".into()
            }),
            vec![3, 0, 0, 0, 1, 0x03, 0xe8, b'x']
        );
        assert_eq!(
            encode_event(&Event::Error {
                message: "e".into()
            }),
            vec![4, 0, 0, 0, 0, b'e']
        );
    }

    #[test]
    fn outbox_round_trips_and_refuses_cut_records() {
        let records = vec![
            Outgoing::Send {
                connection: 1,
                data: vec![1, 2, 3],
            },
            Outgoing::Send {
                connection: 2,
                data: vec![],
            },
            Outgoing::Close {
                connection: 1,
                code: 1001,
                reason: "bye".into(),
            },
        ];
        let body = encode_outbox(&records);
        assert_eq!(decode_outbox(&body).unwrap(), records);
        assert!(decode_outbox(&body[..body.len() - 1]).is_err());
        assert!(decode_outbox(&[7, 0, 0, 0, 1, 0, 0, 0, 0]).is_err());
        assert!(decode_outbox(&[2, 0, 0, 0, 1, 0, 0, 0, 1, 3]).is_err());
        assert_eq!(decode_outbox(&[]).unwrap(), vec![]);
    }
}
