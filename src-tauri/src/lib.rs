//! SNACK — control center backend.
//!
//! Manages the GenieX NPU inference server (child process), persists a tiny
//! config.json, exposes doctor checks, and launches Hermes for chat.
//!
//! Layout (installed):
//!   C:\Snack\geniex\geniex.exe        runtime
//!   C:\Snack\models\<Id>\<Id>.gguf    one dir per model (load-bearing)
//!   C:\Snack\config.json              { model, nctx, port }

use std::process::{Command, Stdio};
use std::sync::Mutex;
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
}

impl Default for Config {
    fn default() -> Self {
        Self {
            model: "qualcomm/Qwen3.8-9B".into(),
            nctx: 65536,
            port: 18181,
        }
    }
}

struct ServerState {
    child: Option<std::process::Child>,
}

struct State(Mutex<ServerState>);

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
    snack_home().join("geniex").join("geniex.exe")
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

/// True if the server answers /v1/models (regardless of who started it).
fn server_alive(cfg: &Config) -> bool {
    http_ok(&format!("{}/models", base_url(cfg)), Duration::from_secs(5))
}

fn ensure_geniex_env(cmd: &mut Command) {
    let home = snack_home();
    cmd.env("GENIEX_PLUGIN_PATH", home.join("geniex").to_string_lossy().to_string())
        .current_dir(home.join("geniex"));
}

// ---------------------------------------------------------------- commands

#[tauri::command]
fn server_toggle(app: tauri::AppHandle, on: bool) -> Result<ServerStatus, String> {
    let state = app.state::<State>();
    let mut guard = state.0.lock().unwrap();
    let cfg = load_config();

    if !on {
        // full stop: kill our child if we own it
        if let Some(mut child) = guard.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        return Ok(ServerStatus {
            state: "stopped".into(),
            model: cfg.model.clone(),
            nctx: cfg.nctx,
            port: cfg.port,
        });
    }

    // already answering?
    if server_alive(&cfg) {
        return Ok(ServerStatus {
            state: "running".into(),
            model: cfg.model.clone(),
            nctx: cfg.nctx,
            port: cfg.port,
        });
    }

    if !geniex_exe().exists() {
        return Err(format!("GenieX runtime not found at {}", geniex_exe().display()));
    }

    let mut cmd = Command::new(geniex_exe());
    cmd.args([
        "serve",
        "--compute",
        "npu",
        "--nctx",
        &cfg.nctx.to_string(),
        "--host",
        &format!("127.0.0.1:{}", cfg.port),
    ]);
    ensure_geniex_env(&mut cmd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to start geniex: {}", e))?;
    guard.child = Some(child);

    // Don't block the UI: report "warming" now. The frontend polls
    // server_status; /v1/models answers once the server is up.
    Ok(ServerStatus {
        state: "warming".into(),
        model: cfg.model.clone(),
        nctx: cfg.nctx,
        port: cfg.port,
    })
}

#[tauri::command]
fn server_status(app: tauri::AppHandle) -> Result<ServerStatus, String> {
    let cfg = load_config();
    let state = if server_alive(&cfg) {
        "running"
    } else {
        "stopped"
    };
    Ok(ServerStatus {
        state: state.into(),
        model: cfg.model,
        nctx: cfg.nctx,
        port: cfg.port,
    })
}

#[tauri::command]
fn model_select(id: String, nctx: Option<u32>) -> Result<bool, String> {
    let mut cfg = load_config();
    cfg.model = id;
    if let Some(n) = nctx {
        cfg.nctx = n;
    }
    save_config(&cfg)?;
    Ok(true)
}

#[tauri::command]
fn model_context(id: String, nctx: u32) -> Result<bool, String> {
    if id == load_config().model {
        let mut cfg = load_config();
        cfg.nctx = nctx;
        save_config(&cfg)?;
    }
    Ok(true)
}

#[tauri::command]
fn config_get() -> Result<Config, String> {
    Ok(load_config())
}

#[tauri::command]
fn models_reregister() -> Result<bool, String> {
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
            cmd.args([
                "pull",
                &id,
                "--model-hub",
                "localfs",
                "--local-path",
                &dir.to_string_lossy(),
            ]);
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
fn chat_launch() -> Result<bool, String> {
    // Open Hermes: desktop shortcut if present, else the app path, else the
    // installed binary. Best-effort.
    let user = std::env::var("USERPROFILE").unwrap_or_default();
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

#[derive(Serialize, Clone)]
struct DoctorRow {
    name: String,
    pass: bool,
    fix: Option<String>,
}

#[tauri::command]
fn doctor_run() -> Result<Vec<DoctorRow>, String> {
    let home = snack_home();
    let cfg = load_config();
    let mut rows = Vec::new();

    // 1. NPU present: look for Qualcomm Hexagon in the device list.
    let mut npu = false;
    if let Ok(out) = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'Hexagon|Qualcomm' } | Select-Object -First 1 -ExpandProperty FriendlyName",
        ])
        .output()
    {
        let s = String::from_utf8_lossy(&out.stdout);
        npu = !s.trim().is_empty();
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

    // 3. Model files present (both catalog entries).
    let model_ids = ["qualcomm/Qwen3.8-4B", "qualcomm/Qwen3.8-9B"];
    let mut models_ok = true;
    for id in &model_ids {
        let dir_name = id.rsplit('/').next().unwrap_or(id);
        let f = home.join("models").join(dir_name).join(format!("{}.gguf", dir_name));
        if !f.exists() {
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

    // 7. Hermes reachable.
    let user = std::env::var("USERPROFILE").unwrap_or_default();
    let hermes = std::path::Path::new(&user)
        .join("AppData")
        .join("Local")
        .join("hermes")
        .exists();
    rows.push(DoctorRow {
        name: "Hermes installed".into(),
        pass: hermes,
        fix: Some("Install Hermes (SnackSetup or the Hermes installer).".into()),
    });

    Ok(rows)
}

// ---------------------------------------------------------------- run

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(State(Mutex::new(ServerState { child: None })))
        .invoke_handler(tauri::generate_handler![
            server_toggle,
            server_status,
            model_select,
            model_context,
            config_get,
            models_reregister,
            chat_launch,
            doctor_run
        ])
        .run(tauri::generate_context!())
        .expect("error while running SNACK");
}
