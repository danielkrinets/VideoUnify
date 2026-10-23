#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, State};

#[derive(Default)]
struct Job {
    child: Mutex<Option<Child>>,
    cancelled: AtomicBool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Info {
    w: u32,
    h: u32,
    has_audio: bool,
    duration: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    path: String,
    w: u32,
    h: u32,
    has_audio: bool,
    duration: f64,
}

// ffmpeg ships next to the app binary (externalBin); fall back to PATH for odd setups.
fn ffmpeg() -> PathBuf {
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(name)))
        .filter(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("ffmpeg"))
}

// Parses the banner `ffmpeg -i file` prints to stderr, so ffprobe is not needed.
fn parse_info(text: &str) -> Option<Info> {
    let dur = Regex::new(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)").unwrap().captures(text)?;
    let duration = dur[1].parse::<f64>().ok()? * 3600.0 + dur[2].parse::<f64>().ok()? * 60.0 + dur[3].parse::<f64>().ok()?;
    let line = text.lines().find(|l| l.contains("Video:"))?;
    let size = Regex::new(r"[ ,](\d{2,5})x(\d{2,5})[ ,\[]").unwrap().captures(line)?;
    let (mut w, mut h): (u32, u32) = (size[1].parse().ok()?, size[2].parse().ok()?);
    let rot = Regex::new(r"rotation of (-?\d+)").unwrap().captures(text).and_then(|c| c[1].parse::<i32>().ok()).unwrap_or(0);
    if rot.abs() % 180 == 90 {
        std::mem::swap(&mut w, &mut h);
    }
    Some(Info { w, h, has_audio: text.contains("Audio:"), duration })
}

fn even(n: u32) -> u32 {
    ((n as f64 / 2.0).round() as u32 * 2).max(2)
}

// Every clip is scaled into the first clip's frame (letterboxed); clips without audio get silence.
fn build_filter(items: &[Item]) -> String {
    let (w, h) = (even(items[0].w), even(items[0].h));
    let mut parts = Vec::new();
    for (i, it) in items.iter().enumerate() {
        parts.push(format!(
            "[{i}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v{i}]"
        ));
        parts.push(if it.has_audio {
            format!("[{i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}]")
        } else {
            let d = if it.duration > 0.0 { it.duration } else { 1.0 };
            format!("anullsrc=r=48000:cl=stereo,atrim=duration={d}[a{i}]")
        });
    }
    let ins: String = (0..items.len()).map(|i| format!("[v{i}][a{i}]")).collect();
    parts.push(format!("{ins}concat=n={}:v=1:a=1[v][a]", items.len()));
    parts.join(";\n")
}

fn build_args(items: &[Item], script: &str, out: &str) -> Vec<String> {
    let mut a: Vec<String> = vec!["-y".into(), "-hide_banner".into()];
    for it in items {
        a.push("-i".into());
        a.push(it.path.clone());
    }
    for s in [
        "-filter_complex_script", script, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", out,
    ] {
        a.push(s.into());
    }
    a
}

#[tauri::command]
async fn probe(path: String) -> Result<Info, String> {
    let o = Command::new(ffmpeg()).args(["-hide_banner", "-i", &path]).output().map_err(|e| e.to_string())?;
    parse_info(&String::from_utf8_lossy(&o.stderr)).ok_or_else(|| "unreadable".to_string())
}

#[tauri::command]
async fn thumb(path: String) -> String {
    for ss in ["1", "0"] {
        let o = Command::new(ffmpeg())
            .args(["-v", "error", "-ss", ss, "-i", &path, "-frames:v", "1", "-vf", "scale=160:-2", "-f", "image2pipe", "-vcodec", "mjpeg", "-"])
            .output();
        if let Ok(o) = o {
            if !o.stdout.is_empty() {
                return format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(o.stdout));
            }
        }
    }
    String::new()
}

#[tauri::command]
async fn export(app: tauri::AppHandle, job: State<'_, Job>, items: Vec<Item>, out: String) -> Result<Value, String> {
    if items.len() < 2 {
        return Ok(json!({ "error": "need at least 2 files" }));
    }
    if let Some(m) = items.iter().find(|i| !std::path::Path::new(&i.path).exists()) {
        return Ok(json!({ "missing": m.path.rsplit(['/', '\\']).next().unwrap_or(&m.path) }));
    }
    let script = std::env::temp_dir().join(format!("videounify-{}.txt", std::process::id()));
    std::fs::write(&script, build_filter(&items)).map_err(|e| e.to_string())?;
    job.cancelled.store(false, Ordering::SeqCst);

    let mut child = Command::new(ffmpeg())
        .args(build_args(&items, &script.to_string_lossy(), &out))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    *job.child.lock().unwrap() = Some(child);

    // Drain stderr on its own thread so ffmpeg never blocks on a full pipe.
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let total: f64 = items.iter().map(|i| i.duration).sum::<f64>().max(0.001);
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.trim().parse::<f64>().ok()) {
            let _ = app.emit("progress", (us / 1e6 / total).clamp(0.0, 1.0));
        }
    }
    let status = job.child.lock().unwrap().take().map(|mut c| c.wait());
    let err = err_thread.join().unwrap_or_default();
    let _ = std::fs::remove_file(&script);

    if job.cancelled.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&out);
        return Ok(json!({ "cancelled": true }));
    }
    match status {
        Some(Ok(s)) if s.success() => Ok(json!({ "ok": true, "out": out })),
        _ => {
            let _ = std::fs::remove_file(&out);
            let tail: Vec<&str> = err.lines().rev().take(3).collect();
            Ok(json!({ "error": tail.into_iter().rev().collect::<Vec<_>>().join(" ") }))
        }
    }
}

#[tauri::command]
fn cancel(job: State<'_, Job>) {
    job.cancelled.store(true, Ordering::SeqCst);
    if let Some(c) = job.child.lock().unwrap().as_mut() {
        let _ = c.kill();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Job::default())
        .invoke_handler(tauri::generate_handler![probe, thumb, export, cancel])
        .run(tauri::generate_context!())
        .expect("error while running VideoUnify");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(w: u32, h: u32, has_audio: bool, duration: f64) -> Item {
        Item { path: "x.mp4".into(), w, h, has_audio, duration }
    }

    #[test]
    fn filter_scales_to_first_clip_and_pads_silence() {
        let f = build_filter(&[item(1920, 1080, true, 5.0), item(640, 480, false, 3.0)]);
        assert!(f.contains("scale=1920:1080"));
        assert!(f.contains("anullsrc=r=48000:cl=stereo,atrim=duration=3[a1]"));
        assert!(f.contains("concat=n=2:v=1:a=1[v][a]"));
    }

    #[test]
    fn odd_sizes_become_even() {
        assert_eq!((even(1919), even(1), even(0)), (1920, 2, 2));
    }

    #[test]
    fn parses_ffmpeg_banner() {
        let t = "  Duration: 00:01:02.50, start: 0.0, bitrate: 900 kb/s\n  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 30 fps\n  Stream #0:1: Audio: aac, 44100 Hz\n";
        assert_eq!(parse_info(t), Some(Info { w: 1920, h: 1080, has_audio: true, duration: 62.5 }));
    }

    #[test]
    fn rotation_swaps_dimensions_and_no_audio() {
        let t = "  Duration: 00:00:03.00, x\n  Stream #0:0: Video: h264, yuv420p, 1920x1080, 30 fps\n    displaymatrix: rotation of -90.00 degrees\n";
        let i = parse_info(t).unwrap();
        assert_eq!((i.w, i.h, i.has_audio), (1080, 1920, false));
    }
}
