use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, Sample, SampleFormat, SizedSample, StreamConfig, SupportedBufferSize};
use myco_audio_spike::{Mixer, Q};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default, Clone)]
struct Stats {
    frames: Vec<u32>,
    intervals_us: Vec<f64>,
    latency_us: Vec<f64>,
    body_us: Vec<f64>,
    mix_us: Vec<f64>,
    quanta: u64,
}

fn pct(v: &mut Vec<f64>, p: f64) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[(((v.len() - 1) as f64) * p).round() as usize]
}

fn build<T: SizedSample + Send + 'static>(
    dev: &cpal::Device,
    cfg: StreamConfig,
    voices: usize,
    shared: Arc<Mutex<Stats>>,
    errs: Arc<AtomicU32>,
    rate: f32,
) -> Result<cpal::Stream, cpal::Error> {
    let mut mixer = Box::new(Mixer::new(rate));
    mixer.set_voices(voices, voices);
    // FIFO of rendered quanta: the mixer yields 128 frames at a time, the device asks for any count.
    let mut fifo_l: Vec<f32> = Vec::with_capacity(Q * 16);
    let mut fifo_r: Vec<f32> = Vec::with_capacity(Q * 16);
    let mut last: Option<Instant> = None;
    let mut local = Stats::default();
    for v in [&mut local.intervals_us, &mut local.latency_us, &mut local.body_us, &mut local.mix_us] {
        v.reserve(8192);
    }
    local.frames.reserve(8192);
    let mut n_cb = 0u32;
    dev.build_output_stream(
        cfg,
        move |data: &mut [T], info: &cpal::OutputCallbackInfo| {
            let t0 = Instant::now();
            let ch = cfg.channels as usize;
            let frames = data.len() / ch;
            let mut mix_t = Duration::ZERO;
            while fifo_l.len() < frames {
                let m0 = Instant::now();
                mixer.process();
                mix_t += m0.elapsed();
                fifo_l.extend_from_slice(&mixer.out[..Q]);
                fifo_r.extend_from_slice(&mixer.out[Q..]);
                local.quanta += 1;
            }
            // Consume the rendered audio but drop it: the device gets silence.
            let mut sink = 0.0f32;
            for i in 0..frames {
                sink += fifo_l[i] + fifo_r[i];
            }
            std::hint::black_box(sink);
            fifo_l.drain(..frames);
            fifo_r.drain(..frames);
            for s in data.iter_mut() {
                *s = T::EQUILIBRIUM;
            }
            let body = t0.elapsed();
            if n_cb > 3 {
                if let Some(l) = last {
                    local.intervals_us.push(t0.duration_since(l).as_secs_f64() * 1e6);
                }
                let ts = info.timestamp();
                local.latency_us.push(ts.playback.saturating_duration_since(ts.callback).as_secs_f64() * 1e6);
                local.frames.push(frames as u32);
                local.body_us.push(body.as_secs_f64() * 1e6);
                local.mix_us.push(mix_t.as_secs_f64() * 1e6);
            }
            n_cb += 1;
            last = Some(t0);
            // Publish a snapshot now and then (try_lock so the callback never blocks; this copy is
            // outside the timed region and only happens every 100th callback).
            if n_cb % 100 == 0 {
                if let Ok(mut g) = shared.try_lock() {
                    *g = local.clone();
                }
            }
        },
        move |e| {
            eprintln!("  stream error: {e}");
            errs.fetch_add(1, Ordering::SeqCst);
        },
        None,
    )
}

