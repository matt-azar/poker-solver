// Copyright (c) Matt Azar. UNLICENSED — no license is granted.
//! Hold'em Study Tauri shell: loads the Vite UI and manages the explorer sidecar.

mod assistant_secrets;
mod solver_engine;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

use assistant_secrets::AssistantSecretStore;

/// Must match `kExplorerReadyProtocol` in `src/explorer/server_shared.hpp`.
const ENGINE_READY_PROTOCOL: i32 = 1;

/// Bundle key in `tauri.conf.json` `bundle.externalBin` (build-time path under
/// `src-tauri/`). At install time Tauri places only the **basename** next to the
/// app (`holdem-explorer.exe`). Do not pass this string to `shell().sidecar()` —
/// that joins it under the exe dir and looks for a non-existent `binaries/` folder.
const EXPLORER_EXTERNAL_BIN: &str = "binaries/holdem-explorer";

/// Runtime sidecar basename beside the app executable (and under target/debug).
const EXPLORER_SIDECAR_BASENAME: &str = "holdem-explorer";

/// How long to wait for the owned sidecar's `/api/ready` after spawn.
const ENGINE_READY_TIMEOUT: Duration = Duration::from_secs(12);
const ENGINE_READY_POLL: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineEndpointInfo {
    status: String,
    port: u16,
    base_url: String,
    launch_id: String,
    protocol: i32,
    max_pair_runouts: u64,
}

#[derive(Debug, Deserialize)]
struct ReadyPayload {
    ok: Option<bool>,
    protocol: i32,
    port: Option<u16>,
    launch_id: Option<String>,
    max_pair_runouts: Option<u64>,
}

struct EngineState {
    child: Mutex<Option<CommandChild>>,
    status: Mutex<String>,
    endpoint: Mutex<Option<EngineEndpointInfo>>,
}

impl EngineState {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
            status: Mutex::new("not started".into()),
            endpoint: Mutex::new(None),
        }
    }

    fn set_endpoint(&self, info: Option<EngineEndpointInfo>) {
        if let Ok(mut slot) = self.endpoint.lock() {
            *slot = info;
        }
    }

    fn endpoint_info(&self) -> Option<EngineEndpointInfo> {
        self.endpoint.lock().ok().and_then(|g| g.clone())
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
fn engine_port(state: State<'_, EngineState>) -> Option<u16> {
    state.endpoint_info().map(|info| info.port)
}

#[tauri::command]
fn engine_status(state: State<'_, EngineState>) -> String {
    state.status_text()
}

#[tauri::command]
fn engine_endpoint(state: State<'_, EngineState>) -> Option<EngineEndpointInfo> {
    state.endpoint_info()
}

fn assistant_secret_store(app: &AppHandle) -> Result<AssistantSecretStore, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("app config dir unavailable: {err}"))?;
    std::fs::create_dir_all(&dir).map_err(|err| format!("create config dir: {err}"))?;
    Ok(AssistantSecretStore::with_os_keyring(dir))
}

/// Read one assistant credential from the OS keyring (legacy file migrate-on-read).
/// Prefer this over webview localStorage for the desktop prototype.
#[tauri::command]
fn assistant_secret_get(app: AppHandle, service: String) -> Result<Option<String>, String> {
    assistant_secret_store(&app)?.get(&service)
}

#[tauri::command]
fn assistant_secret_set(app: AppHandle, service: String, value: String) -> Result<(), String> {
    assistant_secret_store(&app)?.set(&service, &value)
}

#[tauri::command]
fn assistant_secret_clear(app: AppHandle, service: String) -> Result<(), String> {
    assistant_secret_store(&app)?.clear(&service)
}

#[tauri::command]
fn assistant_secret_has(app: AppHandle, service: String) -> Result<bool, String> {
    assistant_secret_store(&app)?.has(&service)
}

