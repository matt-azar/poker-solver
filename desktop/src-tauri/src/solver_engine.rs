// Copyright (c) Matt Azar. UNLICENSED — no license is granted.
//! Typed-IPC bridge to the Zig `solver-engine` sidecar (protocol 2).
//!
//! Study never talks HTTP to this process. The shell owns inherited pipes
//! (stdin/stdout frames; logs on stderr) and exposes request/reply commands.
//!
//! ## Concurrent mid-train `values` (R10 / ZR-62)
//!
//! The host keeps the stdin loop free during async `solve`, so Study can issue
//! `values` while train is in flight. The Tauri bridge must match that: the
//! session lifecycle mutex is **not** held across blocking RPC waits. Instead:
//!
//! 1. Allocate a `request_id` and register a oneshot in a pending map.
//! 2. Serialize stdin writes under a short write lock.
//! 3. A dedicated reader thread owns stdout and demuxes replies by
//!    `request_id` to waiting callers.
//!
//! Callers block only on their oneshot (`recv_timeout`), so a long `solve`
//! cannot deadlock a concurrent `values` invoke.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

const PROTOCOL: u32 = 2;
const SIDECAR_BASENAME: &str = "solver-engine";
const EXTERNAL_BIN: &str = "binaries/solver-engine";
const READY_TIMEOUT: Duration = Duration::from_secs(8);
/// Default RPC budget (status / node / most ops).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(240);
/// `begin_config` can compile a flop tree for a while on the stdin loop.
const BEGIN_CONFIG_TIMEOUT: Duration = Duration::from_secs(600);
/// Legacy completion-shaped train replies (pre short-admit clients). Host now
/// admits `solve` / `resolve_locked` immediately; keep a long ceiling so a
/// completion-shaped sidecar cannot brick Study at 240s on flop (ZR-106).
const TRAIN_RPC_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);

