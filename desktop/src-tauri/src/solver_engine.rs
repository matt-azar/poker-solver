// Copyright (c) Matt Azar. UNLICENSED — no license is granted.
//! Typed-IPC bridge to the Zig `solver-engine` sidecar (protocol 2).
//!
//! Study never talks HTTP to this process. The shell owns inherited pipes
//! (stdin/stdout frames; logs on stderr) and exposes request/reply commands.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

const PROTOCOL: u32 = 2;
const SIDECAR_BASENAME: &str = "solver-engine";
const EXTERNAL_BIN: &str = "binaries/solver-engine";
const READY_TIMEOUT: Duration = Duration::from_secs(8);
/// Sync host train can be long on flop fixtures; keep bounded (prefs / D12 digs).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(240);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolverEngineInfo {
    pub status: String,
    pub transport: String,
    pub protocol: u32,
    pub launch_id: String,
    pub sidecar: String,
    pub workers: u32,
    /// HTTP explorer remains a labeled temporary fallback when IPC is unavailable.
    pub http_fallback_label: String,
}

struct PipeSession {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    launch_id: String,
    info: SolverEngineInfo,
    next_request: u64,
    read_buf: Vec<u8>,
}

pub struct SolverEngineState {
    session: Mutex<Option<PipeSession>>,
}

impl SolverEngineState {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
        }
    }
}

fn new_launch_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("zig-{nanos:x}-{}", std::process::id())
}

fn unblock_path(path: &Path) {
    #[cfg(target_os = "windows")]
    {
        let mut ads = path.as_os_str().to_owned();
        ads.push(":Zone.Identifier");
        let _ = std::fs::remove_file(PathBuf::from(ads));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
    }
}

fn sidecar_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join(format!("{SIDECAR_BASENAME}.exe")));
            out.push(dir.join(SIDECAR_BASENAME));
            out.push(dir.join("binaries").join(format!("{SIDECAR_BASENAME}.exe")));
            out.push(dir.join("binaries").join(SIDECAR_BASENAME));
        }
    }
    if let Ok(resource) = app.path().resource_dir() {
        out.push(resource.join(format!("{SIDECAR_BASENAME}.exe")));
        out.push(resource.join(SIDECAR_BASENAME));
        out.push(resource.join("binaries").join(format!("{SIDECAR_BASENAME}.exe")));
        out.push(resource.join("binaries").join(SIDECAR_BASENAME));
    }
    // Dev checkout: zig-out next to repo / desktop.
    if let Ok(cwd) = std::env::current_dir() {
        out.push(cwd.join("zig-out").join("bin").join(SIDECAR_BASENAME));
        out.push(cwd.join("..").join("zig-out").join("bin").join(SIDECAR_BASENAME));
        out.push(
            cwd.join("..")
                .join("..")
                .join("zig-out")
                .join("bin")
                .join(SIDECAR_BASENAME),
        );
    }
    let _ = EXTERNAL_BIN;
    out
}

fn resolve_sidecar(app: &AppHandle) -> Result<PathBuf, String> {
    for path in sidecar_candidates(app) {
        if path.is_file() {
            unblock_path(&path);
            return Ok(path);
        }
    }
    Err(format!(
        "missing `{SIDECAR_BASENAME}` beside the app or under zig-out/bin \
         (bundle key `{EXTERNAL_BIN}`)"
    ))
}