/// Ensure the explorer sidecar is running and owned by this shell.
/// Safe to call from the UI on startup and on Reconnect.
///
/// Packaged Study never attaches to a foreign TCP listener: it launches one
/// child with a launch id, waits for a versioned `/api/ready` match, and
/// returns the runtime base URL for the webview.
#[tauri::command]
fn ensure_engine(
    app: AppHandle,
    state: State<'_, EngineState>,
) -> Result<EngineEndpointInfo, String> {
    if let Some(info) = state.endpoint_info() {
        if state.has_child() {
            match fetch_ready(info.port) {
                Ok(ready) if ready_matches(&ready, &info.launch_id, info.port) => {
                    state.set_status(info.status.clone());
                    return Ok(info);
                }
                _ => {
                    kill_stored_child(&state);
                    state.set_endpoint(None);
                }
            }
        } else {
            // Remembered endpoint without a child — do not attach to a stranger.
            state.set_endpoint(None);
        }
    } else {
        kill_stored_child(&state);
    }
    spawn_and_wait(&app, &state)
}

fn new_launch_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("study-{nanos:x}-{}", std::process::id())
}

fn allocate_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|err| format!("allocate loopback port: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("read allocated port: {err}"))?
        .port();
    drop(listener);
    if port == 0 {
        return Err("OS allocated port 0".into());
    }
    Ok(port)
}

