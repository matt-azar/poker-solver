// Copyright (c) Matt Azar. UNLICENSED — no license is granted.
//! Hold'em Study Tauri shell: loads the Vite UI and manages the explorer sidecar.

use std::sync::Mutex;

use tauri::{Manager, RunEvent, State};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// HTTP port the production UI uses for API calls (`http://127.0.0.1:8765`).
const ENGINE_PORT: u16 = 8765;

/// Sidecar path as declared in `tauri.conf.json` `bundle.externalBin`.
const EXPLORER_SIDECAR: &str = "binaries/explorer";

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

    fn take_child(&self) -> Option<CommandChild> {
        self.child.lock().ok().and_then(|mut g| g.take())
    }

    fn store_child(&self, child: CommandChild) {
        if let Ok(mut g) = self.child.lock() {
            *g = Some(child);
        }
    }
}

#[tauri::command]
fn engine_port() -> u16 {
    ENGINE_PORT
}

#[tauri::command]
fn engine_status(state: State<'_, EngineState>) -> String {
    state
        .status
        .lock()
        .map(|s| s.clone())
        .unwrap_or_else(|_| "status lock poisoned".into())
}

fn spawn_explorer_sidecar(app: &tauri::App) {
    let state = app.state::<EngineState>();
    let port = ENGINE_PORT.to_string();

    let cmd = match app.shell().sidecar(EXPLORER_SIDECAR) {
        Ok(cmd) => cmd,
        Err(err) => {
            // Dev without a copied sidecar: UI still opens; run explorer separately.
            eprintln!(
                "error: explorer sidecar missing at `{EXPLORER_SIDECAR}` \
                 (CI should copy explorer-$TARGET_TRIPLE[.exe] into desktop/src-tauri/binaries/). \
                 Dev can run explorer on port {ENGINE_PORT} separately. Detail: {err}"
            );
            state.set_status(format!("missing sidecar: {err}"));
            return;
        }
    };

    match cmd.args(["--port", &port]).spawn() {
        Ok((_rx, child)) => {
            state.store_child(child);
            state.set_status(format!("running on port {ENGINE_PORT}"));
        }
        Err(err) => {
            eprintln!(
                "error: failed to spawn explorer sidecar `{EXPLORER_SIDECAR}` \
                 with --port {ENGINE_PORT}: {err}. Window will still open."
            );
            state.set_status(format!("spawn failed: {err}"));
        }
    }
}

fn kill_explorer_sidecar(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<EngineState>() {
        if let Some(child) = state.take_child() {
            if let Err(err) = child.kill() {
                eprintln!("warning: failed to kill explorer sidecar: {err}");
            } else {
                state.set_status("stopped");
            }
        }
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
        .invoke_handler(tauri::generate_handler![engine_port, engine_status])
        .build(tauri::generate_context!())
        .expect("error while building Hold'em Study")
        .run(|app_handle, event| {
            // Only on final Exit — ExitRequested can still be cancelled.
            if let RunEvent::Exit = event {
                kill_explorer_sidecar(app_handle);
            }
        });
}
