// Copyright (c) Matt Azar. UNLICENSED — no license is granted.
//! Hold'em Study Tauri shell: loads the Vite UI and owns the Zig solver-engine IPC session.

mod assistant_secrets;
mod library;
mod solver_engine;

use tauri::{AppHandle, Manager, RunEvent};

use assistant_secrets::AssistantSecretStore;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_shell::init());
    #[cfg(windows)]
    {
        builder = builder.plugin(tauri_plugin_dialog::init());
    }
    builder
        .manage(solver_engine::SolverEngineState::new())
        .setup(|app| {
            // Shipping Study uses Zig solver-engine IPC only (no holdem-explorer).
            let handle = app.handle().clone();
            let zig_state = app.state::<solver_engine::SolverEngineState>();
            match solver_engine::ensure_solver_engine_session(&handle, &zig_state) {
                Ok(info) => {
                    eprintln!("info: {}", info.status);
                }
                Err(err) => {
                    eprintln!(
                        "error: solver-engine IPC unavailable ({err}). \
                         Window will still open; use Reconnect after fixing the install."
                    );
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            solver_engine::ensure_solver_engine,
            solver_engine::solver_engine_info,
            solver_engine::solver_engine_request,
            library::library_list_templates,
            library::library_list_ranges,
            library::library_list_recent,
            library::library_read_template,
            library::library_read_range,
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
            }
        });
}