fn fetch_ready(port: u16) -> Result<ReadyPayload, String> {
    let mut stream = TcpStream::connect_timeout(
        &([127, 0, 0, 1], port).into(),
        Duration::from_millis(250),
    )
    .map_err(|err| format!("connect 127.0.0.1:{port}: {err}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(750)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(750)));
    let request = format!(
        "GET /api/ready HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| format!("write /api/ready: {err}"))?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|err| format!("read /api/ready: {err}"))?;
    let text = String::from_utf8_lossy(&raw);
    let body = text
        .split("\r\n\r\n")
        .nth(1)
        .or_else(|| text.split("\n\n").nth(1))
        .unwrap_or("")
        .trim();
    if body.is_empty() {
        return Err("empty /api/ready body".into());
    }
    serde_json::from_str(body).map_err(|err| format!("parse /api/ready: {err}; body={body}"))
}

fn ready_matches(ready: &ReadyPayload, launch_id: &str, port: u16) -> bool {
    if ready.ok == Some(false) {
        return false;
    }
    if ready.protocol != ENGINE_READY_PROTOCOL {
        return false;
    }
    match ready.launch_id.as_deref() {
        Some(id) if id == launch_id => {}
        _ => return false,
    }
    if let Some(reported) = ready.port {
        if reported != port {
            return false;
        }
    }
    true
}

fn wait_until_owned_ready(
    port: u16,
    launch_id: &str,
    deadline: Instant,
) -> Result<ReadyPayload, String> {
    let mut last_err = format!("engine not ready on 127.0.0.1:{port}");
    while Instant::now() < deadline {
        match fetch_ready(port) {
            Ok(ready) if ready_matches(&ready, launch_id, port) => return Ok(ready),
            Ok(ready) => {
                last_err = format!(
                    "incompatible or foreign /api/ready on port {port} \
                     (protocol={}, launch_id={:?})",
                    ready.protocol, ready.launch_id
                );
            }
            Err(err) => last_err = err,
        }
        std::thread::sleep(ENGINE_READY_POLL);
    }
    Err(last_err)
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

/// Resolve installed Library asset roots for the explorer sidecar.
///
/// Packaged Study stages `configs/templates` and `configs/ranges` via
/// `bundle.resources`. Dev launches leave these unset so explorer keeps its
/// cwd / exe-relative checkout search.
fn existing_library_dir(app: &AppHandle, leaf: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(resource.join("configs").join(leaf));
        candidates.push(resource.join(leaf));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("configs").join(leaf));
            candidates.push(dir.join("resources").join("configs").join(leaf));
        }
    }
    candidates.into_iter().find(|path| path.is_dir())
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
    port: u16,
    launch_id: &str,
) -> Result<(), String> {
    let (cmd, label) = explorer_command(app, on_disk).map_err(|err| {
        state.set_status(err.clone());
        err
    })?;
    let port_text = port.to_string();
    let mut cmd = cmd.args([
        "--port",
        &port_text,
        "--launch-id",
        launch_id,
        "--study-packaged",
    ]);
    if let Some(templates) = existing_library_dir(app, "templates") {
        eprintln!(
            "info: POKER_SOLVER_TEMPLATES={}",
            templates.display()
        );
        cmd = cmd.env("POKER_SOLVER_TEMPLATES", templates.as_os_str());
    }
    if let Some(ranges) = existing_library_dir(app, "ranges") {
        eprintln!("info: POKER_SOLVER_RANGES={}", ranges.display());
        cmd = cmd.env("POKER_SOLVER_RANGES", ranges.as_os_str());
    }
    let (_rx, child) = cmd.spawn().map_err(|err| {
        let msg = format!(
            "spawn failed for `{label}` on port {port}: {err}. \
             Check Windows Defender quarantine and that the chosen loopback port is free."
        );
        state.set_status(msg.clone());
        msg
    })?;
    state.store_child(child);
    state.set_status(format!("starting on port {port}…"));
    Ok(())
}

fn spawn_and_wait(app: &AppHandle, state: &EngineState) -> Result<EngineEndpointInfo, String> {
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

    let path_ref = on_disk.as_deref();
    let mut last_err = String::new();
    for attempt in 1..=2 {
        let port = allocate_loopback_port()?;
        let launch_id = new_launch_id();
        if let Err(err) = spawn_once(app, state, path_ref, port, &launch_id) {
            last_err = err;
            kill_stored_child(state);
            continue;
        }
        let deadline = Instant::now() + ENGINE_READY_TIMEOUT;
        match wait_until_owned_ready(port, &launch_id, deadline) {
            Ok(ready) => {
                let info = EngineEndpointInfo {
                    status: format!("ready on port {port}"),
                    port,
                    base_url: format!("http://127.0.0.1:{port}"),
                    launch_id,
                    protocol: ready.protocol,
                    max_pair_runouts: ready.max_pair_runouts.unwrap_or(0),
                };
                state.set_endpoint(Some(info.clone()));
                state.set_status(info.status.clone());
                eprintln!(
                    "info: owned explorer ready at {} (attempt {attempt}, \
                     max_pair_runouts={})",
                    info.base_url, info.max_pair_runouts
                );
                return Ok(info);
            }
            Err(err) => {
                last_err = err;
                kill_stored_child(state);
                state.set_endpoint(None);
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }

    let msg = format!(
        "owned engine did not become ready within {}s (child tracked={}): {last_err}. \
         Blocked binary, missing VC runtime, or /api/ready mismatch.",
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
        Ok(info) => eprintln!("info: explorer sidecar {}", info.status),
        Err(err) => {
            eprintln!("error: explorer sidecar setup failed: {err}. Window will still open.");
        }
    }
}

fn kill_explorer_sidecar(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<EngineState>() {
        kill_stored_child(&state);
        state.set_endpoint(None);
        state.set_status("stopped");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_shell::init());
    #[cfg(windows)]
    {
        builder = builder.plugin(tauri_plugin_dialog::init());
    }
    builder
        .manage(EngineState::new())
        .manage(solver_engine::SolverEngineState::new())
        .setup(|app| {
            // Zig path prefers solver-engine IPC. HTTP explorer is a temporary
            // fallback when the Zig sidecar is missing or fails ready.
            let handle = app.handle().clone();
            let zig_state = app.state::<solver_engine::SolverEngineState>();
            match solver_engine::ensure_solver_engine_session(&handle, &zig_state) {
                Ok(info) => {
                    eprintln!("info: {}", info.status);
                }
                Err(err) => {
                    eprintln!(
                        "warning: solver-engine IPC unavailable ({err}); \
                         starting HTTP explorer fallback (temporary)"
                    );
                    spawn_explorer_sidecar(app);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_port,
            engine_status,
            engine_endpoint,
            ensure_engine,
            solver_engine::ensure_solver_engine,
            solver_engine::solver_engine_info,
            solver_engine::solver_engine_request,
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
                if let Some(state) = app_handle.try_state::<solver_engine::SolverEngineState>() {
                    solver_engine::kill_solver_engine(&state);
                }
                kill_explorer_sidecar(app_handle);
            }
        });
}
