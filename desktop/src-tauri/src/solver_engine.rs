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

use crate::diagnostics;

const PROTOCOL: u32 = 2;
const SIDECAR_BASENAME: &str = "solver-engine";
const EXTERNAL_BIN: &str = "binaries/solver-engine";
const READY_TIMEOUT: Duration = Duration::from_secs(8);
/// Default RPC budget (node / values / most ops).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(240);
/// Status must match the Study poll budget (JS aborts at 4s). A 240s status
/// wait leaves orphan Tauri invokes after each soft timeout → UI slowdown /
/// memory spikes while the sidecar is hung (ZR-175).
const STATUS_RPC_TIMEOUT: Duration = Duration::from_secs(8);
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
        "status" => STATUS_RPC_TIMEOUT,
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
    /// Copied at spawn so the reader thread can fault with a real launch id.
    launch_id: String,
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
    /// Serializes ensure probe/kill/spawn so only one reconnect runs at a time.
    reconnect: Mutex<()>,
    /// Last IPC op attempted (for last-fault.json).
    last_op: Mutex<Option<String>>,
    /// Survives kill/clear so UI `report_engine_fault` can still stamp launchId
    /// after Rust tears down the session (ZR-168: zip had launchId "unknown").
    last_launch_id: Mutex<Option<String>>,
}

impl SolverEngineState {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
            reconnect: Mutex::new(()),
            last_op: Mutex::new(None),
            last_launch_id: Mutex::new(None),
        }
    }

    fn remember_op(&self, op: &str) {
        if let Ok(mut slot) = self.last_op.lock() {
            *slot = Some(op.to_string());
        }
    }

    fn remember_launch_id(&self, launch_id: &str) {
        if let Ok(mut slot) = self.last_launch_id.lock() {
            *slot = Some(launch_id.to_string());
        }
    }

    pub fn last_op_snapshot(&self) -> Option<String> {
        self.last_op
            .lock()
            .ok()
            .and_then(|g| g.clone())
    }

    /// Live session launch id, or the last one before kill/clear.
    pub fn launch_id_snapshot(&self) -> Option<String> {
        if let Ok(guard) = self.session.lock() {
            if let Some(session) = guard.as_ref() {
                return Some(session.launch_id.clone());
            }
        }
        self.last_launch_id
            .lock()
            .ok()
            .and_then(|g| g.clone())
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
    let mut unexpected_eof: Option<String> = None;
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
                // Sidecar died or closed stdout before host kill — record now so
                // last-fault keeps this launch_id (status-write 232 comes later).
                if !io.shut_down.load(Ordering::SeqCst) {
                    unexpected_eof = Some(err.clone());
                }
                fail_all_pending(&io, &err);
                break;
            }
        }
    }
    if let Some(err) = unexpected_eof {
        let reason = format!(
            "solver-engine stdout EOF ({err}); sidecar exited before host kill"
        );
        diagnostics::append_engine_log(format!("{reason}\n").as_bytes());
        diagnostics::record_fault(
            &io.launch_id,
            Some("stdout-eof"),
            &reason,
            "sidecar-exit",
            PROTOCOL,
        );
    }
    fail_all_pending(&io, "solver-engine pipe closed");
}

fn kill_session(
    slot: &mut Option<PipeSession>,
    last_op: Option<&str>,
    reason: &str,
    record_fault: bool,
) {
    if let Some(mut session) = slot.take() {
        let sidecar_pid = Some(session.child.id());
        if record_fault {
            // Sample RSS before kill so host-resources can still see the child.
            diagnostics::record_fault_with_sidecar(
                &session.launch_id,
                last_op,
                reason,
                "session-killed",
                PROTOCOL,
                sidecar_pid,
            );
        }
        session.io.shut_down.store(true, Ordering::SeqCst);
        let _ = session.child.kill();
        let _ = session.child.wait();
        if let Some(handle) = session.reader.take() {
            let _ = handle.join();
        }
        diagnostics::remember_sidecar_pid(None);
        fail_all_pending(&session.io, "solver-engine session killed");
    }
}

