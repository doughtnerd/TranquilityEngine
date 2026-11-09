use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request, Response};

#[tauri::command]
fn empty() {}

#[tauri::command]
fn sum_json(data: Vec<f32>) -> f32 {
    data.iter().sum()
}

#[tauri::command]
fn sum_raw(request: Request<'_>) -> Result<f32, String> {
    match request.body() {
        InvokeBody::Raw(b) => {
            let mut s = 0.0f32;
            for c in b.chunks_exact(4) {
                s += f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
            }
            Ok(s)
        }
        _ => Err("expected raw body".into()),
    }
}

#[tauri::command]
fn raw_response(size: usize) -> Response {
    Response::new(vec![1u8; size])
}

fn precise_sleep_until(t: Instant) {
    loop {
        let now = Instant::now();
        if now >= t {
            return;
        }
        let left = t - now;
        if left > Duration::from_millis(2) {
            std::thread::sleep(left - Duration::from_millis(1));
        } else {
            std::hint::spin_loop();
        }
    }
}

// Paced stream: `count` messages of `size` bytes at `hz`.
#[tauri::command]
fn stream_paced(ch: Channel<InvokeResponseBody>, hz: f64, count: u32, size: usize) {
    std::thread::spawn(move || {
        let period = Duration::from_secs_f64(1.0 / hz);
        let start = Instant::now();
        for i in 0..count {
            precise_sleep_until(start + period * i);
            let _ = ch.send(InvokeResponseBody::Raw(vec![0u8; size]));
        }
    });
}

// Flood: send as fast as possible for `ms`, then an end marker (0xFFFFFFFF, sent count).
#[tauri::command]
fn stream_flood(ch: Channel<InvokeResponseBody>, ms: u64, size: usize) {
    std::thread::spawn(move || {
        let start = Instant::now();
        let mut n: u32 = 0;
        while start.elapsed() < Duration::from_millis(ms) {
            let mut v = vec![0u8; size.max(4)];
            v[..4].copy_from_slice(&n.to_le_bytes());
            if ch.send(InvokeResponseBody::Raw(v)).is_err() {
                break;
            }
            n += 1;
        }
        let mut v = vec![0u8; 8];
        v[..4].copy_from_slice(&u32::MAX.to_le_bytes());
        v[4..8].copy_from_slice(&n.to_le_bytes());
        let _ = ch.send(InvokeResponseBody::Raw(v));
    });
}

#[tauri::command]
fn write_results(json: String) -> Result<(), String> {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("results.json");
    std::fs::write(p, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn quit(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            empty,
            sum_json,
            sum_raw,
            raw_response,
            stream_paced,
            stream_flood,
            write_results,
            quit
        ])
        .run(tauri::generate_context!())
        .expect("error while running");
}
