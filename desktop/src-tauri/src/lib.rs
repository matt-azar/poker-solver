// Copyright (c) Matt Azar. UNLICENSED — no license is granted.
//! Hold'em Study Tauri shell: loads the Vite UI and manages the explorer sidecar.

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

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
            ensure_engine
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
