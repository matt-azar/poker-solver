// Copyright (c) Matt Azar. UNLICENSED — no license is granted.
//! Hold'em Study Tauri shell: loads the Vite UI and manages the explorer sidecar.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// HTTP port the production UI uses for API calls (`http://127.0.0.1:8765`).
const ENGINE_PORT: u16 = 8765;

/// Bundle key in `tauri.conf.json` `bundle.externalBin` (build-time path under
/// `src-tauri/`). At install time Tauri places only the **basename** next to the
/// app (`holdem-explorer.exe`). Do not pass this string to `shell().sidecar()` —
/// that joins it under the exe dir and looks for a non-existent `binaries/` folder.
const EXPLORER_EXTERNAL_BIN: &str = "binaries/holdem-explorer";

/// Runtime sidecar basename beside the app executable (and under target/debug).
const EXPLORER_SIDECAR_BASENAME: &str = "holdem-explorer";

/// How long to wait for the sidecar to accept TCP on ENGINE_PORT after spawn.
const ENGINE_READY_TIMEOUT: Duration = Duration::from_secs(12);
const ENGINE_READY_POLL: Duration = Duration::from_millis(100);

struct EngineState {
    child: Mutex<Option<CommandChild>>,
    status: Mutex<String>,
}

impl EngineState {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
            status: Mutex::new("not started".into()),
        }
    }

    fn set_status(&self, msg: impl Into<String>) {
        if let Ok(mut s) = self.status.lock() {
            *s = msg.into();
        }
    }

    fn status_text(&self) -> String {
        self.status
            .lock()
            .map(|s| s.clone())
            .unwrap_or_else(|_| "status lock poisoned".into())
    }

    fn take_child(&self) -> Option<CommandChild> {
        self.child.lock().ok().and_then(|mut g| g.take())
    }

    fn store_child(&self, child: CommandChild) {
        if let Ok(mut g) = self.child.lock() {
            *g = Some(child);
        }
    }

    fn has_child(&self) -> bool {
        self.child
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false)
    }
}

#[tauri::command]
fn engine_port() -> u16 {
    ENGINE_PORT
}

#[tauri::command]
fn engine_status(state: State<'_, EngineState>) -> String {
    state.status_text()
}

/// Filename under the app config dir for assistant secrets (prototype).
/// Not OS keychain / Stronghold — see docs for backend-proxy product path.
const ASSISTANT_SECRETS_FILE: &str = "assistant_secrets.json";

#[derive(Default, Serialize, Deserialize)]
struct AssistantSecretsFile {
    /// service → secret value. Values are never logged by these commands.
    secrets: HashMap<String, String>,
}

fn assistant_secrets_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("app config dir unavailable: {err}"))?;
    fs::create_dir_all(&dir).map_err(|err| format!("create config dir: {err}"))?;
    Ok(dir.join(ASSISTANT_SECRETS_FILE))
}

fn read_assistant_secrets(path: &Path) -> Result<AssistantSecretsFile, String> {
    if !path.is_file() {
        return Ok(AssistantSecretsFile::default());
    }
    let raw = fs::read_to_string(path).map_err(|err| format!("read secrets: {err}"))?;
    if raw.trim().is_empty() {
        return Ok(AssistantSecretsFile::default());
    }
    serde_json::from_str(&raw).map_err(|err| format!("parse secrets: {err}"))
}

fn write_assistant_secrets(path: &Path, file: &AssistantSecretsFile) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(file).map_err(|err| format!("serialize secrets: {err}"))?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut out = fs::File::create(&tmp).map_err(|err| format!("create secrets tmp: {err}"))?;
        out
            .write_all(raw.as_bytes())
            .map_err(|err| format!("write secrets tmp: {err}"))?;
        out.sync_all().ok();
    }
    fs::rename(&tmp, path).map_err(|err| format!("replace secrets file: {err}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn normalize_secret_service(service: &str) -> Result<String, String> {
    let trimmed = service.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return Err("service name must be 1..=64 characters".into());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("service name must be ascii alphanumeric/_/-".into());
    }
    Ok(trimmed.to_string())
}

/// Read one assistant credential from the native config-dir store.
/// Prefer this over webview localStorage for the desktop prototype.
#[tauri::command]
fn assistant_secret_get(app: AppHandle, service: String) -> Result<Option<String>, String> {
    let key = normalize_secret_service(&service)?;
    let path = assistant_secrets_path(&app)?;
    let file = read_assistant_secrets(&path)?;
    Ok(file.secrets.get(&key).cloned())
}

