//! SNACK — control center backend.
//!
//! Manages the GenieX NPU inference server (child process), persists a tiny
//! config.json, exposes doctor checks, and launches the selected chat harness
//! (Hermes, Pi, or DeepSeek Harness).
//!
//! Layout (installed):
//!   C:\Snack\geniex\geniex.exe        runtime
//!   C:\Snack\models\<Id>\<Id>.gguf    one dir per model (load-bearing)
//!   C:\Snack\config.json              { model, nctx, port }

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Installed root. Overridable via SNACK_HOME for dev/tests.
fn snack_home() -> std::path::PathBuf {
    if let Ok(h) = std::env::var("SNACK_HOME") {
        return std::path::PathBuf::from(h);
    }
    std::path::PathBuf::from("C:\\Snack")
}

#[derive(Serialize, Deserialize, Clone)]
struct Config {
    model: String,
    nctx: u32,
    port: u16,
    #[serde(default = "default_q8")]
    cache_type_k: String,
    #[serde(default = "default_q4")]
    cache_type_v: String,
    /// Chat harness: "hermes" | "pi" | "dsh" (DeepSeek Harness).
    #[serde(default = "default_harness")]
    harness: String,
}

fn default_q8() -> String { "Q8_0".into() }
fn default_q4() -> String { "Q4_0".into() }
fn default_harness() -> String { "hermes".into() }

impl Default for Config {
    fn default() -> Self {
        Self {
            model: "qualcomm/Qwen3.8-9B".into(),
            nctx: 65536,
            port: 18181,
            cache_type_k: "Q8_0".into(),
            cache_type_v: "Q4_0".into(),
            harness: default_harness(),
        }
    }
}

struct ServerState {
    child: Option<std::process::Child>,
    log: std::collections::VecDeque<String>, // tail of geniex output
}

struct State(Arc<Mutex<ServerState>>);

fn config_path() -> std::path::PathBuf {
    snack_home().join("config.json")
}