fn timeout_for_op(op: &str) -> Duration {
    match op {
        "solve" | "resolve_locked" => TRAIN_RPC_TIMEOUT,
        "begin_config" => BEGIN_CONFIG_TIMEOUT,
        _ => REQUEST_TIMEOUT,
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolverEngineInfo {
    pub status: String,
    pub transport: String,
    pub protocol: u32,
    pub launch_id: String,
    pub sidecar: String,
    pub workers: u32,
    /// Label shown when IPC is unavailable (browser/dev has no engine process).
    pub http_fallback_label: String,
}

/// Shared pipe IO: short stdin write lock + reply demux (not held across waits).
struct SessionIo {
    stdin: Mutex<ChildStdin>,
    next_request: AtomicU64,
    pending: Mutex<HashMap<String, SyncSender<Result<Value, String>>>>,
    shut_down: AtomicBool,
}

struct PipeSession {
    child: Child,
    io: Arc<SessionIo>,
    reader: Option<JoinHandle<()>>,
    launch_id: String,
    info: SolverEngineInfo,
}

pub struct SolverEngineState {
    /// Lifecycle only: spawn / take / kill. Never hold across RPC waits.
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

fn read_frame_blocking(stdout: &mut ChildStdout, stash: &mut Vec<u8>) -> Result<Value, String> {
    while stash.len() < 4 {
        let mut chunk = [0u8; 4096];
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

fn fail_all_pending(io: &SessionIo, message: &str) {
    let mut pending = match io.pending.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    for (_, tx) in pending.drain() {
        let _ = tx.send(Err(message.to_string()));
    }
}

fn reply_to_result(reply: Value) -> Result<Value, String> {
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
    Ok(reply)
}

fn reader_loop(mut stdout: ChildStdout, io: Arc<SessionIo>) {
    let mut stash = Vec::new();
    loop {
        if io.shut_down.load(Ordering::SeqCst) {
            break;
        }
        match read_frame_blocking(&mut stdout, &mut stash) {
            Ok(reply) => {
                let kind = reply.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                if kind == "progress" {
                    continue;
                }
                if kind != "reply" {
                    continue;
                }
                let rid = reply
                    .get("request_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let result = reply_to_result(reply);
                let tx = io
                    .pending
                    .lock()
                    .ok()
                    .and_then(|mut pending| pending.remove(&rid));
                if let Some(tx) = tx {
                    let _ = tx.send(result);
                }
                // Orphan / late reply after waiter timed out: drop.
            }
            Err(err) => {
                fail_all_pending(&io, &err);
                break;
            }
        }
    }
    fail_all_pending(&io, "solver-engine pipe closed");
}

fn kill_session(slot: &mut Option<PipeSession>) {
    if let Some(mut session) = slot.take() {
        session.io.shut_down.store(true, Ordering::SeqCst);
        let _ = session.child.kill();
        let _ = session.child.wait();
        if let Some(handle) = session.reader.take() {
            let _ = handle.join();
        }
        fail_all_pending(&session.io, "solver-engine session killed");
    }
}

fn spawn_session(app: &AppHandle, launch_id: &str) -> Result<PipeSession, String> {
    let path = resolve_sidecar(app)?;
    eprintln!("info: solver-engine on disk at {}", path.display());
    // Pipe stderr and drain it. Inheriting the parent stderr can deadlock the
    // ready handshake on Windows when the parent’s stderr is redirected (pipe
    // buffer fills → child blocks on log write → IPC ready never arrives).
    //
    // On Windows, also pass CREATE_NO_WINDOW so a Console-subsystem sidecar
    // (or a stale installer binary) cannot allocate a blank console. Closing
    // that console kills the child and bricks Study IPC. Prefer Zig
    // `subsystem = .Windows` for new builds; this flag is defense in depth.
    let mut cmd = Command::new(&path);
    cmd.arg("--launch-id")
        .arg(launch_id)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
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
    if let Some(mut stderr) = child.stderr.take() {
        let _ = thread::Builder::new()
            .name("solver-engine-stderr".into())
            .spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match stderr.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let text = String::from_utf8_lossy(&buf[..n]);
                            eprint!("{text}");
                        }
                        Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
            });
    }
    let io = Arc::new(SessionIo {
        stdin: Mutex::new(stdin),
        next_request: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
        shut_down: AtomicBool::new(false),
    });
    let reader_io = Arc::clone(&io);
    let reader = thread::Builder::new()
        .name("solver-engine-stdout".into())
        .spawn(move || reader_loop(stdout, reader_io))
        .map_err(|err| format!("spawn solver-engine reader: {err}"))?;
    Ok(PipeSession {
        child,
        io,
        reader: Some(reader),
        launch_id: launch_id.to_string(),
        info: SolverEngineInfo {
            status: "starting".into(),
            transport: "ipc".into(),
            protocol: PROTOCOL,
            launch_id: launch_id.to_string(),
            sidecar: SIDECAR_BASENAME.into(),
            workers: 0,
            http_fallback_label: "no engine (browser/dev — Study requires Tauri + solver-engine IPC)"
                .into(),
        },
    })
}

fn allocate_request_id(io: &SessionIo) -> String {
    let n = io.next_request.fetch_add(1, Ordering::SeqCst);
    format!("r{n}")
}

fn rpc_shared(
    io: &Arc<SessionIo>,
    op: &str,
    body: Value,
    job_id: Option<String>,
    timeout: Duration,
) -> Result<Value, String> {
    if io.shut_down.load(Ordering::SeqCst) {
        return Err("solver-engine session shut down".into());
    }
    let request_id = allocate_request_id(io);
    let (tx, rx) = mpsc::sync_channel(1);
    {
        let mut pending = io
            .pending
            .lock()
            .map_err(|_| "solver-engine pending lock poisoned".to_string())?;
        pending.insert(request_id.clone(), tx);
    }
    let envelope = json!({
        "v": PROTOCOL,
        "kind": "request",
        "request_id": request_id,
        "job_id": job_id,
        "op": op,
        "body": body,
    });
    let frame = encode_frame(&envelope)?;
    {
        let mut stdin = io
            .stdin
            .lock()
            .map_err(|_| "solver-engine stdin lock poisoned".to_string())?;
        if let Err(err) = stdin
            .write_all(&frame)
            .and_then(|_| stdin.flush())
            .map_err(|err| format!("solver-engine write: {err}"))
        {
            if let Ok(mut pending) = io.pending.lock() {
                pending.remove(&request_id);
            }
            return Err(err);
        }
    }
    // Session lifecycle lock is not held here — concurrent RPCs can write/wait.
    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => {
            if let Ok(mut pending) = io.pending.lock() {
                pending.remove(&request_id);
            }
            Err("solver-engine IPC read timed out".into())
        }
        Err(RecvTimeoutError::Disconnected) => Err("solver-engine pipe closed".into()),
    }
}

fn ready_handshake(io: &Arc<SessionIo>, launch_id: &str) -> Result<SolverEngineInfo, String> {
    let deadline = Instant::now() + READY_TIMEOUT;
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match rpc_shared(io, "ready", Value::Null, None, remaining) {
            Ok(reply) => {
                let body = reply.get("body").cloned().unwrap_or(Value::Null);
                let protocol = body.get("protocol").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                if protocol != PROTOCOL {
                    return Err(format!(
                        "solver-engine protocol {protocol} incompatible (want {PROTOCOL})"
                    ));
                }
                let echoed = body
                    .get("launch_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or(launch_id)
                    .to_string();
                if echoed != launch_id && body.get("launch_id").is_some() {
                    if echoed != "local" && echoed != launch_id {
                        return Err(format!(
                            "solver-engine launch_id mismatch (got {echoed}, want {launch_id})"
                        ));
                    }
                }
                let workers = body.get("workers").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                return Ok(SolverEngineInfo {
                    status: format!("ready via solver-engine IPC (protocol {PROTOCOL})"),
                    transport: "ipc".into(),
                    protocol: PROTOCOL,
                    launch_id: launch_id.to_string(),
                    sidecar: SIDECAR_BASENAME.into(),
                    workers,
                    http_fallback_label: "no engine (browser/dev — Study requires Tauri + solver-engine IPC)"
                        .into(),
                });
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

fn session_io(state: &SolverEngineState) -> Result<Arc<SessionIo>, String> {
    let guard = state
        .session
        .lock()
        .map_err(|_| "solver-engine state lock poisoned".to_string())?;
    guard
        .as_ref()
        .map(|s| Arc::clone(&s.io))
        .ok_or_else(|| "solver-engine not started — call ensure_solver_engine first".to_string())
}

/// Prefer Zig typed IPC. Callers surface a non-engine label when this fails.
pub fn ensure_solver_engine_session(
    app: &AppHandle,
    state: &SolverEngineState,
) -> Result<SolverEngineInfo, String> {
    // Existing session: probe ready without holding the lifecycle lock across the wait.
    let existing = {
        let guard = state
            .session
            .lock()
            .map_err(|_| "solver-engine state lock poisoned".to_string())?;
        guard
            .as_ref()
            .map(|s| (Arc::clone(&s.io), s.info.clone(), s.launch_id.clone()))
    };
    if let Some((io, info, launch_id)) = existing {
        match rpc_shared(&io, "ready", Value::Null, None, READY_TIMEOUT) {
            Ok(_) => return Ok(info),
            Err(_) => {
                let _ = launch_id;
                kill_solver_engine(state);
            }
        }
    }

    let mut guard = state
        .session
        .lock()
        .map_err(|_| "solver-engine state lock poisoned".to_string())?;
    // Another ensure may have won the race while we were unlocked.
    if let Some(session) = guard.as_ref() {
        return Ok(session.info.clone());
    }

    let launch_id = new_launch_id();
    let mut session = spawn_session(app, &launch_id)?;
    let io = Arc::clone(&session.io);
    // Handshake waits on the demux oneshot; lifecycle lock stays held only for
    // install/fail so two ensures cannot double-spawn. Ready is short (READY_TIMEOUT).
    match ready_handshake(&io, &launch_id) {
        Ok(info) => {
            session.info = info.clone();
            *guard = Some(session);
            Ok(info)
        }
        Err(err) => {
            session.io.shut_down.store(true, Ordering::SeqCst);
            let _ = session.child.kill();
            let _ = session.child.wait();
            if let Some(handle) = session.reader.take() {
                let _ = handle.join();
            }
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
    let io = session_io(&state)?;
    let reply = rpc_shared(
        &io,
        &op,
        body.unwrap_or(Value::Null),
        job_id,
        timeout_for_op(&op),
    );
    if let Err(err) = &reply {
        // Kill only on pipe/session death. A single RPC timeout must not nuke an
        // in-flight Study train (values/solve can be slow under flop fixtures).
        let fatal = err.contains("pipe closed")
            || err.contains("write:")
            || err.contains("Broken pipe")
            || err.contains("shut down")
            || err.contains("stdin lock poisoned");
        if fatal {
            kill_solver_engine(&state);
        }
    }
    reply
}

pub fn kill_solver_engine(state: &SolverEngineState) {
    // Poisoned mutex must not skip Exit/kill — orphan sidecars lock NSIS upgrades.
    let mut guard = state
        .session
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    kill_session(&mut guard);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::Barrier;

    #[test]
    fn encode_frame_length_prefix_round_trip() {
        let envelope = json!({
            "v": 2,
            "kind": "request",
            "request_id": "r1",
            "op": "ready",
            "body": null
        });
        let frame = encode_frame(&envelope).expect("encode");
        assert!(frame.len() >= 4);
        let len = u32::from_le_bytes(frame[..4].try_into().unwrap()) as usize;
        assert_eq!(len, frame.len() - 4);
        let decoded: Value = serde_json::from_slice(&frame[4..]).expect("decode");
        assert_eq!(decoded["op"], "ready");
        assert_eq!(decoded["request_id"], "r1");
    }

    #[test]
    fn request_ids_unique_under_contention() {
        let next = Arc::new(AtomicU64::new(1));
        let barrier = Arc::new(Barrier::new(8));
        let mut handles = Vec::new();
        for _ in 0..8 {
            let next = Arc::clone(&next);
            let barrier = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                barrier.wait();
                let mut local = Vec::with_capacity(200);
                for _ in 0..200 {
                    local.push(format!("r{}", next.fetch_add(1, Ordering::SeqCst)));
                }
                local
            }));
        }
        let mut all = HashSet::new();
        for h in handles {
            for id in h.join().unwrap() {
                assert!(all.insert(id), "duplicate request id");
            }
        }
        assert_eq!(all.len(), 8 * 200);
    }

    #[test]
    fn reply_to_result_maps_ok_false() {
        let reply = json!({
            "kind": "reply",
            "request_id": "r9",
            "ok": false,
            "error_code": "busy",
            "error_message": "train running"
        });
        let err = reply_to_result(reply).unwrap_err();
        assert!(err.contains("busy"));
        assert!(err.contains("train running"));
    }
}
