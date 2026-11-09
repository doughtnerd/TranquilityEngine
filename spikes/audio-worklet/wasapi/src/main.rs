//! WASAPI low-latency measurement spike. Always writes silence to the device.
//! Usage: myco-audio-wasapi [info] [shared-min] [shared-def] [excl-min[-f32|-i16|-i24]] [excl-def[-..]]
//! With no arguments: info, then every run (each at most 3 s).
use myco_audio_spike::{Mixer, Q};
use std::mem::{size_of, zeroed};
use std::time::Duration;
use windows::core::*;
use windows::Win32::Devices::FunctionDiscovery::*;
use windows::Win32::Foundation::*;
use windows::Win32::Media::Audio::*;
use windows::Win32::Media::KernelStreaming::*;
use windows::Win32::Media::Multimedia::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::Performance::*;
use windows::Win32::System::Threading::*;
use windows::Win32::UI::Shell::PropertiesSystem::*;

const RUN_SECS: f64 = 3.0;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Fmt {
    F32,
    I16,
    I24in32,
}
impl Fmt {
    fn name(self) -> &'static str {
        match self {
            Fmt::F32 => "float32",
            Fmt::I16 => "int16",
            Fmt::I24in32 => "int24-in-32",
        }
    }
    fn bytes_per_frame(self) -> usize {
        match self {
            Fmt::I16 => 4,
            _ => 8,
        }
    }
}

fn make_fmt(f: Fmt, rate: u32) -> WAVEFORMATEXTENSIBLE {
    let (bits, valid, sub) = match f {
        Fmt::F32 => (32u16, 32u16, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT),
        Fmt::I16 => (16, 16, KSDATAFORMAT_SUBTYPE_PCM),
        Fmt::I24in32 => (32, 24, KSDATAFORMAT_SUBTYPE_PCM),
    };
    let mut w: WAVEFORMATEXTENSIBLE = unsafe { zeroed() };
    w.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE as u16;
    w.Format.nChannels = 2;
    w.Format.nSamplesPerSec = rate;
    w.Format.wBitsPerSample = bits;
    w.Format.nBlockAlign = 2 * bits / 8;
    w.Format.nAvgBytesPerSec = rate * (2 * bits / 8) as u32;
    w.Format.cbSize = (size_of::<WAVEFORMATEXTENSIBLE>() - size_of::<WAVEFORMATEX>()) as u16;
    w.Samples.wValidBitsPerSample = valid;
    w.dwChannelMask = 3;
    w.SubFormat = sub;
    w
}

fn qpc_freq() -> f64 {
    let mut f = 0i64;
    unsafe { QueryPerformanceFrequency(&mut f).unwrap() };
    f as f64
}
fn qpc() -> i64 {
    let mut t = 0i64;
    unsafe { QueryPerformanceCounter(&mut t).unwrap() };
    t
}

fn pct(v: &mut Vec<f64>, p: f64) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[(((v.len() - 1) as f64) * p).round() as usize]
}

fn default_device() -> Result<IMMDevice> {
    unsafe {
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        en.GetDefaultAudioEndpoint(eRender, eConsole)
    }
}

fn prop_str(store: &IPropertyStore, fmtid: GUID, pid: u32) -> String {
    let key = PROPERTYKEY { fmtid, pid };
    match unsafe { store.GetValue(&key) } {
        Ok(v) => format!("{}", v),
        Err(e) => format!("<{e}>"),
    }
}