fn load_config() -> Config {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(c: &Config) -> Result<(), String> {
    std::fs::write(config_path(), serde_json::to_string_pretty(c).unwrap())
        .map_err(|e| e.to_string())
}

fn geniex_exe() -> std::path::PathBuf {
    // Installed layout (C:\Snack\geniex) first; fall back to the standalone
    // GenieX installer location (C:\GenieX).
    let primary = snack_home().join("geniex").join("geniex.exe");
    if primary.exists() {
        return primary;
    }
    std::path::PathBuf::from(r"C:\GenieX\geniex.exe")
}

/// Directory containing the plugin subdirs + geniex.dll (for GENIEX_PLUGIN_PATH).
fn geniex_plugin_root() -> std::path::PathBuf {
    if snack_home().join("geniex").join("geniex.exe").exists() {
        return snack_home().join("geniex");
    }
    std::path::PathBuf::from(r"C:\GenieX")
}

fn base_url(cfg: &Config) -> String {
    format!("http://127.0.0.1:{}/v1", cfg.port)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ServerStatus {
    state: String, // "stopped" | "warming" | "running"
    model: String,
    nctx: u32,
    port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    measured_tps: Option<f32>,
}

/// Parse the last "t/s" decode-rate figure out of the log tail, if present.
/// GenieX serve prints progress lines like `… 12.3 t/s …` while decoding.
fn parse_tps(log: &std::collections::VecDeque<String>) -> Option<f32> {
    let mut last: Option<f32> = None;
    for line in log.iter().rev() {
        if let Some(pos) = line.find("t/s") {
            let head = &line[..pos];
            let start = head.rfind(|c: char| !c.is_ascii_digit() && c != '.').map(|i| i + 1).unwrap_or(0);
            if let Ok(v) = head[start..].parse::<f32>() {
                last = Some(v);
                break;
            }
        }
    }
    last
}

fn http_ok(url: &str, timeout: Duration) -> bool {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .ok()
        .and_then(|c| c.get(url).send().ok())
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Shared async HTTP client - one connection pool for the whole app.
/// (The old code built a fresh blocking client per poll: expensive and it
/// ran on the window's main thread.)
fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// True if the server answers /v1/models (regardless of who started it).
/// Blocking variant - only for spawn_blocking contexts (doctor).
fn server_alive(cfg: &Config) -> bool {
    http_ok(&format!("{}/models", base_url(cfg)), Duration::from_secs(5))
}

/// Async variant for UI-polled commands: never touches the main thread.
async fn server_alive_async(cfg: &Config) -> bool {
    http_client()
        .get(format!("{}/models", base_url(cfg)))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn ensure_geniex_env(cmd: &mut Command) {
    let root = geniex_plugin_root();
    cmd.env("GENIEX_PLUGIN_PATH", root.to_string_lossy().to_string())
        .current_dir(root);
}

/// Suppress the console window of spawned child processes on Windows
/// (CREATE_NO_WINDOW). No-op elsewhere.
#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

// ---------------------------------------------------------------- update check

const GITHUB_REPO: &str = "TurtleTortOS/snack";
const HF_REPO: &str = "TurtletortOS/snack-models";

#[derive(Serialize, Clone)]
struct UpdateInfo {
    current_version: String,
    latest_tag: String,
    latest_published: String,
    has_update: bool,
    download_url: Option<String>,
    release_url: String,
}

/// Check GitHub for the latest SNACK release.
#[tauri::command]
async fn check_for_updates() -> Result<UpdateInfo, String> {
    let current = option_env!("CARGO_PKG_VERSION").unwrap_or("0.0.0");
    let url = format!("https://api.github.com/repos/{}/releases/latest", GITHUB_REPO);

    let body = http_client()
        .get(&url)
        .timeout(Duration::from_secs(10))
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "SNACK-Updater")
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?
        .text()
        .await
        .map_err(|e| format!("read error: {}", e))?;

    let release: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("json error: {}", e))?;

    let tag = release["tag_name"].as_str().unwrap_or("unknown").to_string();
    let published = release["published_at"].as_str().unwrap_or("unknown").to_string();
    let release_url = release["html_url"].as_str().unwrap_or("").to_string();

    // Find the Windows ARM64 installer asset
    let download_url = release["assets"]
        .as_array()
        .and_then(|a| {
            a.iter()
                .find(|a| {
                    let name = a["name"].as_str().unwrap_or("");
                    name.contains("windows-arm64") && name.ends_with(".exe")
                })
                .map(|a| a["browser_download_url"].as_str().unwrap_or("").to_string())
        });

    Ok(UpdateInfo {
        current_version: current.to_string(),
        latest_tag: tag,
        latest_published: published,
        has_update: release["tag_name"].as_str() != Some(current),
        download_url,
        release_url,
    })
}

#[derive(Serialize, Clone)]
struct ModelDownloadStatus {
    model_id: String,
    status: String, // "downloading" | "complete" | "error"
    progress: Option<f32>, // 0.0-1.0
    error: Option<String>,
}

/// Download a model from HuggingFace to the local cache directory.
/// Returns immediately with a status; progress is polled via model_download_progress.
#[tauri::command]
fn model_download(model_id: String) -> Result<ModelDownloadStatus, String> {
    let home = snack_home();
    let models_root = home.join("models");
    let model_name = model_id.rsplit('/').next().unwrap_or(&model_id);
    let model_dir = models_root.join(model_name);
    let gguf_path = model_dir.join(format!("{}.gguf", model_name));

    // Skip if already exists
    if gguf_path.exists() {
        return Ok(ModelDownloadStatus {
            model_id,
            status: "complete".into(),
            progress: Some(1.0),
            error: None,
        });
    }

    std::fs::create_dir_all(&model_dir).map_err(|e| e.to_string())?;

    let url = format!("https://huggingface.co/{}/resolve/main/{}.gguf", HF_REPO, model_name);

    // Spawn download in background thread
    let model_id_clone = model_id.clone();
    let gguf_clone = gguf_path.clone();
    let model_name_clone = model_name.clone();
    let model_dir_clone = model_dir.clone();
    std::thread::spawn(move || -> Option<()> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(3600))
            .build()
            .ok()?;

        let mut response = client.get(&url).send().ok()?;

        if !response.status().is_success() {
            return None;
        }

        let content_length = response.content_length().unwrap_or(0);
        let mut file = std::fs::File::create(&gguf_clone).ok()?;
        let mut downloaded: u64 = 0;
        let mut buffer = vec![0u8; 65536];

        // blocking::Response implements std::io::Read — stream it to disk
        loop {
            let n = match response.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => return None,
            };
            file.write_all(&buffer[..n]).ok()?;
            downloaded += n as u64;
            if content_length > 0 {
                let progress = downloaded as f32 / content_length as f32;
                // Progress is stored in a file for the polling thread
                let progress_file = gguf_clone.with_extension("progress");
                let _ = std::fs::write(&progress_file, format!("{}", progress));
            }
        }

        // Remove progress file on success
        let progress_file = gguf_clone.with_extension("progress");
        let _ = std::fs::remove_file(progress_file);

        // VLM companion: fetch mmproj-<name>.gguf when the repo carries one.
        // The progress marker is written first so model_download_progress keeps
        // reporting "downloading" until the projector lands (VLM pull needs it).
        let mmproj_name = format!("mmproj-{}.gguf", model_name_clone);
        let mmproj_url = format!("https://huggingface.co/{}/resolve/main/{}", HF_REPO, mmproj_name);
        let mmproj_path = model_dir_clone.join(&mmproj_name);
        let mmproj_progress = mmproj_path.with_extension("progress");
        if let Ok(head) = client.head(&mmproj_url).send() {
            if head.status().is_success() {
                let _ = std::fs::write(&mmproj_progress, "0");
                if let Ok(mut resp) = client.get(&mmproj_url).send() {
                    if resp.status().is_success() {
                        if let Ok(mut f) = std::fs::File::create(&mmproj_path) {
                            let mut buf = vec![0u8; 65536];
                            loop {
                                match resp.read(&mut buf) {
                                    Ok(0) => break,
                                    Ok(n) => {
                                        if f.write_all(&buf[..n]).is_err() {
                                            break;
                                        }
                                    }
                                    Err(_) => break,
                                }
                            }
                        }
                    }
                }
                let _ = std::fs::remove_file(&mmproj_progress);
            }
        }
        Some(())
    });

    Ok(ModelDownloadStatus {
        model_id: model_id_clone,
        status: "downloading".into(),
        progress: Some(0.0),
        error: None,
    })
}