/// True when `failed_io` is still the installed session's pipes.
///
/// Late fatals from a superseded sidecar must not kill the replacement
/// (ZR-154): an old request can return after reconnect has already installed
/// engine B.
fn is_current_connection(installed: Option<&Arc<SessionIo>>, failed_io: &Arc<SessionIo>) -> bool {
    installed
        .map(|io| Arc::ptr_eq(io, failed_io))
        .unwrap_or(false)
}

/// Kill the installed session only when it is still `io` (the connection that
/// failed). No-op when a newer sidecar has already replaced it.
fn kill_solver_engine_if_current(state: &SolverEngineState, io: &Arc<SessionIo>, reason: &str) {
    let last_op = state.last_op_snapshot();
    let mut guard = state
        .session
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let current = guard.as_ref().map(|s| &s.io);
    if is_current_connection(current, io) {
        kill_session(&mut guard, last_op.as_deref(), reason, true);
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
                            // Persist for packaged GUI builds (no console); keep eprint for dev.
                            diagnostics::append_engine_log(&buf[..n]);
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
        launch_id: launch_id.to_string(),
    });
    let reader_io = Arc::clone(&io);
    let reader = thread::Builder::new()
        .name("solver-engine-stdout".into())
        .spawn(move || reader_loop(stdout, reader_io))
        .map_err(|err| format!("spawn solver-engine reader: {err}"))?;
    diagnostics::remember_sidecar_pid(Some(child.id()));
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
    // Single-flight reconnect: concurrent ensures share one probe/kill/spawn.
    let _reconnect = state
        .reconnect
        .lock()
        .map_err(|_| "solver-engine reconnect lock poisoned".to_string())?;

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
        state.remember_op("ready");
        match rpc_shared(&io, "ready", Value::Null, None, READY_TIMEOUT) {
            Ok(_) => return Ok(info),
            Err(err) => {
                let _ = launch_id;
                // Only tear down the pipes we probed — not a newer install.
                kill_solver_engine_if_current(
                    state,
                    &io,
                    &format!("ensure ready probe failed: {err}"),
                );
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
    state.remember_launch_id(&launch_id);
    let mut session = spawn_session(app, &launch_id)?;
    let io = Arc::clone(&session.io);
    // Handshake waits on the demux oneshot; lifecycle lock stays held only for
    // install/fail so two ensures cannot double-spawn. Ready is short (READY_TIMEOUT).
    state.remember_op("ready");
    match ready_handshake(&io, &launch_id) {
        Ok(info) => {
            diagnostics::write_session_meta(
                &info.launch_id,
                info.protocol,
                info.workers,
                &info.sidecar,
            );
            state.remember_launch_id(&info.launch_id);
            session.info = info.clone();
            *guard = Some(session);
            Ok(info)
        }
        Err(err) => {
            let sidecar_pid = Some(session.child.id());
            diagnostics::record_fault_with_sidecar(
                &launch_id,
                Some("ready"),
                &err,
                "ensure-fail",
                PROTOCOL,
                sidecar_pid,
            );
            session.io.shut_down.store(true, Ordering::SeqCst);
            let _ = session.child.kill();
            let _ = session.child.wait();
            if let Some(handle) = session.reader.take() {
                let _ = handle.join();
            }
            diagnostics::remember_sidecar_pid(None);
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
    // Capture the connection that issued this RPC so a late fatal cannot kill a
    // sidecar installed by a later reconnect (ZR-154).
    let io = session_io(&state)?;
    state.remember_op(&op);
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
            kill_solver_engine_if_current(&state, &io, err);
        }
    }
    reply
}

/// Clean app Exit — tear down sidecar without overwriting a useful last-fault.
pub fn kill_solver_engine(state: &SolverEngineState) {
    // Poisoned mutex must not skip Exit/kill — orphan sidecars lock NSIS upgrades.
    let mut guard = state
        .session
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    kill_session(&mut guard, None, "app-exit", false);
}

/// ZR-151: Study may terminate a hung/unresponsive sidecar before Reconnect.
#[tauri::command]
pub fn kill_solver_engine_cmd(state: State<'_, SolverEngineState>) -> Result<(), String> {
    let last_op = state.last_op_snapshot();
    let mut guard = state
        .session
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    kill_session(
        &mut guard,
        last_op.as_deref(),
        "kill_solver_engine_cmd (hung/reconnect)",
        true,
    );
    Ok(())
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
    fn encode_put_strategy_edit_keeps_envelope_kind_before_body_kind() {
        // Defense in depth for ZR-119: with preserve_order, json! insertion
        // order keeps envelope "kind" ahead of nested body "kind":"full".
        let envelope = json!({
            "v": PROTOCOL,
            "kind": "request",
            "request_id": "r12",
            "job_id": null,
            "op": "put_strategy_edit",
            "body": {
                "node_id": "p0.t-1.r-1",
                "kind": "full",
                "probs": [0.0, 1.0]
            }
        });
        let frame = encode_frame(&envelope).expect("encode");
        let payload = std::str::from_utf8(&frame[4..]).expect("utf8");
        let envelope_kind = payload.find("\"kind\":\"request\"").expect("envelope kind");
        let body_kind = payload.find("\"kind\":\"full\"").expect("body kind");
        assert!(
            envelope_kind < body_kind,
            "envelope kind must precede nested body kind; payload={payload}"
        );
        assert!(payload.contains("\"op\":\"put_strategy_edit\""));
    }

    #[test]
    fn status_rpc_timeout_is_short_vs_default() {
        // ZR-175: status must not inherit the 240s default or soft poll aborts
        // leave orphan Tauri invokes for minutes.
        assert!(STATUS_RPC_TIMEOUT < REQUEST_TIMEOUT);
        assert_eq!(timeout_for_op("status"), STATUS_RPC_TIMEOUT);
        assert_eq!(timeout_for_op("node"), REQUEST_TIMEOUT);
        assert_eq!(timeout_for_op("values"), REQUEST_TIMEOUT);
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

    #[test]
    fn only_one_reconnect_attempt_holds_the_lock() {
        let state = SolverEngineState::new();
        let _held = state.reconnect.lock().expect("reconnect lock");
        assert!(
            state.reconnect.try_lock().is_err(),
            "second reconnect must wait — only one attempt at a time"
        );
    }

    #[test]
    fn launch_id_snapshot_survives_session_clear() {
        let state = SolverEngineState::new();
        assert!(state.launch_id_snapshot().is_none());
        state.remember_launch_id("zig-deadbeef-1");
        assert_eq!(
            state.launch_id_snapshot().as_deref(),
            Some("zig-deadbeef-1"),
            "last launch id must remain after slot is empty (UI fault path)"
        );
        state.remember_launch_id("zig-cafef00d-2");
        assert_eq!(state.launch_id_snapshot().as_deref(), Some("zig-cafef00d-2"));
    }

    /// Connection-scoped kill needs a real OS child (`sleep`). Unix-only.
    #[cfg(unix)]
    mod connection_scoped {
        use super::super::*;
        use std::path::Path;
        use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
        use std::sync::{Arc, Mutex};
        use std::collections::HashMap;
        use std::process::{Command, Stdio};

        fn test_engine_info(launch_id: &str) -> SolverEngineInfo {
            SolverEngineInfo {
                status: "test".into(),
                transport: "ipc".into(),
                protocol: PROTOCOL,
                launch_id: launch_id.into(),
                sidecar: SIDECAR_BASENAME.into(),
                workers: 0,
                http_fallback_label: "test".into(),
            }
        }

        /// Stand-in sidecar: real OS child so kill/wait exercise the lifecycle path.
        fn install_test_session(
            state: &SolverEngineState,
            launch_id: &str,
        ) -> (Arc<SessionIo>, u32) {
            let mut child = Command::new("sleep")
                .arg("60")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn sleep stand-in sidecar");
            let stdin = child.stdin.take().expect("stdin");
            let _stdout = child.stdout.take();
            let pid = child.id();
            let io = Arc::new(SessionIo {
                stdin: Mutex::new(stdin),
                next_request: AtomicU64::new(1),
                pending: Mutex::new(HashMap::new()),
                shut_down: AtomicBool::new(false),
                launch_id: launch_id.to_string(),
            });
            let session = PipeSession {
                child,
                io: Arc::clone(&io),
                reader: None,
                launch_id: launch_id.to_string(),
                info: test_engine_info(launch_id),
            };
            {
                let mut guard = state.session.lock().expect("session lock");
                kill_session(&mut guard, None, "test-reinstall", false);
                *guard = Some(session);
            }
            state.remember_launch_id(launch_id);
            (io, pid)
        }

        fn process_alive(pid: u32) -> bool {
            Path::new(&format!("/proc/{pid}")).exists()
        }

        #[test]
        fn is_current_connection_matches_only_same_arc() {
            let (mut child_a, io_a) = {
                let mut child = Command::new("sleep")
                    .arg("2")
                    .stdin(Stdio::piped())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap();
                let stdin = child.stdin.take().unwrap();
                let io = Arc::new(SessionIo {
                    stdin: Mutex::new(stdin),
                    next_request: AtomicU64::new(1),
                    pending: Mutex::new(HashMap::new()),
                    shut_down: AtomicBool::new(false),
                    launch_id: "engine-a".into(),
                });
                (child, io)
            };
            let (mut child_b, io_b) = {
                let mut child = Command::new("sleep")
                    .arg("2")
                    .stdin(Stdio::piped())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap();
                let stdin = child.stdin.take().unwrap();
                let io = Arc::new(SessionIo {
                    stdin: Mutex::new(stdin),
                    next_request: AtomicU64::new(1),
                    pending: Mutex::new(HashMap::new()),
                    shut_down: AtomicBool::new(false),
                    launch_id: "engine-b".into(),
                });
                (child, io)
            };
            assert!(is_current_connection(Some(&io_a), &io_a));
            assert!(!is_current_connection(Some(&io_b), &io_a));
            assert!(!is_current_connection(None, &io_a));
            let _ = child_a.kill();
            let _ = child_a.wait();
            let _ = child_b.kill();
            let _ = child_b.wait();
        }

        #[test]
        fn delayed_failure_from_engine_a_leaves_engine_b_running() {
            let state = SolverEngineState::new();
            let (io_a, pid_a) = install_test_session(&state, "engine-a");
            assert!(process_alive(pid_a), "engine A should start alive");

            // Reconnect installs B (kills A via install helper).
            let (io_b, pid_b) = install_test_session(&state, "engine-b");
            assert!(!process_alive(pid_a), "engine A should be gone after reconnect");
            assert!(process_alive(pid_b), "engine B should be running");
            assert!(!Arc::ptr_eq(&io_a, &io_b));

            // Late fatal from a request issued against A must not kill B.
            kill_solver_engine_if_current(&state, &io_a, "delayed A failure");

            {
                let guard = state.session.lock().expect("session lock");
                let session = guard
                    .as_ref()
                    .expect("engine B must remain installed after delayed A failure");
                assert!(
                    Arc::ptr_eq(&session.io, &io_b),
                    "installed pipes must still be engine B"
                );
                assert_eq!(session.child.id(), pid_b);
                assert!(!session.io.shut_down.load(Ordering::SeqCst));
            }
            assert!(
                process_alive(pid_b),
                "engine B OS process must survive delayed failure from A"
            );

            kill_solver_engine(&state);
            assert!(!process_alive(pid_b));
        }

        #[test]
        fn fatal_on_current_connection_still_kills() {
            let state = SolverEngineState::new();
            let (io, pid) = install_test_session(&state, "engine-current");
            assert!(process_alive(pid));
            kill_solver_engine_if_current(&state, &io, "current fatal");
            assert!(
                state.session.lock().expect("session lock").is_none(),
                "current connection fatal must clear the slot"
            );
            assert!(!process_alive(pid));
        }
    }
}