fn info() {
    let dev = default_device().unwrap();
    unsafe {
        println!("endpoint id: {}", dev.GetId().unwrap().to_string().unwrap());
        let store = dev.OpenPropertyStore(STGM_READ).unwrap();
        let g_dev = GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0);
        let g_if = GUID::from_u128(0x026e516e_b814_414b_83cd_856d6fef4822);
        println!("friendly name: {}", prop_str(&store, PKEY_Device_FriendlyName.fmtid, PKEY_Device_FriendlyName.pid));
        println!("device desc: {}", prop_str(&store, g_dev, 2));
        println!("adapter (DeviceInterface_FriendlyName): {}", prop_str(&store, g_if, 2));
        println!("enumerator: {}", prop_str(&store, g_dev, 24));
        let c: IAudioClient = dev.Activate(CLSCTX_ALL, None).unwrap();
        let mf = c.GetMixFormat().unwrap();
        let (r, ch, b, tag) = ((*mf).nSamplesPerSec, (*mf).nChannels, (*mf).wBitsPerSample, (*mf).wFormatTag);
        println!("mix format: {r} Hz, {ch} ch, {b} bit, tag {tag:#x}");
        let (mut d, mut m) = (0i64, 0i64);
        c.GetDevicePeriod(Some(&mut d), Some(&mut m)).unwrap();
        println!("GetDevicePeriod: default {:.3} ms, min {:.3} ms", d as f64 / 1e4, m as f64 / 1e4);
        for f in [Fmt::F32, Fmt::I16, Fmt::I24in32] {
            let w = make_fmt(f, 48000);
            let hr = c.IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, &w as *const _ as *const WAVEFORMATEX, None);
            println!(
                "exclusive 48k stereo {}: {} ({:#010x})",
                f.name(),
                if hr == S_OK { "SUPPORTED" } else { "not supported" },
                hr.0
            );
        }
        let c3: IAudioClient3 = dev.Activate(CLSCTX_ALL, None).unwrap();
        let (mut d, mut f, mut mn, mut mx) = (0u32, 0u32, 0u32, 0u32);
        let mf = c3.GetMixFormat().unwrap();
        let rate = (*mf).nSamplesPerSec as f64;
        match c3.GetSharedModeEnginePeriod(mf, &mut d, &mut f, &mut mn, &mut mx) {
            Ok(()) => println!(
                "shared engine periods (frames): default {d} ({:.2} ms), fundamental {f} ({:.2} ms), min {mn} ({:.2} ms), max {mx} ({:.2} ms)",
                d as f64 / rate * 1e3,
                f as f64 / rate * 1e3,
                mn as f64 / rate * 1e3,
                mx as f64 / rate * 1e3
            ),
            Err(e) => println!("GetSharedModeEnginePeriod failed: {e}"),
        }
    }
}

#[derive(Default)]
struct Run {
    name: String,
    fmt: String,
    period_frames: u32,
    buffer_frames: u32,
    rate: u32,
    stream_latency_ms: f64,
    intervals: Vec<f64>,
    mixer_us: Vec<f64>,
    wakes: u32,
    timeouts: u32,
    pad0: u32,
    clock_underrun: u32,
    late: u32,
    pads: Vec<f64>,
    tight: bool,
    err: Option<String>,
}

impl Run {
    fn print(&mut self) {
        println!("\n=== {} ({}) ===", self.name, self.fmt);
        if let Some(e) = &self.err {
            println!("FAILED: {e}");
            return;
        }
        let rate = self.rate as f64;
        let period_ms = self.period_frames as f64 / rate * 1e3;
        println!(
            "rate {} Hz, period {} frames ({:.3} ms), buffer {} frames ({:.3} ms), GetStreamLatency {:.3} ms",
            self.rate,
            self.period_frames,
            period_ms,
            self.buffer_frames,
            self.buffer_frames as f64 / rate * 1e3,
            self.stream_latency_ms
        );
        let skip = self.intervals.len().min(5);
        let mut iv: Vec<f64> = self.intervals[skip..].to_vec();
        let med = pct(&mut iv.clone(), 0.5);
        let mut jit: Vec<f64> = iv.iter().map(|x| (x - med).abs()).collect();
        println!(
            "wakes {} (timeouts {}), interval ms p50/p95/p99/max: {:.3} / {:.3} / {:.3} / {:.3}",
            self.wakes,
            self.timeouts,
            pct(&mut iv, 0.5),
            pct(&mut iv, 0.95),
            pct(&mut iv, 0.99),
            pct(&mut iv, 1.0)
        );
        println!(
            "jitter |interval - p50| ms p95/p99/max: {:.3} / {:.3} / {:.3}",
            pct(&mut jit, 0.95),
            pct(&mut jit, 0.99),
            pct(&mut jit, 1.0)
        );
        let mut mx = self.mixer_us[self.mixer_us.len().min(5)..].to_vec();
        println!(
            "mixer us per wake p50/p95/max: {:.0} / {:.0} / {:.0} ({:.1}% of period at p50)",
            pct(&mut mx, 0.5),
            pct(&mut mx, 0.95),
            pct(&mut mx, 1.0),
            pct(&mut mx, 0.5) / (period_ms * 10.0)
        );
        let mut pd = self.pads.clone();
        if !pd.is_empty() {
            println!(
                "padding at wake (frames queued, shared only) p50/min/max: {:.0} / {:.0} / {:.0} ({:.2} ms at p50)",
                pct(&mut pd, 0.5), pct(&mut pd, 0.0), pct(&mut pd, 1.0), pct(&mut pd, 0.5) / rate * 1e3
            );
        }
        println!(
            "glitches: padding==0 at wake {}, IAudioClock position beyond written {}, late wakes (>1.5 periods) {}",
            self.pad0, self.clock_underrun, self.late
        );
    }
}