#[tauri::command]
fn assistant_secret_set(app: AppHandle, service: String, value: String) -> Result<(), String> {
    let key = normalize_secret_service(&service)?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("secret value must be non-empty".into());
    }
    if trimmed.len() > 8192 {
        return Err("secret value too long".into());
    }
    let path = assistant_secrets_path(&app)?;
    let mut file = read_assistant_secrets(&path)?;
    file.secrets.insert(key, trimmed.to_string());
    write_assistant_secrets(&path, &file)
}

#[tauri::command]
fn assistant_secret_clear(app: AppHandle, service: String) -> Result<(), String> {
    let key = normalize_secret_service(&service)?;
    let path = assistant_secrets_path(&app)?;
    let mut file = read_assistant_secrets(&path)?;
    file.secrets.remove(&key);
    if file.secrets.is_empty() && path.is_file() {
        fs::remove_file(&path).map_err(|err| format!("remove secrets file: {err}"))?;
        return Ok(());
    }
    write_assistant_secrets(&path, &file)
}

#[tauri::command]
fn assistant_secret_has(app: AppHandle, service: String) -> Result<bool, String> {
    let key = normalize_secret_service(&service)?;
    let path = assistant_secrets_path(&app)?;
    let file = read_assistant_secrets(&path)?;
    Ok(file.secrets.contains_key(&key))
}

/// Ensure the explorer sidecar is running and accepting connections.
/// Safe to call from the UI on startup and on Reconnect.
#[tauri::command]
fn ensure_engine(app: AppHandle, state: State<'_, EngineState>) -> Result<String, String> {
    if engine_port_ready() {
        let msg = format!("ready on port {ENGINE_PORT}");
        state.set_status(msg.clone());
        return Ok(msg);
    }
    // Stale child handle without a listening port — restart.
    kill_stored_child(&state);
    spawn_and_wait(&app, &state)
}

fn engine_port_ready() -> bool {
    TcpStream::connect_timeout(
        &([127, 0, 0, 1], ENGINE_PORT).into(),
        Duration::from_millis(200),
    )
    .is_ok()
}

fn wait_until_engine_ready(deadline: Instant) -> bool {
    while Instant::now() < deadline {
        if engine_port_ready() {
            return true;
        }
        std::thread::sleep(ENGINE_READY_POLL);
    }
    engine_port_ready()
}

/// Remove Windows Mark-of-the-Web so SmartScreen does not block the sidecar.
#[cfg(target_os = "windows")]
fn unblock_path(path: &Path) {
    let mut ads = path.as_os_str().to_owned();
    ads.push(":Zone.Identifier");
    let _ = std::fs::remove_file(PathBuf::from(ads));
}

#[cfg(not(target_os = "windows"))]
fn unblock_path(_path: &Path) {}