fn run(dev: &cpal::Device, fmt: SampleFormat, rate: u32, channels: u16, bs: BufferSize, voices: usize, secs: f64) {
    let label = match bs {
        BufferSize::Default => "Default".to_string(),
        BufferSize::Fixed(n) => format!("Fixed({n})"),
    };
    let cfg = StreamConfig { channels, sample_rate: rate, buffer_size: bs };
    let shared = Arc::new(Mutex::new(Stats::default()));
    let errs = Arc::new(AtomicU32::new(0));
    let r = match fmt {
        SampleFormat::F32 => build::<f32>(dev, cfg, voices, shared.clone(), errs.clone(), rate as f32),
        SampleFormat::I16 => build::<i16>(dev, cfg, voices, shared.clone(), errs.clone(), rate as f32),
        SampleFormat::I32 => build::<i32>(dev, cfg, voices, shared.clone(), errs.clone(), rate as f32),
        other => {
            println!("RESULT {label} voices={voices}: unsupported sample format {other:?}");
            return;
        }
    };
    let stream = match r {
        Ok(s) => s,
        Err(e) => {
            println!("RESULT {label} voices={voices}: build FAILED: {e}");
            return;
        }
    };
    if let Err(e) = stream.play() {
        println!("RESULT {label} voices={voices}: play FAILED: {e}");
        return;
    }
    std::thread::sleep(Duration::from_secs_f64(secs));
    drop(stream);
    let g = shared.lock().unwrap().clone();
    let mut hist: BTreeMap<u32, usize> = BTreeMap::new();
    for f in &g.frames {
        *hist.entry(*f).or_default() += 1;
    }
    let n = g.frames.len();
    let mean_frames = g.frames.iter().map(|&f| f as f64).sum::<f64>() / n.max(1) as f64;
    let period_us = mean_frames / rate as f64 * 1e6;
    let (mut iv, mut lat, mut body, mut mix) =
        (g.intervals_us.clone(), g.latency_us.clone(), g.body_us.clone(), g.mix_us.clone());
    let ivmean = iv.iter().sum::<f64>() / iv.len().max(1) as f64;
    println!("RESULT {label} voices={voices}: callbacks={n} frames_hist={hist:?} mean_period={period_us:.0}us");
    println!(
        "   interval us (mean {ivmean:.0}): p50={:.0} p95={:.0} p99={:.0} max={:.0} min={:.0}",
        pct(&mut iv, 0.5), pct(&mut iv, 0.95), pct(&mut iv, 0.99), pct(&mut iv, 1.0), pct(&mut iv, 0.0)
    );
    let mut j: Vec<f64> = iv.iter().map(|x| (x - ivmean).abs()).collect();
    println!("   jitter |interval-mean| us: p95={:.0} p99={:.0} max={:.0}", pct(&mut j, 0.95), pct(&mut j, 0.99), pct(&mut j, 1.0));
    println!(
        "   playback-callback latency ms: p50={:.2} p95={:.2} min={:.2} max={:.2}",
        pct(&mut lat, 0.5) / 1e3, pct(&mut lat, 0.95) / 1e3, pct(&mut lat, 0.0) / 1e3, pct(&mut lat, 1.0) / 1e3
    );
    let bp50 = pct(&mut body, 0.5);
    println!(
        "   callback body us: p50={:.0} p95={:.0} max={:.0} ({:.1}% of period at p50); mixer-only us: p50={:.0} p95={:.0} max={:.0}; quanta={}",
        bp50, pct(&mut body, 0.95), pct(&mut body, 1.0), bp50 / period_us * 100.0,
        pct(&mut mix, 0.5), pct(&mut mix, 0.95), pct(&mut mix, 1.0), g.quanta
    );
    println!("   stream errors: {}", errs.load(Ordering::SeqCst));
}

fn main() {
    let host = cpal::default_host();
    println!("host: {:?}", host.id());
    let dev = host.default_output_device().expect("no output device");
    let d = dev.description().unwrap();
    println!("device: {} (driver {:?}, interface {:?}, type {:?})", d.name(), d.driver(), d.interface_type(), d.device_type());
    let def = dev.default_output_config().unwrap();
    println!("default config: {} Hz, {} ch, {:?}, buffer {:?}", def.sample_rate(), def.channels(), def.sample_format(), def.buffer_size());
    for c in dev.supported_output_configs().unwrap() {
        println!("  supported: {}-{} Hz, {} ch, {:?}, buffer {:?}", c.min_sample_rate(), c.max_sample_rate(), c.channels(), c.sample_format(), c.buffer_size());
    }
    if let SupportedBufferSize::Range { min, max } = def.buffer_size() {
        println!("buffer range: {min}..{max} frames");
    }
    let (fmt, rate, ch) = (def.sample_format(), def.sample_rate(), def.channels());
    let secs = 4.0;
    let only: Option<usize> = std::env::args().nth(1).and_then(|a| a.parse().ok());
    let v = only.unwrap_or(256);
    run(&dev, fmt, rate, ch, BufferSize::Default, v, secs);
    for n in [128u32, 256, 480, 512, 1024] {
        run(&dev, fmt, rate, ch, BufferSize::Fixed(n), v, secs);
    }
    if only.is_none() {
        println!("--- extra: 1024 voices, Default ---");
        run(&dev, fmt, rate, ch, BufferSize::Default, 1024, secs);
        println!("--- extra: 0 voices, Default ---");
        run(&dev, fmt, rate, ch, BufferSize::Default, 0, secs);
    }
}