struct Fifo {
    l: Vec<f32>,
    r: Vec<f32>,
}

fn run_loop(client: &IAudioClient, event: HANDLE, r: &mut Run, exclusive: bool, bpf: usize) -> Result<()> {
    unsafe {
        let render: IAudioRenderClient = client.GetService()?;
        let clock: IAudioClock = client.GetService()?;
        let cfreq = clock.GetFrequency()? as f64;
        let buf = client.GetBufferSize()?;
        r.buffer_frames = buf;
        r.stream_latency_ms = client.GetStreamLatency().unwrap_or(0) as f64 / 1e4;
        let mut mixer = Box::new(Mixer::new(r.rate as f32));
        mixer.set_voices(256, 256);
        let mut fifo = Fifo { l: Vec::with_capacity(buf as usize + 4 * Q), r: Vec::with_capacity(buf as usize + 4 * Q) };
        // prefill the whole buffer with silence
        let pre = if r.tight { r.period_frames } else { buf };
        let p = render.GetBuffer(pre)?;
        std::ptr::write_bytes(p, 0, pre as usize * bpf);
        render.ReleaseBuffer(pre, 0)?;
        let mut written: u64 = pre as u64;
        client.Start()?;
        let freq = qpc_freq();
        let t0 = qpc();
        let mut prev = t0;
        let mut first = true;
        let period = r.period_frames as f64 / r.rate as f64 * 1e3;
        while (qpc() - t0) as f64 / freq < RUN_SECS {
            if WaitForSingleObject(event, 500) != WAIT_OBJECT_0 {
                r.timeouts += 1;
                continue;
            }
            let now = qpc();
            if !first {
                let iv = (now - prev) as f64 / freq * 1e3;
                r.intervals.push(iv);
                if iv > 1.5 * period {
                    r.late += 1;
                }
            }
            first = false;
            prev = now;
            r.wakes += 1;
            let pad = if exclusive { 0 } else { client.GetCurrentPadding()? };
            if !exclusive && pad == 0 {
                r.pad0 += 1;
            }
            if !exclusive {
                r.pads.push(pad as f64);
            }
            let mut avail = buf - pad;
            if r.tight {
                avail = avail.min(r.period_frames);
            }
            if avail == 0 {
                continue;
            }
            // the real mixer, FIFO of 128-frame quanta
            let m0 = qpc();
            let n = avail as usize;
            while fifo.l.len() < n {
                mixer.process();
                fifo.l.extend_from_slice(&mixer.out[..Q]);
                fifo.r.extend_from_slice(&mixer.out[Q..]);
            }
            fifo.l.drain(..n);
            fifo.r.drain(..n);
            r.mixer_us.push((qpc() - m0) as f64 / freq * 1e6);
            // the device gets silence
            let p = render.GetBuffer(avail)?;
            std::ptr::write_bytes(p, 0, n * bpf);
            render.ReleaseBuffer(avail, 0)?;
            written += avail as u64;
            let (mut pos, mut q) = (0u64, 0u64);
            if clock.GetPosition(&mut pos, Some(&mut q)).is_ok() {
                let frames = (pos as f64 / cfreq * r.rate as f64) as u64;
                if frames > written {
                    r.clock_underrun += 1;
                }
            }
        }
        client.Stop()?;
    }
    Ok(())
}

fn mmcss() -> HANDLE {
    let mut idx = 0u32;
    unsafe { AvSetMmThreadCharacteristicsW(w!("Pro Audio"), &mut idx).unwrap_or_default() }
}

fn run_shared(name: &str, minimum: bool, tight: bool) -> Run {
    let mut r = Run { name: name.into(), tight, ..Default::default() };
    let res = (|| -> Result<()> {
        unsafe {
            let dev = default_device()?;
            let c3: IAudioClient3 = dev.Activate(CLSCTX_ALL, None)?;
            let mf = c3.GetMixFormat()?;
            r.rate = (*mf).nSamplesPerSec;
            r.fmt = { let b = (*mf).wBitsPerSample; format!("mix format {} bit", b) };
            let bpf = (*mf).nBlockAlign as usize;
            let (mut d, mut f, mut mn, mut mx) = (0u32, 0u32, 0u32, 0u32);
            c3.GetSharedModeEnginePeriod(mf, &mut d, &mut f, &mut mn, &mut mx)?;
            let want = if minimum { mn } else { d };
            let event = CreateEventW(None, false, false, None)?;
            c3.InitializeSharedAudioStream(AUDCLNT_STREAMFLAGS_EVENTCALLBACK, want, mf, None)?;
            c3.SetEventHandle(event)?;
            let (mut pf, mut cur) = (std::ptr::null_mut(), 0u32);
            c3.GetCurrentSharedModeEnginePeriod(&mut pf, &mut cur)?;
            r.period_frames = cur;
            let base: IAudioClient = c3.cast()?;
            let h = mmcss();
            let out = run_loop(&base, event, &mut r, false, bpf);
            if !h.is_invalid() {
                let _ = AvRevertMmThreadCharacteristics(h);
            }
            let _ = CloseHandle(event);
            out
        }
    })();
    if let Err(e) = res {
        r.err = Some(e.to_string());
    }
    r
}

