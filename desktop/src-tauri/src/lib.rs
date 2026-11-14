// Copyright (c) Matt Azar. UNLICENSED — no license is granted.
//! Hold'em Study Tauri shell: loads the Vite UI and owns the Zig solver-engine IPC session.

mod assistant_secrets;
mod diagnostics;
mod library;
mod solver_admission;
mod solver_engine;

use serde::Deserialize;
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

#[tauri::command]
fn open_diagnostics_folder() -> Result<String, String> {
    diagnostics::open_diagnostics_folder()
}

#[tauri::command]
fn copy_diagnostics_bundle() -> Result<String, String> {
    // Prefer a zip path the user can paste into chat/email.
    match diagnostics::bundle_diagnostics_zip() {
        Ok(path) => Ok(path),
        Err(zip_err) => {
            // Fallback: folder path is still shareable.
            let dir = diagnostics::diagnostics_dir_path_string()?;
            Err(format!(
                "zip failed ({zip_err}); diagnostics folder: {dir}"
            ))
        }
    }
}

#[tauri::command]
fn diagnostics_dir_path() -> Result<String, String> {
    diagnostics::diagnostics_dir_path_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FaultReport {
    reason: String,
    #[serde(default)]
    launch_id: Option<String>,
    #[serde(default)]
    last_op: Option<String>,
    #[serde(default)]
    exit_reason: Option<String>,
    #[serde(default)]
    consecutive_status_failures: Option<u32>,
    #[serde(default)]
    protocol: Option<u32>,
}

/// Study UI reports session-dead / reconnect faults so last-fault.json is current
/// even when Rust did not tear down the pipes yet.
#[tauri::command]
fn report_engine_fault(
    state: tauri::State<'_, solver_engine::SolverEngineState>,
    report: FaultReport,
) -> Result<(), String> {
    let launch_id = report
        .launch_id
        .or_else(|| state.launch_id_snapshot())
        .unwrap_or_else(|| "unknown".into());
    let last_op = report.last_op.or_else(|| state.last_op_snapshot());
    let snapshot = diagnostics::fault_from_ui_report(
        Some(launch_id),
        last_op,
        report.reason,
        report.exit_reason,
        report.consecutive_status_failures,
        report.protocol.unwrap_or(2),
    );
    diagnostics::write_last_fault(&snapshot);
    Ok(())
}

/// Persist compact last-solve + cheap host sample before train starts (ZR-169).
#[tauri::command]
fn persist_pre_solve_diagnostics(summary: serde_json::Value) -> Result<(), String> {
    diagnostics::write_pre_solve_snapshot(&summary);
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UiHangEventReport {
    kind: String,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    duration_ms: Option<u64>,
    #[serde(default)]
    detail: Option<String>,
    #[serde(default)]
    last_op: Option<String>,
    #[serde(default)]
    consecutive_status_failures: Option<u32>,
    #[serde(default)]
    phase: Option<String>,
}

/// Append a temporary UI-unresponsiveness signal (ZR-173). Soft timeouts that
/// recover still leave evidence without overwriting last-fault.json.
#[tauri::command]
fn report_ui_hang_event(report: UiHangEventReport) -> Result<(), String> {
    let kind = report.kind.trim();
    if kind.is_empty() {
        return Err("ui hang event kind required".into());
    }
    diagnostics::record_ui_hang_event(diagnostics::UiHangEvent {
        timestamp: report.timestamp.unwrap_or_default(),
        kind: kind.to_string(),
        duration_ms: report.duration_ms,
        detail: report.detail,
        last_op: report.last_op,
        consecutive_status_failures: report.consecutive_status_failures,
        phase: report.phase,
        ui_version: String::new(),
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_shell::init());
    #[cfg(windows)]
    {
        builder = builder.plugin(tauri_plugin_dialog::init());
    }
    builder
        .manage(solver_engine::SolverEngineState::new())
        .setup(|app| {
            // Seed diagnostics folder + optional LocalDumps (ZR-160). Best-effort.
            let _ = diagnostics::ensure_diagnostics_dir();
            if let Err(err) = diagnostics::register_local_dumps() {
                eprintln!("warn: LocalDumps registration skipped: {err}");
            }
            // Ready handshake is async and must not block window open. Warm-start
            // the sidecar in the background; the UI also calls ensure on boot.
            solver_engine::spawn_background_ensure(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            solver_engine::ensure_solver_engine,
            solver_engine::solver_engine_info,
            solver_engine::solver_engine_request,
            solver_engine::kill_solver_engine_cmd,
            solver_engine::ipc_acceptance_enabled,
            solver_engine::exit_with_code,
            open_diagnostics_folder,
            copy_diagnostics_bundle,
            diagnostics_dir_path,
            report_engine_fault,
            persist_pre_solve_diagnostics,
            report_ui_hang_event,
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
            // Bounded reap: kill handle first, then join I/O threads / wait child.
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<solver_engine::SolverEngineState>() {
                    solver_engine::kill_solver_engine(&*state);
                }
            }
        });
}