fn sidecar_on_disk(app: &AppHandle) -> Option<PathBuf> {
    let resource = app.path().resource_dir().ok()?;
    // Packaged: sidecar sits next to the main exe (basename of externalBin).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let beside = dir.join("holdem-explorer.exe");
            if beside.is_file() {
                return Some(beside);
            }
            #[cfg(not(windows))]
            {
                let beside = dir.join("holdem-explorer");
                if beside.is_file() {
                    return Some(beside);
                }
            }
        }
    }
    // Dev / alternate layouts under resource_dir.
    let candidates = [
        resource.join("holdem-explorer.exe"),
        resource.join("holdem-explorer"),
        resource.join("binaries").join("holdem-explorer.exe"),
        resource.join("binaries").join("holdem-explorer"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

fn kill_stored_child(state: &EngineState) {
    if let Some(child) = state.take_child() {
        if let Err(err) = child.kill() {
            eprintln!("warning: failed to kill explorer sidecar: {err}");
        }
    }
}

/// Build a shell Command that runs the installed/dev sidecar.
///
/// Prefer an absolute on-disk path. `shell().sidecar("binaries/holdem-explorer")`
/// wrongly resolves to `<exe_dir>/binaries/holdem-explorer[.exe]` even though
/// the NSIS payload places `<exe_dir>/holdem-explorer.exe` (basename only).
fn explorer_command(
    app: &AppHandle,
    on_disk: Option<&Path>,
) -> Result<(tauri_plugin_shell::process::Command, String), String> {
    if let Some(path) = on_disk {
        let label = path.display().to_string();
        return Ok((app.shell().command(path.as_os_str()), label));
    }
    // Dev / odd layouts: try basename first, then the externalBin key as a last resort.
    match app.shell().sidecar(EXPLORER_SIDECAR_BASENAME) {
        Ok(cmd) => Ok((cmd, EXPLORER_SIDECAR_BASENAME.to_string())),
        Err(basename_err) => app
            .shell()
            .sidecar(EXPLORER_EXTERNAL_BIN)
            .map(|cmd| (cmd, EXPLORER_EXTERNAL_BIN.to_string()))
            .map_err(|err| {
                format!(
                    "missing sidecar `{EXPLORER_SIDECAR_BASENAME}` (basename: {basename_err}; \
                     externalBin `{EXPLORER_EXTERNAL_BIN}`: {err}). \
                     Reinstall so holdem-explorer.exe is next to the app."
                )
            }),
    }
}

fn spawn_once(
    app: &AppHandle,
    state: &EngineState,
    on_disk: Option<&Path>,
    port: &str,
) -> Result<(), String> {
    let (cmd, label) = explorer_command(app, on_disk).map_err(|err| {
        state.set_status(err.clone());
        err
    })?;
    let (_rx, child) = cmd.args(["--port", port]).spawn().map_err(|err| {
        let msg = format!(
            "spawn failed for `{label}` on port {ENGINE_PORT}: {err}. \
             Check Windows Defender quarantine and that port {ENGINE_PORT} is free."
        );
        state.set_status(msg.clone());
        msg
    })?;
    state.store_child(child);
    state.set_status(format!("starting on port {ENGINE_PORT}…"));
    Ok(())
}

fn spawn_and_wait(app: &AppHandle, state: &EngineState) -> Result<String, String> {
    let on_disk = sidecar_on_disk(app);
    if let Some(ref path) = on_disk {
        unblock_path(path);
        eprintln!("info: explorer sidecar on disk at {}", path.display());
    } else {
        eprintln!(
            "warning: could not resolve holdem-explorer next to the app; \
             trying sidecar basename `{EXPLORER_SIDECAR_BASENAME}` \
             (bundle key `{EXPLORER_EXTERNAL_BIN}`)"
        );
    }

    // Someone else already listening (manual explorer / previous instance).
    if engine_port_ready() {
        let msg = format!("ready on port {ENGINE_PORT} (existing process)");
        state.set_status(msg.clone());
        return Ok(msg);
    }

    let port = ENGINE_PORT.to_string();
    let path_ref = on_disk.as_deref();
    spawn_once(app, state, path_ref, &port)?;

    let deadline = Instant::now() + ENGINE_READY_TIMEOUT;
    if wait_until_engine_ready(deadline) {
        let msg = format!("ready on port {ENGINE_PORT}");
        state.set_status(msg.clone());
        return Ok(msg);
    }

    // First spawn did not become ready — kill and retry once.
    kill_stored_child(state);
    std::thread::sleep(Duration::from_millis(200));
    if engine_port_ready() {
        // Port taken by something else after we released — treat as ready.
        let msg = format!("ready on port {ENGINE_PORT}");
        state.set_status(msg.clone());
        return Ok(msg);
    }

    spawn_once(app, state, path_ref, &port).map_err(|err| {
        let msg = format!("spawn retry failed: {err}");
        state.set_status(msg.clone());
        msg
    })?;

    let deadline = Instant::now() + ENGINE_READY_TIMEOUT;
    if wait_until_engine_ready(deadline) {
        let msg = format!("ready on port {ENGINE_PORT}");
        state.set_status(msg.clone());
        return Ok(msg);
    }

    let msg = format!(
        "engine did not accept connections on 127.0.0.1:{ENGINE_PORT} \
         within {}s (child tracked={}). Port busy, blocked binary, or missing VC runtime.",
        ENGINE_READY_TIMEOUT.as_secs(),
        state.has_child()
    );
    state.set_status(msg.clone());
    Err(msg)
}

fn spawn_explorer_sidecar(app: &tauri::App) {
    let handle = app.handle().clone();
    let state = app.state::<EngineState>();
    match spawn_and_wait(&handle, &state) {
        Ok(msg) => eprintln!("info: explorer sidecar {msg}"),
        Err(err) => {
            eprintln!("error: explorer sidecar setup failed: {err}. Window will still open.");
        }
    }
}

fn kill_explorer_sidecar(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<EngineState>() {
        kill_stored_child(&state);
        state.set_status("stopped");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(EngineState::new())
        .setup(|app| {
            spawn_explorer_sidecar(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_port,
            engine_status,
            ensure_engine,
            assistant_secret_get,
            assistant_secret_set,
            assistant_secret_clear,
            assistant_secret_has
        ])
        .build(tauri::generate_context!())
        .expect("error while building Hold'em Study")
        .run(|app_handle, event| {
            // Only on final Exit — ExitRequested can still be cancelled.
            if let RunEvent::Exit = event {
                kill_explorer_sidecar(app_handle);
            }
        });
}