fn run_exclusive(name: &str, minimum: bool, f: Fmt) -> Run {
    let mut r = Run { name: name.into(), fmt: f.name().into(), rate: 48000, ..Default::default() };
    let res = (|| -> Result<()> {
        unsafe {
            let dev = default_device()?;
            let w = make_fmt(f, 48000);
            let pw = &w as *const _ as *const WAVEFORMATEX;
            let mut c: IAudioClient = dev.Activate(CLSCTX_ALL, None)?;
            let (mut d, mut m) = (0i64, 0i64);
            c.GetDevicePeriod(Some(&mut d), Some(&mut m))?;
            let mut hns = if minimum { m } else { d };
            let event = CreateEventW(None, false, false, None)?;
            let flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
            let mut res = c.Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, flags, hns, hns, pw, None);
            if let Err(e) = &res {
                if e.code() == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED {
                    let frames = c.GetBufferSize()?;
                    hns = (10_000_000.0 * frames as f64 / 48000.0 + 0.5) as i64;
                    println!("  [{name}] not aligned; realigned to {frames} frames = {:.3} ms", hns as f64 / 1e4);
                    c = dev.Activate(CLSCTX_ALL, None)?;
                    res = c.Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, flags, hns, hns, pw, None);
                }
            }
            res?;
            c.SetEventHandle(event)?;
            r.period_frames = c.GetBufferSize()?; // event-driven exclusive: period == buffer
            let h = mmcss();
            let out = run_loop(&c, event, &mut r, true, f.bytes_per_frame());
            if !h.is_invalid() {
                let _ = AvRevertMmThreadCharacteristics(h);
            }
            let _ = CloseHandle(event);
            out
        }
    })();
    if let Err(e) = res {
        r.err = Some(e.to_string());
    }
    r
}

fn on_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::spawn(move || {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap() };
        let v = f();
        unsafe { CoUninitialize() };
        v
    })
    .join()
    .unwrap()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let all = args.is_empty();
    if all || args.iter().any(|a| a == "info") {
        on_thread(info);
    }
    let fmt_of = |pre: &str| -> Fmt {
        match args.iter().find(|a| a.starts_with(pre)).map(|s| s.as_str()) {
            Some(s) if s.ends_with("-i16") => Fmt::I16,
            Some(s) if s.ends_with("-i24") => Fmt::I24in32,
            _ => Fmt::F32,
        }
    };
    let pick = |pre: &str| all || args.iter().any(|a| a.starts_with(pre));
    let mut runs: Vec<Run> = vec![];
    let exact = |n: &str| all || args.iter().any(|a| a == n);
    if exact("shared-min") {
        runs.push(on_thread(|| run_shared("IAudioClient3 shared, minimum period, fill whole buffer", true, false)));
        std::thread::sleep(Duration::from_millis(500));
    }
    if exact("shared-min-tight") {
        runs.push(on_thread(|| run_shared("IAudioClient3 shared, minimum period, tight (1 period ahead)", true, true)));
        std::thread::sleep(Duration::from_millis(500));
    }
    if exact("shared-def") {
        runs.push(on_thread(|| run_shared("IAudioClient3 shared, default period, fill whole buffer", false, false)));
        std::thread::sleep(Duration::from_millis(500));
    }
    if exact("shared-def-tight") {
        runs.push(on_thread(|| run_shared("IAudioClient3 shared, default period, tight (1 period ahead)", false, true)));
        std::thread::sleep(Duration::from_millis(500));
    }
    if pick("excl-min") {
        let f = fmt_of("excl-min");
        runs.push(on_thread(move || run_exclusive("Exclusive, minimum period", true, f)));
        std::thread::sleep(Duration::from_millis(500));
    }
    if pick("excl-def") {
        let f = fmt_of("excl-def");
        runs.push(on_thread(move || run_exclusive("Exclusive, default period", false, f)));
    }
    for r in runs.iter_mut() {
        r.print();
    }
}