/// Poll the download progress for a specific model.
#[tauri::command]
fn model_download_progress(model_id: String) -> Result<ModelDownloadStatus, String> {
    let home = snack_home();
    let models_root = home.join("models");
    let model_name = model_id.rsplit('/').next().unwrap_or(&model_id);
    let model_dir = models_root.join(model_name);
    let gguf_path = model_dir.join(format!("{}.gguf", model_name));
    let progress_file = gguf_path.with_extension("progress");

    if gguf_path.exists() {
        // VLM: main weights are down but the mmproj companion may still be
        // streaming; stay "downloading" until its marker clears.
        let mmproj_progress = model_dir.join(format!("mmproj-{}.progress", model_name));
        if mmproj_progress.exists() {
            return Ok(ModelDownloadStatus {
                model_id,
                status: "downloading".into(),
                progress: Some(1.0),
                error: None,
            });
        }
        return Ok(ModelDownloadStatus {
            model_id,
            status: "complete".into(),
            progress: Some(1.0),
            error: None,
        });
    }

    if progress_file.exists() {
        let content = std::fs::read_to_string(&progress_file).unwrap_or_default();
        let progress: f32 = content.trim().parse().unwrap_or(0.0);
        return Ok(ModelDownloadStatus {
            model_id,
            status: "downloading".into(),
            progress: Some(progress),
            error: None,
        });
    }

    Ok(ModelDownloadStatus {
        model_id,
        status: "idle".into(),
        progress: None,
        error: None,
    })
}