fn encode_frame(envelope: &Value) -> Result<Vec<u8>, String> {
    let payload = serde_json::to_vec(envelope).map_err(|err| format!("encode ipc json: {err}"))?;
    if payload.len() > 16 * 1024 * 1024 {
        return Err("ipc frame too large".into());
    }
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

fn read_frame(
    stdout: &mut ChildStdout,
    stash: &mut Vec<u8>,
    deadline: Instant,
) -> Result<Value, String> {
    while stash.len() < 4 {
        let mut chunk = [0u8; 4096];
        if Instant::now() >= deadline {
            return Err("solver-engine IPC read timed out".into());
        }
        match stdout.read(&mut chunk) {
            Ok(0) => return Err("solver-engine pipe closed".into()),
            Ok(n) => stash.extend_from_slice(&chunk[..n]),
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(err) => return Err(format!("solver-engine read: {err}")),
        }
    }
    let mut len_bytes = [0u8; 4];
    len_bytes.copy_from_slice(&stash[..4]);
    let len = u32::from_le_bytes(len_bytes) as usize;
    if len == 0 || len > 16 * 1024 * 1024 {
        return Err(format!("invalid ipc frame length {len}"));
    }
    while stash.len() < 4 + len {
        let mut chunk = [0u8; 8192];
        if Instant::now() >= deadline {
            return Err("solver-engine IPC read timed out".into());
        }
        match stdout.read(&mut chunk) {
            Ok(0) => return Err("solver-engine pipe closed".into()),
            Ok(n) => stash.extend_from_slice(&chunk[..n]),
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(err) => return Err(format!("solver-engine read: {err}")),
        }
    }
    let payload = stash[4..4 + len].to_vec();
    stash.drain(..4 + len);
    serde_json::from_slice(&payload).map_err(|err| format!("decode ipc json: {err}"))
}

fn kill_session(slot: &mut Option<PipeSession>) {
    if let Some(mut session) = slot.take() {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
}

fn spawn_session(app: &AppHandle, launch_id: &str) -> Result<PipeSession, String> {
    let path = resolve_sidecar(app)?;
    eprintln!("info: solver-engine on disk at {}", path.display());
    let mut child = Command::new(&path)
        .arg("--launch-id")
        .arg(launch_id)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|err| format!("spawn `{}`: {err}", path.display()))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "solver-engine stdin missing".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "solver-engine stdout missing".to_string())?;
    Ok(PipeSession {
        child,
        stdin,
        stdout,
        launch_id: launch_id.to_string(),
        info: SolverEngineInfo {
            status: "starting".into(),
            transport: "ipc".into(),
            protocol: PROTOCOL,
            launch_id: launch_id.to_string(),
            sidecar: SIDECAR_BASENAME.into(),
            workers: 0,
            http_fallback_label: "HTTP explorer fallback (temporary — Zig path prefers solver-engine IPC)"
                .into(),
        },
        next_request: 1,
        read_buf: Vec::new(),
    })
}

fn rpc_locked(session: &mut PipeSession, op: &str, body: Value, job_id: Option<String>) -> Result<Value, String> {
    let request_id = format!("r{}", session.next_request);
    session.next_request += 1;
    let envelope = json!({
        "v": PROTOCOL,
        "kind": "request",
        "request_id": request_id,
        "job_id": job_id,
        "op": op,
        "body": body,
    });
    let frame = encode_frame(&envelope)?;
    session
        .stdin
        .write_all(&frame)
        .map_err(|err| format!("solver-engine write: {err}"))?;
    session
        .stdin
        .flush()
        .map_err(|err| format!("solver-engine flush: {err}"))?;

    let deadline = Instant::now() + REQUEST_TIMEOUT;
    loop {
        let reply = read_frame(&mut session.stdout, &mut session.read_buf, deadline)?;
        let kind = reply.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        if kind == "progress" {
            continue;
        }
        if kind != "reply" {
            return Err(format!("unexpected ipc kind `{kind}`"));
        }
        let rid = reply
            .get("request_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if rid != request_id {
            // Skip unrelated replies rather than failing the session.
            continue;
        }
        if reply.get("ok") == Some(&Value::Bool(false)) {
            let code = reply
                .get("error_code")
                .and_then(|v| v.as_str())
                .unwrap_or("ipc_error");
            let message = reply
                .get("error_message")
                .and_then(|v| v.as_str())
                .unwrap_or("solver-engine request failed");
            return Err(format!("{code}: {message}"));
        }
        return Ok(reply);
    }
}