// ---------------------------------------------------------------- commands

#[tauri::command]
async fn server_toggle(app: tauri::AppHandle, on: bool) -> Result<ServerStatus, String> {
    let cfg = load_config();

    if !on {
        // full stop: kill our child if we own it
        let state = app.state::<State>();
        let mut guard = state.0.lock().unwrap();
        if let Some(mut child) = guard.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        return Ok(ServerStatus {
            state: "stopped".into(),
            model: cfg.model.clone(),
            nctx: cfg.nctx,
            port: cfg.port,
            measured_tps: None,
        });
    }

    // already answering? (async probe: off the main thread, off the lock)
    if server_alive_async(&cfg).await {
        return Ok(ServerStatus {
            state: "running".into(),
            model: cfg.model.clone(),
            nctx: cfg.nctx,
            port: cfg.port,
            measured_tps: None,
        });
    }

    // A child we already spawned is still booting - never double-spawn
    // (queued clicks must not pile up servers).
    {
        let state = app.state::<State>();
        let mut guard = state.0.lock().unwrap();
        if let Some(child) = &mut guard.child {
            if child.try_wait().ok().flatten().is_none() {
                return Ok(ServerStatus {
                    state: "warming".into(),
                    model: cfg.model.clone(),
                    nctx: cfg.nctx,
                    port: cfg.port,
                    measured_tps: None,
                });
            }
            guard.child = None; // reaped dead child
        }
    }

    if !geniex_exe().exists() {
        return Err(format!("GenieX runtime not found at {}", geniex_exe().display()));
    }

    let mut cmd = Command::new(geniex_exe());
    no_window(&mut cmd);
    // NOTE: GenieX `serve` has no --cache-type-k/v flags (verified on device:
    // "unknown flag"). KV quant is kept in config for the fit-estimate planning
    // tool and will be applied once the runtime exposes it.
    cmd.args([
        "serve",
        "--compute",
        "npu",
        "--nctx",
        &cfg.nctx.to_string(),
        "--host",
        &format!("127.0.0.1:{}", cfg.port),
        "--skip-update",
    ]);
    ensure_geniex_env(&mut cmd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to start geniex: {}", e))?;
    // Drain output in background threads; keep a small tail for the log panel.
    let state = app.state::<State>().0.clone();
    let state_err = state.clone();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    if let Some(s) = stdout {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(s);
            let mut buf = String::new();
            loop {
                buf.clear();
                match reader.read_line(&mut buf) {
                    Ok(0) => break,
                    Ok(_) => {
                        let mut guard = state.lock().unwrap();
                        guard.log.push_back(buf.trim_end().to_string());
                        while guard.log.len() > 400 {
                            guard.log.pop_front();
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }
    if let Some(s) = stderr {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(s);
            let mut buf = String::new();
            loop {
                buf.clear();
                match reader.read_line(&mut buf) {
                    Ok(0) => break,
                    Ok(_) => {
                        let mut guard = state_err.lock().unwrap();
                        guard.log.push_back(buf.trim_end().to_string());
                        while guard.log.len() > 400 {
                            guard.log.pop_front();
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }
    {
        let state = app.state::<State>();
        let mut guard = state.0.lock().unwrap();
        guard.child = Some(child);
    }

    // Don't block the UI: report "warming" now. The frontend polls
    // server_status; /v1/models answers once the server is up.
    Ok(ServerStatus {
        state: "warming".into(),
        model: cfg.model.clone(),
        nctx: cfg.nctx,
        port: cfg.port,
        measured_tps: None,
    })
}

#[tauri::command]
async fn server_status(app: tauri::AppHandle) -> Result<ServerStatus, String> {
    let cfg = load_config();
    // Probe first, off the lock and off the main thread (async command).
    let alive = server_alive_async(&cfg).await;
    let state = app.state::<State>();
    let guard = state.0.lock().unwrap();
    Ok(ServerStatus {
        state: if alive { "running" } else { "stopped" }.into(),
        model: cfg.model,
        nctx: cfg.nctx,
        port: cfg.port,
        measured_tps: if alive { parse_tps(&guard.log) } else { None },
    })
}

#[tauri::command]
fn log_tail(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let state = app.state::<State>();
    let guard = state.0.lock().unwrap();
    Ok(guard.log.iter().rev().take(120).cloned().collect())
}

#[derive(Serialize, Clone)]
struct SelectResult {
    warming: bool,
}

#[tauri::command]
fn model_select(id: String, nctx: Option<u32>) -> Result<SelectResult, String> {
    let mut cfg = load_config();
    let changed = cfg.model != id;
    cfg.model = id;
    if let Some(n) = nctx {
        cfg.nctx = n;
    }
    save_config(&cfg)?;
    Ok(SelectResult { warming: changed })
}

#[tauri::command]
fn model_context(id: String, nctx: u32, cache_type_k: Option<String>, cache_type_v: Option<String>) -> Result<bool, String> {
    if id == load_config().model {
        let mut cfg = load_config();
        cfg.nctx = nctx;
        if let Some(k) = cache_type_k {
            cfg.cache_type_k = k;
        }
        if let Some(v) = cache_type_v {
            cfg.cache_type_v = v;
        }
        save_config(&cfg)?;
    }
    Ok(true)
}

#[tauri::command]
fn config_get() -> Result<Config, String> {
    Ok(load_config())
}

#[tauri::command]
async fn models_reregister() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(models_reregister_blocking)
        .await
        .map_err(|e| e.to_string())?
}

fn models_reregister_blocking() -> Result<bool, String> {
    // `geniex pull` from each isolated model dir; the dir layout is what makes
    // the localfs hub unambiguous (one <Id>.gguf per dir).
    let models_root = snack_home().join("models");
    let mut ok = true;
    if models_root.exists() {
        for entry in std::fs::read_dir(&models_root).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let id = dir.file_name().unwrap().to_string_lossy().to_string();
            let gguf = dir.join(format!("{}.gguf", id));
            if !gguf.exists() {
                continue;
            }
            let mut cmd = Command::new(geniex_exe());
            no_window(&mut cmd);
            // mmproj-*.gguf in the dir marks a VLM; pull must record the type
            let is_vlm = std::fs::read_dir(&dir)
                .map(|rd| {
                    rd.filter_map(|e| e.ok())
                        .any(|e| e.file_name().to_string_lossy().starts_with("mmproj-"))
                })
                .unwrap_or(false);
            cmd.args([
                "pull",
                &id,
                "--model-hub",
                "localfs",
            ]);
            if is_vlm {
                cmd.args(["--model-type", "vlm"]);
            }
            cmd.args(["--local-path", &dir.to_string_lossy()]);
            ensure_geniex_env(&mut cmd);
            let status = cmd
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map_err(|e| e.to_string())?;
            ok = ok && status.success();
        }
    }
    Ok(ok)
}

#[tauri::command]
fn harness_select(harness: String) -> Result<String, String> {
    if !["hermes", "pi", "dsh"].contains(&harness.as_str()) {
        return Err(format!("unknown harness: {}", harness));
    }
    let mut cfg = load_config();
    cfg.harness = harness.clone();
    save_config(&cfg)?;
    Ok(harness)
}

#[tauri::command]
fn chat_launch() -> Result<bool, String> {
    let cfg = load_config();
    let user = std::env::var("USERPROFILE").unwrap_or_default();
    match cfg.harness.as_str() {
        // Pi: open a console window running `pi` (pre-pointed at the SNACK
        // endpoint by %USERPROFILE%\.pi\agent\models.json, written by the
        // installer).
        "pi" => {
            let _ = Command::new("cmd")
                .args(["/C", "start", "SNACK Pi", "cmd", "/K", "pi"])
                .spawn();
            Ok(true)
        }
        // DeepSeek Harness: Start Menu shortcut from the installer; fall back
        // to npx directly.
        "dsh" => {
            let lnk = format!(
                "{}/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/SNACK DeepSeek Harness.lnk",
                user
            );
            if std::path::Path::new(&lnk).exists() {
                let _ = Command::new("cmd").args(["/C", "start", "", &lnk]).spawn();
            } else {
                let _ = Command::new("cmd")
                    .args(["/C", "start", "SNACK DeepSeek Harness", "npx", "@deepseek-ai/dsh", "web"])
                    .spawn();
            }
            Ok(true)
        }
        // Hermes (default): desktop shortcut if present, else the Start Menu
        // link, else the installed binary. Best-effort.
        _ => {
            let candidates = [
                format!("{}/Desktop/Hermes.lnk", user),
                format!(
                    "{}/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Hermes.lnk",
                    user
                ),
            ];
            for c in &candidates {
                if std::path::Path::new(c).exists() {
                    let _ = Command::new("cmd").args(["/C", "start", "", c]).spawn();
                    return Ok(true);
                }
            }
            let _ = Command::new("cmd").args(["/C", "start", "", "Hermes"]).spawn();
            Ok(true)
        }
    }
}

#[derive(Serialize, Clone)]
struct DoctorRow {
    name: String,
    pass: bool,
    fix: Option<String>,
}

#[tauri::command]
async fn doctor_run() -> Result<Vec<DoctorRow>, String> {
    // Doctor spawns PowerShell/where.exe and may run a smoke inference - all
    // blocking work goes to a blocking thread, never the main thread.
    tauri::async_runtime::spawn_blocking(doctor_run_blocking)
        .await
        .map_err(|e| format!("doctor failed: {}", e))?
}

fn doctor_run_blocking() -> Result<Vec<DoctorRow>, String> {
    let home = snack_home();
    let cfg = load_config();
    let mut rows = Vec::new();

    // 1. NPU present: look for Qualcomm Hexagon in the device list.
    let mut npu = false;
    {
        let mut cmd = Command::new("powershell");
        no_window(&mut cmd);
        cmd.args([
            "-NoProfile",
            "-Command",
            "Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'Hexagon|Qualcomm' } | Select-Object -First 1 -ExpandProperty FriendlyName",
        ]);
        if let Ok(out) = cmd.output() {
            let s = String::from_utf8_lossy(&out.stdout);
            npu = !s.trim().is_empty();
        }
    }
    rows.push(DoctorRow {
        name: "NPU present".into(),
        pass: npu,
        fix: Some("NPU not detected — check Device Manager / Windows updates.".into()),
    });

    // 2. GenieX runtime intact.
    let runtime_ok = geniex_exe().exists();
    rows.push(DoctorRow {
        name: "GenieX runtime intact".into(),
        pass: runtime_ok,
        fix: Some("Run SnackSetup.exe again.".into()),
    });

    // 3. Model files present: either the bundled C:\Snack\models layout or the
    //    registered GenieX model cache (the installed-model path).
    let model_ids = ["qualcomm/Qwen3.8-4B", "qualcomm/Qwen3.8-9B"];
    let cache_root = std::path::Path::new(&std::env::var("USERPROFILE").unwrap_or_default())
        .join(".cache")
        .join("geniex")
        .join("models");
    let mut models_ok = true;
    for id in &model_ids {
        let dir_name = id.rsplit('/').next().unwrap_or(id);
        let bundled = home.join("models").join(dir_name).join(format!("{}.gguf", dir_name));
        let registered = cache_root.join(dir_name).join(format!("{}.gguf", dir_name));
        if !bundled.exists() && !registered.exists() {
            models_ok = false;
        }
    }
    rows.push(DoctorRow {
        name: "Model files present".into(),
        pass: models_ok,
        fix: Some("Re-fetch models (System → Models).".into()),
    });

    // 4. Model manager IDs registered (cache metadata exists).
    let cache = std::path::Path::new(&std::env::var("USERPROFILE").unwrap_or_default())
        .join(".cache")
        .join("geniex")
        .join("models");
    rows.push(DoctorRow {
        name: "Model manager IDs registered".into(),
        pass: cache.exists(),
        fix: Some("Click 'Re-register models'.".into()),
    });

    // 5. Server on port.
    let alive = server_alive(&cfg);
    rows.push(DoctorRow {
        name: format!("Server on port {}", cfg.port),
        pass: alive,
        fix: Some("Toggle the server on (Home).".into()),
    });

    // 6. Inference smoke test (only meaningful if server is up).
    let mut smoke = false;
    if alive {
        let url = format!("{}/chat/completions", base_url(&cfg));
        let body = serde_json::json!({
            "model": cfg.model,
            "messages": [{"role": "user", "content": "Say hi in one word."}],
            "max_tokens": 8,
            "temperature": 0.3
        });
        smoke = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .ok()
            .and_then(|c| {
                c.post(&url)
                    .json(&body)
                    .send()
                    .ok()
                    .map(|r| r.status().is_success())
            })
            .unwrap_or(false);
    }
    rows.push(DoctorRow {
        name: "Inference smoke test".into(),
        pass: smoke,
        fix: Some("Server down or model failed to load — see log tail.".into()),
    });

    // 7. Selected harness installed (hermes | pi | dsh).
    let user = std::env::var("USERPROFILE").unwrap_or_default();
    let npm_bin = std::path::Path::new(&user).join("AppData").join("Roaming").join("npm");
    let (harness_name, harness_ok, harness_fix) = match cfg.harness.as_str() {
        "pi" => (
            "Pi harness installed",
            npm_bin.join("pi.cmd").exists() || server_cmd_exists("pi"),
            "Install Pi via SnackSetup (choose Pi) or: irm https://pi.dev/install.ps1 | iex",
        ),
        "dsh" => (
            "DeepSeek Harness installed",
            npm_bin.join("dsh.cmd").exists() || server_cmd_exists("dsh"),
            "Install DeepSeek Harness via SnackSetup (choose DeepSeek) or: npm install -g @deepseek-ai/dsh",
        ),
        _ => (
            "Hermes installed",
            std::path::Path::new(&user)
                .join("AppData")
                .join("Local")
                .join("hermes")
                .exists(),
            "Install Hermes (SnackSetup or the Hermes installer)",
        ),
    };
    rows.push(DoctorRow {
        name: harness_name.into(),
        pass: harness_ok,
        fix: Some(harness_fix.into()),
    });

    // 8. Node.js (only required for the Pi / DeepSeek harnesses).
    if matches!(cfg.harness.as_str(), "pi" | "dsh") {
        rows.push(DoctorRow {
            name: "Node.js present (harness)".into(),
            pass: server_cmd_exists("node"),
            fix: Some("Install Node.js 22+ (SnackSetup does it automatically for Pi/DeepSeek).".into()),
        });
    }

    Ok(rows)
}

/// True if an executable resolves on PATH (where.exe lookup).
fn server_cmd_exists(cmd_name: &str) -> bool {
    let mut cmd = Command::new("where.exe");
    no_window(&mut cmd);
    cmd.arg(cmd_name)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

// ---------------------------------------------------------------- run

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(State(std::sync::Arc::new(Mutex::new(ServerState { child: None, log: std::collections::VecDeque::new() }))))
        .invoke_handler(tauri::generate_handler![
            server_toggle,
            server_status,
            log_tail,
            model_select,
            model_context,
            config_get,
            models_reregister,
            chat_launch,
            harness_select,
            doctor_run,
            check_for_updates,
            model_download,
            model_download_progress
        ])
        .run(tauri::generate_context!())
        .expect("error while running SNACK");
}