fn ready_handshake(session: &mut PipeSession) -> Result<SolverEngineInfo, String> {
    let deadline = Instant::now() + READY_TIMEOUT;
    // Temporarily tighten timeout for ready by polling via rpc with overall deadline.
    while Instant::now() < deadline {
        match rpc_locked(session, "ready", Value::Null, None) {
            Ok(reply) => {
                let body = reply.get("body").cloned().unwrap_or(Value::Null);
                let protocol = body.get("protocol").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                if protocol != PROTOCOL {
                    return Err(format!(
                        "solver-engine protocol {protocol} incompatible (want {PROTOCOL})"
                    ));
                }
                let launch_id = body
                    .get("launch_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or(session.launch_id.as_str())
                    .to_string();
                if launch_id != session.launch_id && body.get("launch_id").is_some() {
                    // Host echoes the spawn launch id; mismatch means foreign process.
                    if launch_id != "local" && launch_id != session.launch_id {
                        return Err(format!(
                            "solver-engine launch_id mismatch (got {launch_id}, want {})",
                            session.launch_id
                        ));
                    }
                }
                let workers = body.get("workers").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                session.info = SolverEngineInfo {
                    status: format!("ready via solver-engine IPC (protocol {PROTOCOL})"),
                    transport: "ipc".into(),
                    protocol: PROTOCOL,
                    launch_id: session.launch_id.clone(),
                    sidecar: SIDECAR_BASENAME.into(),
                    workers,
                    http_fallback_label: "HTTP explorer fallback (temporary — Zig path prefers solver-engine IPC)"
                        .into(),
                };
                return Ok(session.info.clone());
            }
            Err(err) => {
                if Instant::now() >= deadline {
                    return Err(err);
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    Err("solver-engine ready handshake timed out".into())
}

/// Prefer Zig typed IPC. Callers may fall back to HTTP explorer when this fails.
pub fn ensure_solver_engine_session(
    app: &AppHandle,
    state: &SolverEngineState,
) -> Result<SolverEngineInfo, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "solver-engine state lock poisoned".to_string())?;
    if let Some(session) = guard.as_mut() {
        match rpc_locked(session, "ready", Value::Null, None) {
            Ok(_) => return Ok(session.info.clone()),
            Err(_) => kill_session(&mut guard),
        }
    }

    let launch_id = new_launch_id();
    let mut session = spawn_session(app, &launch_id)?;
    match ready_handshake(&mut session) {
        Ok(info) => {
            *guard = Some(session);
            Ok(info)
        }
        Err(err) => {
            let _ = session.child.kill();
            let _ = session.child.wait();
            Err(err)
        }
    }
}

#[tauri::command]
pub fn ensure_solver_engine(
    app: AppHandle,
    state: State<'_, SolverEngineState>,
) -> Result<SolverEngineInfo, String> {
    ensure_solver_engine_session(&app, &state)
}

#[tauri::command]
pub fn solver_engine_info(state: State<'_, SolverEngineState>) -> Option<SolverEngineInfo> {
    state
        .session
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.info.clone()))
}

#[tauri::command]
pub fn solver_engine_request(
    state: State<'_, SolverEngineState>,
    op: String,
    body: Option<Value>,
    job_id: Option<String>,
) -> Result<Value, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "solver-engine state lock poisoned".to_string())?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "solver-engine not started — call ensure_solver_engine first".to_string())?;
    let reply = rpc_locked(session, &op, body.unwrap_or(Value::Null), job_id);
    if let Err(err) = &reply {
        if err.contains("pipe closed") || err.contains("timed out") {
            kill_session(&mut guard);
        }
    }
    reply
}

pub fn kill_solver_engine(state: &SolverEngineState) {
    if let Ok(mut guard) = state.session.lock() {
        kill_session(&mut guard);
    }
}
