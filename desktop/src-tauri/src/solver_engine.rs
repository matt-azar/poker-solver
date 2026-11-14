// Copyright (c) Matt Azar. UNLICENSED — no license is granted.
//! Typed-IPC bridge to the Zig `solver-engine` sidecar (protocol 2).
//!
//! Study never talks HTTP to this process. The shell owns inherited pipes
//! (stdin/stdout frames; logs on stderr) and exposes request/reply commands.
//!
//! ## Connection supervisor (async ownership)
//!
//! Rust owns the child from spawn through a bounded exit reap:
//!
//! 1. One dedicated **stdin writer** thread per launch (blocking writes live
//!    only there — never on a Tauri invoke / Tokio worker via `spawn_blocking`).
//! 2. One dedicated **stdout reader** thread demuxes replies by `request_id`.
//! 3. A **kill handle** (`Child`) independent of the writer so shutdown can
//!    interrupt a child that stopped reading stdin (unblocks a stuck write).
//! 4. Async Tauri commands await their own oneshot reply; a delayed EV cannot
//!    occupy the native main thread or prevent Status / Stop / Close.
//! 5. **Bounded admission** (PR2): outstanding count + queued bytes, Stop/Pause
//!    reserve, status coalesce, control priority, deadlines from admission.
//! 6. **Typed replies + recovery diagnostics** (PR3): serde envelopes, `IpcError`
//!    taxonomy, reply validation vs pending, fail-once on connection loss,
//!    launch-scoped late replies, bounded per-request timing samples.
//!
//! ## Concurrent mid-train `values` (R10 / ZR-62)
//!
//! The host keeps the stdin loop free during async `solve`, so Study can issue
//! `values` while train is in flight. The Tauri bridge matches that: the
//! session lifecycle mutex is **not** held across RPC waits.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tokio::sync::oneshot;

use crate::diagnostics;
use crate::solver_admission::{
    self, classify_op, is_mutating, AdmissionBoard, OpClass, MAX_OUTSTANDING,
};
use crate::solver_ipc::{
    duration_ms, validate_reply, IpcDiagSample, IpcError, PendingWaiter, ReplyValidation,
    SharedDiagRing, TimeoutPhase, PROTOCOL,
};

// PROTOCOL is re-exported from solver_ipc (keep local alias sites compiling).
const SIDECAR_BASENAME: &str = "solver-engine";
const EXTERNAL_BIN: &str = "binaries/solver-engine";
/// Override sidecar path for acceptance / harness (test sidecar).
const SIDECAR_ENV: &str = "STUDY_SOLVER_ENGINE";
const READY_TIMEOUT: Duration = Duration::from_secs(8);
/// Default RPC budget (node / values / most ops).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(240);
/// Status must match the Study poll budget (JS aborts at 4s). A 240s status
/// wait leaves orphan Tauri invokes after each soft timeout → UI slowdown /
/// memory spikes while the sidecar is hung (ZR-175).
const STATUS_RPC_TIMEOUT: Duration = Duration::from_secs(8);
/// `begin_config` can compile a flop tree for a while on the stdin loop.
const BEGIN_CONFIG_TIMEOUT: Duration = Duration::from_secs(600);
/// Host short-admits `solve` / `resolve_locked` immediately (ZR-106). The RPC
/// budget here is time-to-admit reply only — Study polls `status` for completion.
/// Confirmed via ipc-test-sidecar + unit test `solve_admit_uses_short_deadline`.
const TRAIN_ADMIT_TIMEOUT: Duration = Duration::from_secs(15);
/// Bounded Exit / kill reap — join writer+reader and wait on the child.
const EXIT_REAP_TIMEOUT: Duration = Duration::from_secs(3);

fn timeout_for_op(op: &str) -> Duration {
    match op {
        "solve" | "resolve_locked" => TRAIN_ADMIT_TIMEOUT,
        "begin_config" => BEGIN_CONFIG_TIMEOUT,
        "status" => STATUS_RPC_TIMEOUT,
        "cancel" | "pause" => STATUS_RPC_TIMEOUT,
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

/// Shared pipe IO: reply demux + bounded admission board (stdin owned by writer).
struct SessionIo {
    board: Arc<AdmissionBoard>,
    next_request: AtomicU64,
    pending: Mutex<HashMap<String, PendingWaiter>>,
    /// Shared with the writer poll loop so kill can exit without dropping all Senders.
    shut_down: Arc<AtomicBool>,
    /// Fail waiters at most once on EOF / malformed framing / fatal write.
    connection_closed: AtomicBool,
    /// Copied at spawn so the reader thread can fault with a real launch id.
    launch_id: String,
    /// Bounded request/connection timing samples for this launch.
    diag: SharedDiagRing,
    /// Last observed child exit status string (set on reap when known).
    child_exit: Mutex<Option<String>>,
}

fn new_session_io(launch_id: &str, shut_down: Arc<AtomicBool>, board: Arc<AdmissionBoard>) -> Arc<SessionIo> {
    Arc::new(SessionIo {
        board,
        next_request: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
        shut_down,
        connection_closed: AtomicBool::new(false),
        launch_id: launch_id.to_string(),
        diag: SharedDiagRing::default(),
        child_exit: Mutex::new(None),
    })
}

/// One supervised launch: kill handle is independent of the writer.
struct PipeSession {
    /// OS child — kill/wait without touching the writer’s stdin handle.
    child: Child,
    io: Arc<SessionIo>,
    writer: Option<JoinHandle<()>>,
    reader: Option<JoinHandle<()>>,
    launch_id: String,
    info: SolverEngineInfo,
}

pub struct SolverEngineState {
    /// Lifecycle only: spawn / take / kill. Never hold across RPC waits.
    session: Mutex<Option<PipeSession>>,
    /// Serializes ensure probe/kill/spawn so only one reconnect runs at a time.
    /// Tokio mutex so ensure can `.await` the ready handshake while single-flight.
    reconnect: tokio::sync::Mutex<()>,
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
            reconnect: tokio::sync::Mutex::new(()),
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
    // Acceptance / harness override (test sidecar). Checked first.
    if let Ok(override_path) = std::env::var(SIDECAR_ENV) {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            out.push(PathBuf::from(trimmed));
        }
    }
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
         (bundle key `{EXTERNAL_BIN}`; override via {SIDECAR_ENV})"
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

/// Close this connection at most once: shut down writer/reader waits and settle
/// every pending waiter with the same typed error. Launch B is unaffected —
/// callers must only invoke this on the SessionIo that failed.
fn fail_connection_once(io: &SessionIo, err: IpcError) {
    if io
        .connection_closed
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    io.shut_down.store(true, Ordering::SeqCst);
    io.board.signal_shutdown();
    io.board.clear_status_coalesce();
    let child_exit = io
        .child_exit
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .or_else(|| match &err {
            IpcError::ConnectionLoss { child_exit, .. } => child_exit.clone(),
            _ => None,
        });
    let err = match err {
        IpcError::ConnectionLoss {
            message,
            launch_id,
            child_exit: _,
        } => IpcError::connection_loss(message, launch_id, child_exit),
        other => other,
    };
    io.diag.record(IpcDiagSample {
        launch_id: io.launch_id.clone(),
        request_id: None,
        op: None,
        queue_wait_ms: None,
        write_duration_ms: None,
        reply_wait_ms: None,
        child_exit: match &err {
            IpcError::ConnectionLoss { child_exit, .. } => child_exit.clone(),
            _ => None,
        },
        outcome: match &err {
            IpcError::ConnectionLoss { .. } => "connection_loss".into(),
            IpcError::ProtocolFailure { .. } => "protocol_failure".into(),
            _ => "connection_closed".into(),
        },
    });
    let mut pending = match io.pending.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    for (_, waiter) in pending.drain() {
        let _ = waiter.tx.send(Err(err.clone()));
    }
}

/// Host `ok:false` envelopes stay Ok(Value) so the TypeScript adapter can read
/// `error_code` / `error_message` without Tauri mangling them into a string Err.
fn deliver_reply_value(reply: Value) -> Result<Value, IpcError> {
    Ok(reply)
}

fn fanout_coalesce(
    coalesce: Vec<oneshot::Sender<Result<Value, String>>>,
    result: &Result<Value, IpcError>,
) {
    match result {
        Ok(v) => {
            for w in coalesce {
                let _ = w.send(Ok(v.clone()));
            }
        }
        Err(e) => {
            let msg = e.to_string();
            for w in coalesce {
                let _ = w.send(Err(msg.clone()));
            }
        }
    }
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
                let rid = reply
                    .get("request_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let (validation, removed) = {
                    let mut pending = match io.pending.lock() {
                        Ok(g) => g,
                        Err(poisoned) => poisoned.into_inner(),
                    };
                    let validation = {
                        let waiter_ref = pending.get(&rid);
                        validate_reply(&reply, waiter_ref, &rid)
                    };
                    match &validation {
                        ReplyValidation::Ok | ReplyValidation::Reject(_) => {
                            (validation, pending.remove(&rid))
                        }
                        ReplyValidation::Ignore(_) => (validation, None),
                    }
                };

                match validation {
                    ReplyValidation::Ignore("progress")
                    | ReplyValidation::Ignore("non-reply")
                    | ReplyValidation::Ignore("orphan") => continue,
                    ReplyValidation::Ignore(_) => continue,
                    ReplyValidation::Reject(proto_err) => {
                        let coalesce = io.board.take_status_coalesce(&rid);
                        let result = Err(proto_err);
                        fanout_coalesce(coalesce, &result);
                        if let Some(waiter) = removed {
                            let _ = waiter.tx.send(result);
                        }
                    }
                    ReplyValidation::Ok => {
                        let coalesce = io.board.take_status_coalesce(&rid);
                        let result = deliver_reply_value(reply);
                        if let Some(waiter) = removed {
                            if let Some(wrote_at) = waiter.wrote_at {
                                io.diag.record(IpcDiagSample {
                                    launch_id: io.launch_id.clone(),
                                    request_id: Some(rid.clone()),
                                    op: Some(waiter.op.clone()),
                                    queue_wait_ms: None,
                                    write_duration_ms: None,
                                    reply_wait_ms: Some(duration_ms(wrote_at.elapsed())),
                                    child_exit: None,
                                    outcome: "ok".into(),
                                });
                            }
                            fanout_coalesce(coalesce, &result);
                            let _ = waiter.tx.send(result);
                        } else if !coalesce.is_empty() {
                            fanout_coalesce(coalesce, &result);
                        }
                    }
                }
            }
            Err(err) => {
                // Malformed framing or EOF: close this connection and fail waiters once.
                if !io.shut_down.load(Ordering::SeqCst) {
                    unexpected_eof = Some(err.clone());
                }
                let lower = err.to_lowercase();
                let close_err = if lower.contains("decode")
                    || lower.contains("bad frame")
                    || lower.contains("invalid")
                {
                    IpcError::connection_loss(
                        format!("malformed IPC framing: {err}"),
                        &io.launch_id,
                        io.child_exit.lock().ok().and_then(|g| g.clone()),
                    )
                } else {
                    IpcError::connection_loss(
                        format!("solver-engine pipe closed ({err})"),
                        &io.launch_id,
                        io.child_exit.lock().ok().and_then(|g| g.clone()),
                    )
                };
                fail_connection_once(&io, close_err);
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
    // Idempotent: settles any stragglers if EOF path did not run fail_connection_once.
    fail_connection_once(
        &io,
        IpcError::connection_loss(
            "solver-engine pipe closed",
            &io.launch_id,
            io.child_exit.lock().ok().and_then(|g| g.clone()),
        ),
    );
}

fn join_handle_bounded(handle: JoinHandle<()>, deadline: Instant, label: &str) {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        eprintln!("warn: {label} join skipped — exit reap deadline exceeded");
        return;
    }
    // std JoinHandle has no timed join; poll with try-style by spawning a
    // waiter channel. Prefer a short park loop via thread::spawn bridge.
    let (tx, rx) = mpsc::channel();
    let watcher = thread::spawn(move || {
        let _ = handle.join();
        let _ = tx.send(());
    });
    match rx.recv_timeout(remaining) {
        Ok(()) => {
            let _ = watcher.join();
        }
        Err(_) => {
            eprintln!("warn: {label} join timed out after exit reap deadline");
            // Detach watcher — process is exiting anyway.
        }
    }
}

fn wait_child_bounded(child: &mut Child, deadline: Instant) {
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => {
                if Instant::now() >= deadline {
                    eprintln!(
                        "warn: solver-engine child still alive after exit reap deadline \
                         (pid {})",
                        child.id()
                    );
                    return;
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(err) => {
                eprintln!("warn: solver-engine try_wait: {err}");
                return;
            }
        }
    }
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
        session.io.board.clear_status_coalesce();
        session.io.board.signal_shutdown();
        // Capture exit status after kill/reap for diagnostics.
        let _ = session.child.kill();
        let deadline = Instant::now() + EXIT_REAP_TIMEOUT;
        wait_child_bounded(&mut session.child, deadline);
        let exit_str = match session.child.try_wait() {
            Ok(Some(status)) => Some(status.to_string()),
            _ => Some("killed".into()),
        };
        if let Ok(mut slot) = session.io.child_exit.lock() {
            *slot = exit_str.clone();
        }
        fail_connection_once(
            &session.io,
            IpcError::connection_loss(
                "solver-engine session killed",
                &session.launch_id,
                exit_str,
            ),
        );
        // Kill handle is independent of the writer — interrupts a stuck write.
        // (kill already issued above before reap)
        // Reader holds Arc<SessionIo>. Join it first; signal board shutdown so the
        // writer exits even if Senders remain; then drop our Arc and join the writer.
        if let Some(handle) = session.reader.take() {
            join_handle_bounded(handle, deadline, "solver-engine reader");
        }
        drop(session.io);
        if let Some(handle) = session.writer.take() {
            join_handle_bounded(handle, deadline, "solver-engine writer");
        }
        diagnostics::remember_sidecar_pid(None);
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

    let shut_down = Arc::new(AtomicBool::new(false));
    let board = AdmissionBoard::new(Arc::clone(&shut_down));
    let writer = solver_admission::spawn_writer(stdin, Arc::clone(&board))?;

    let io = new_session_io(launch_id, shut_down, board);
    let reader_io = Arc::clone(&io);
    let reader = thread::Builder::new()
        .name("solver-engine-stdout".into())
        .spawn(move || reader_loop(stdout, reader_io))
        .map_err(|err| format!("spawn solver-engine reader: {err}"))?;
    diagnostics::remember_sidecar_pid(Some(child.id()));
    Ok(PipeSession {
        child,
        io,
        writer: Some(writer),
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


/// Decrements the admission outstanding counter on drop (all exit paths).
struct OutstandingGuard {
    board: Arc<AdmissionBoard>,
    active: bool,
}

impl OutstandingGuard {
    fn new(board: Arc<AdmissionBoard>) -> Self {
        Self { board, active: true }
    }
}

impl Drop for OutstandingGuard {
    fn drop(&mut self) {
        if self.active {
            self.board.release_outstanding();
        }
    }
}

/// Async RPC: admit → priority enqueue → await write → await demuxed reply.
///
/// Deadlines start at admission. Distinguishes expired-before-write (never
/// reached the sidecar) from unknown-after-write (mutating ops must not
/// auto-replay). Status polls coalesce onto one in-flight request per launch.
/// Never uses per-invoke `spawn_blocking` for pipe I/O.
async fn rpc_shared(
    io: &Arc<SessionIo>,
    op: &str,
    body: Value,
    job_id: Option<String>,
    rpc_timeout: Duration,
) -> Result<Value, IpcError> {
    if io.shut_down.load(Ordering::SeqCst) || io.connection_closed.load(Ordering::SeqCst) {
        return Err(IpcError::connection_loss(
            "solver-engine session shut down",
            &io.launch_id,
            io.child_exit.lock().ok().and_then(|g| g.clone()),
        ));
    }

    let class = classify_op(op);
    let admitted_at = Instant::now();
    let deadline = admitted_at + rpc_timeout;

    // Status coalesce: join an already-admitted status instead of enqueueing another.
    if class == OpClass::Status {
        if let Some(rx) = io.board.try_coalesce_status() {
            return match tokio::time::timeout(
                deadline.saturating_duration_since(Instant::now()),
                rx,
            )
            .await
            {
                Ok(Ok(Ok(v))) => Ok(v),
                Ok(Ok(Err(msg))) => Err(IpcError::from_transport_message(&msg, &io.launch_id, op)),
                Ok(Err(_)) => Err(IpcError::connection_loss(
                    "solver-engine pipe closed",
                    &io.launch_id,
                    io.child_exit.lock().ok().and_then(|g| g.clone()),
                )),
                Err(_) => Err(IpcError::timeout(
                    TimeoutPhase::ReplyWait,
                    "solver-engine IPC read timed out",
                    op,
                    None,
                    true, // status soft timeout = degraded responsiveness
                )),
            };
        }
    }

    // Bound outstanding count (Stop/Pause reserve for non-control).
    if let Err(err) = io.board.try_reserve_slot(class) {
        return Err(IpcError::queue_saturation(err));
    }
    let _outstanding = OutstandingGuard::new(Arc::clone(&io.board));

    let request_id = allocate_request_id(io);
    let (reply_tx, reply_rx) = oneshot::channel();
    {
        let mut pending = match io.pending.lock() {
            Ok(g) => g,
            Err(_) => {
                return Err(IpcError::protocol_failure(
                    "solver-engine pending lock poisoned",
                    Some(request_id),
                    Some(op.to_string()),
                ));
            }
        };
        pending.insert(
            request_id.clone(),
            PendingWaiter {
                tx: reply_tx,
                op: op.to_string(),
                job_id: job_id.clone(),
                admitted_at,
                wrote_at: None,
            },
        );
    }
    if class == OpClass::Status {
        io.board.begin_status_coalesce(&request_id);
    }

    let envelope = json!({
        "v": PROTOCOL,
        "kind": "request",
        "request_id": request_id,
        "job_id": job_id,
        "op": op,
        "body": body,
    });
    let frame = match encode_frame(&envelope) {
        Ok(f) => f,
        Err(err) => {
            if let Ok(mut pending) = io.pending.lock() {
                pending.remove(&request_id);
            }
            if class == OpClass::Status {
                let _ = io.board.take_status_coalesce(&request_id);
            }
            return Err(IpcError::protocol_failure(
                err,
                Some(request_id),
                Some(op.to_string()),
            ));
        }
    };

    // Expired while encoding / registering — never enqueue.
    if Instant::now() >= deadline {
        if let Ok(mut pending) = io.pending.lock() {
            pending.remove(&request_id);
        }
        if class == OpClass::Status {
            let waiters = io.board.take_status_coalesce(&request_id);
            let msg = format!(
                "expired-before-write: status deadline elapsed before enqueue"
            );
            for w in waiters {
                let _ = w.send(Err(msg.clone()));
            }
        }
        return Err(IpcError::timeout(
            TimeoutPhase::BeforeWrite,
            format!("expired-before-write: op {op} deadline elapsed before stdin enqueue"),
            op,
            Some(request_id),
            false,
        ));
    }

    let write_rx = match io.board.enqueue_write(op, frame, admitted_at, deadline) {
        Ok(rx) => rx,
        Err(err) => {
            if let Ok(mut pending) = io.pending.lock() {
                pending.remove(&request_id);
            }
            if class == OpClass::Status {
                let _ = io.board.take_status_coalesce(&request_id);
            }
            return Err(IpcError::from_transport_message(&err, &io.launch_id, op));
        }
    };

    // Await write (writer may reject with expired-before-write).
    let write_outcome = match write_rx.await {
        Ok(Ok(complete)) => complete,
        Ok(Err(err)) => {
            if let Ok(mut pending) = io.pending.lock() {
                pending.remove(&request_id);
            }
            if class == OpClass::Status {
                let waiters = io.board.take_status_coalesce(&request_id);
                for w in waiters {
                    let _ = w.send(Err(err.clone()));
                }
            }
            let typed = IpcError::from_transport_message(&err, &io.launch_id, op);
            if typed.is_connection_loss()
                || err.to_lowercase().contains("write:")
                || err.to_lowercase().contains("broken pipe")
            {
                fail_connection_once(io, typed.clone());
            }
            return Err(typed);
        }
        Err(_) => {
            if let Ok(mut pending) = io.pending.lock() {
                pending.remove(&request_id);
            }
            if class == OpClass::Status {
                let _ = io.board.take_status_coalesce(&request_id);
            }
            let typed = IpcError::connection_loss(
                "solver-engine writer dropped",
                &io.launch_id,
                io.child_exit.lock().ok().and_then(|g| g.clone()),
            );
            fail_connection_once(io, typed.clone());
            return Err(typed);
        }
    };

    // Stamp wrote_at for reply-wait diagnostics.
    if let Ok(mut pending) = io.pending.lock() {
        if let Some(w) = pending.get_mut(&request_id) {
            w.wrote_at = Some(Instant::now());
        }
    }
    io.diag.record(IpcDiagSample {
        launch_id: io.launch_id.clone(),
        request_id: Some(request_id.clone()),
        op: Some(op.to_string()),
        queue_wait_ms: Some(duration_ms(write_outcome.queue_wait)),
        write_duration_ms: Some(duration_ms(write_outcome.write_duration)),
        reply_wait_ms: None,
        child_exit: None,
        outcome: "wrote".into(),
    });

    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        if let Ok(mut pending) = io.pending.lock() {
            pending.remove(&request_id);
        }
        if class == OpClass::Status {
            let _ = io.board.take_status_coalesce(&request_id);
        }
        if is_mutating(op) {
            return Err(IpcError::timeout(
                TimeoutPhase::AfterWrite,
                format!(
                    "unknown-after-write: op {op} deadline elapsed after stdin write \
                     (do not auto-replay Save/Open/Solve)"
                ),
                op,
                Some(request_id),
                false,
            ));
        }
        return Err(IpcError::timeout(
            TimeoutPhase::ReplyWait,
            "solver-engine IPC read timed out",
            op,
            Some(request_id),
            op == "status",
        ));
    }

    let result = match tokio::time::timeout(remaining, reply_rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(IpcError::connection_loss(
            "solver-engine pipe closed",
            &io.launch_id,
            io.child_exit.lock().ok().and_then(|g| g.clone()),
        )),
        Err(_) => {
            if let Ok(mut pending) = io.pending.lock() {
                pending.remove(&request_id);
            }
            if class == OpClass::Status {
                let waiters = io.board.take_status_coalesce(&request_id);
                for w in waiters {
                    let _ = w.send(Err("solver-engine IPC read timed out".into()));
                }
            }
            io.diag.record(IpcDiagSample {
                launch_id: io.launch_id.clone(),
                request_id: Some(request_id.clone()),
                op: Some(op.to_string()),
                queue_wait_ms: Some(duration_ms(write_outcome.queue_wait)),
                write_duration_ms: Some(duration_ms(write_outcome.write_duration)),
                reply_wait_ms: Some(duration_ms(remaining)),
                child_exit: None,
                outcome: if op == "status" {
                    "degraded_timeout".into()
                } else if is_mutating(op) {
                    "unknown_after_write".into()
                } else {
                    "timeout".into()
                },
            });
            if is_mutating(op) {
                Err(IpcError::timeout(
                    TimeoutPhase::AfterWrite,
                    format!(
                        "unknown-after-write: op {op} reply timed out after stdin write \
                         (do not auto-replay Save/Open/Solve)"
                    ),
                    op,
                    Some(request_id),
                    false,
                ))
            } else {
                Err(IpcError::timeout(
                    TimeoutPhase::ReplyWait,
                    "solver-engine IPC read timed out",
                    op,
                    Some(request_id),
                    op == "status",
                ))
            }
        }
    };
    result
}

async fn ready_handshake(io: &Arc<SessionIo>, launch_id: &str) -> Result<SolverEngineInfo, String> {
    let deadline = Instant::now() + READY_TIMEOUT;
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match rpc_shared(io, "ready", Value::Null, None, remaining).await {
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
                let sidecar = body
                    .get("sidecar")
                    .and_then(|v| v.as_str())
                    .unwrap_or(SIDECAR_BASENAME)
                    .to_string();
                return Ok(SolverEngineInfo {
                    status: format!("ready via {sidecar} IPC (protocol {PROTOCOL})"),
                    transport: "ipc".into(),
                    protocol: PROTOCOL,
                    launch_id: launch_id.to_string(),
                    sidecar,
                    workers,
                    http_fallback_label: "no engine (browser/dev — Study requires Tauri + solver-engine IPC)"
                        .into(),
                });
            }
            Err(err) => {
                if Instant::now() >= deadline {
                    return Err(err.to_string());
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
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
///
/// Single-flight reconnect; ready handshake is awaited without holding the
/// lifecycle mutex (only the reconnect permit + brief install locks).
pub async fn ensure_solver_engine_session(
    app: &AppHandle,
    state: &SolverEngineState,
) -> Result<SolverEngineInfo, String> {
    let _reconnect = state.reconnect.lock().await;

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
        match rpc_shared(&io, "ready", Value::Null, None, READY_TIMEOUT).await {
            Ok(_) => return Ok(info),
            Err(err) => {
                let _ = launch_id;
                // Only tear down the pipes we probed — not a newer install.
                // Soft/protocol timeouts on ready still warrant reconnect; connection
                // loss must not kill a newer launch B.
                kill_solver_engine_if_current(
                    state,
                    &io,
                    &format!("ensure ready probe failed: {err}"),
                );
            }
        }
    }

    // Spawn under the lifecycle lock, then release before awaiting ready.
    let (io, launch_id) = {
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
        let session = spawn_session(app, &launch_id)?;
        let io = Arc::clone(&session.io);
        *guard = Some(session);
        (io, launch_id)
    };

    state.remember_op("ready");
    match ready_handshake(&io, &launch_id).await {
        Ok(info) => {
            diagnostics::write_session_meta(
                &info.launch_id,
                info.protocol,
                info.workers,
                &info.sidecar,
            );
            state.remember_launch_id(&info.launch_id);
            let mut guard = state
                .session
                .lock()
                .map_err(|_| "solver-engine state lock poisoned".to_string())?;
            if let Some(session) = guard.as_mut() {
                if session.launch_id == launch_id {
                    session.info = info.clone();
                }
            }
            Ok(info)
        }
        Err(err) => {
            // Tear down the half-ready install; record ensure-fail (do not let
            // kill_session overwrite with a generic session-killed fault).
            let sidecar_pid = {
                let guard = state.session.lock().unwrap_or_else(|p| p.into_inner());
                guard.as_ref().map(|s| s.child.id())
            };
            diagnostics::record_fault_with_sidecar(
                &launch_id,
                Some("ready"),
                &err,
                "ensure-fail",
                PROTOCOL,
                sidecar_pid,
            );
            let mut guard = state
                .session
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if is_current_connection(guard.as_ref().map(|s| &s.io), &io) {
                kill_session(&mut guard, Some("ready"), &err, false);
            }
            Err(err)
        }
    }
}

/// Warm-start from Tauri setup without blocking window open.
pub fn spawn_background_ensure(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<SolverEngineState>();
        match ensure_solver_engine_session(&app, &*state).await {
            Ok(info) => eprintln!("info: {}", info.status),
            Err(err) => eprintln!(
                "error: solver-engine IPC unavailable ({err}). \
                 Window opened; use Reconnect after fixing the install."
            ),
        }
    });
}

#[tauri::command]
pub async fn ensure_solver_engine(
    app: AppHandle,
    state: State<'_, SolverEngineState>,
) -> Result<SolverEngineInfo, String> {
    ensure_solver_engine_session(&app, &*state).await
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
pub async fn solver_engine_request(
    state: State<'_, SolverEngineState>,
    op: String,
    body: Option<Value>,
    job_id: Option<String>,
) -> Result<Value, IpcError> {
    // Capture the connection that issued this RPC so a late fatal cannot kill a
    // sidecar installed by a later reconnect (ZR-154).
    let io = session_io(&*state).map_err(|e| {
        IpcError::connection_loss(e, "none", None)
    })?;
    state.remember_op(&op);
    let reply = rpc_shared(
        &io,
        &op,
        body.unwrap_or(Value::Null),
        job_id,
        timeout_for_op(&op),
    )
    .await;
    if let Err(err) = &reply {
        // Kill only on connection loss. Soft status timeouts are degraded
        // responsiveness — never tear down a healthy train for those.
        if err.is_connection_loss() {
            kill_solver_engine_if_current(&*state, &io, &err.to_string());
        }
    }
    reply
}

/// Snapshot bounded IPC diagnostics for the current launch (tests / support).
#[tauri::command]
pub fn solver_engine_ipc_diagnostics(
    state: State<'_, SolverEngineState>,
) -> Result<Vec<IpcDiagSample>, String> {
    let guard = state
        .session
        .lock()
        .map_err(|_| "solver-engine state lock poisoned".to_string())?;
    match guard.as_ref() {
        Some(s) => Ok(s.io.diag.snapshot()),
        None => Ok(Vec::new()),
    }
}

/// Clean app Exit — tear down sidecar without overwriting a useful last-fault.
/// Bounded: kill handle first, then reap within [`EXIT_REAP_TIMEOUT`].
pub fn kill_solver_engine(state: &SolverEngineState) {
    // Poisoned mutex must not skip Exit/kill — orphan sidecars lock NSIS upgrades.
    let mut guard = state
        .session
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    kill_session(&mut guard, None, "app-exit", false);
}

/// Kill the installed session only when its launch id matches `expected_launch_id`.
///
/// Watchdog / hung-kill must be launch-scoped: after Reconnect installs engine B,
/// a late kill for engine A must be a no-op (audit #5). Empty expected id is an
/// error — never blind-kill. Missing session is a quiet no-op.
fn kill_solver_engine_for_launch(
    state: &SolverEngineState,
    expected_launch_id: &str,
    reason: &str,
    record_fault: bool,
) -> Result<(), String> {
    let expected = expected_launch_id.trim();
    if expected.is_empty() {
        return Err("kill_solver_engine_cmd requires expected_launch_id".into());
    }
    let last_op = state.last_op_snapshot();
    let mut guard = state
        .session
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match guard.as_ref() {
        None => Ok(()),
        Some(session) if session.launch_id != expected => {
            // Stale watchdog / UI kill after reconnect — leave the live child alone.
            Ok(())
        }
        Some(_) => {
            kill_session(&mut guard, last_op.as_deref(), reason, record_fault);
            Ok(())
        }
    }
}

/// ZR-151: Study may terminate a hung/unresponsive sidecar before Reconnect.
/// Requires the launch id Study believes is hung so a reconnect cannot be torn down.
#[tauri::command]
pub async fn kill_solver_engine_cmd(
    state: State<'_, SolverEngineState>,
    expected_launch_id: String,
) -> Result<(), String> {
    // Kill handle is independent of the writer; EXIT_REAP_TIMEOUT bounds wait.
    // Async entry point keeps this off the native UI thread.
    kill_solver_engine_for_launch(
        &*state,
        &expected_launch_id,
        "kill_solver_engine_cmd (hung/reconnect)",
        true,
    )
}

/// True when `STUDY_IPC_ACCEPTANCE=1` — WebView runs the concurrency probe.
#[tauri::command]
pub fn ipc_acceptance_enabled() -> bool {
    matches!(
        std::env::var("STUDY_IPC_ACCEPTANCE").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

/// Exit the process with a code (acceptance harness).
#[tauri::command]
pub fn exit_with_code(code: i32) {
    std::process::exit(code);
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
        assert_eq!(timeout_for_op("solve"), TRAIN_ADMIT_TIMEOUT);
        assert_eq!(timeout_for_op("resolve_locked"), TRAIN_ADMIT_TIMEOUT);
        assert!(TRAIN_ADMIT_TIMEOUT < REQUEST_TIMEOUT);
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
    fn deliver_reply_preserves_host_error_codes() {
        let reply = json!({
            "v": 2,
            "kind": "reply",
            "request_id": "r9",
            "op": "node",
            "ok": false,
            "error_code": "busy",
            "error_message": "train running"
        });
        let ok = deliver_reply_value(reply).expect("host rejection stays Ok(envelope)");
        assert_eq!(ok["ok"], false);
        assert_eq!(ok["error_code"], "busy");
        assert_eq!(ok["error_message"], "train running");
    }

    #[test]
    fn fail_connection_once_is_idempotent() {
        let shut_down = Arc::new(AtomicBool::new(false));
        let io = new_session_io("launch-fail-once", Arc::clone(&shut_down), AdmissionBoard::new(shut_down));
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = io.pending.lock().unwrap();
            pending.insert(
                "r1".into(),
                PendingWaiter {
                    tx,
                    op: "status".into(),
                    job_id: None,
                    admitted_at: Instant::now(),
                    wrote_at: None,
                },
            );
        }
        fail_connection_once(
            &io,
            IpcError::connection_loss("pipe closed", "launch-fail-once", None),
        );
        let first = rx.blocking_recv().expect("waiter settled");
        assert!(first.is_err());
        // Second close must not panic / double-fail.
        fail_connection_once(
            &io,
            IpcError::connection_loss("again", "launch-fail-once", None),
        );
        assert!(io.connection_closed.load(Ordering::SeqCst));
        assert!(io.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn only_one_reconnect_attempt_holds_the_lock() {
        let state = SolverEngineState::new();
        let _held = state.reconnect.lock().await;
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
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
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
            let shut_down = Arc::new(AtomicBool::new(false));
            let board = AdmissionBoard::new(Arc::clone(&shut_down));
            let _writer = solver_admission::spawn_writer(stdin, Arc::clone(&board)).ok();
            let io = new_session_io(launch_id, shut_down, board);
            let session = PipeSession {
                child,
                io: Arc::clone(&io),
                writer: None,
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
                let _stdin = child.stdin.take().unwrap();
                let io = {
                    let shut_down = Arc::new(AtomicBool::new(false));
                    new_session_io("engine-a", Arc::clone(&shut_down), AdmissionBoard::new(shut_down))
                };
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
                let _stdin = child.stdin.take().unwrap();
                let io = {
                    let shut_down = Arc::new(AtomicBool::new(false));
                    new_session_io("engine-b", Arc::clone(&shut_down), AdmissionBoard::new(shut_down))
                };
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

        #[test]
        fn hung_kill_with_stale_launch_id_is_noop() {
            let state = SolverEngineState::new();
            let (_io_a, pid_a) = install_test_session(&state, "engine-a");
            assert!(process_alive(pid_a));
            let (_io_b, pid_b) = install_test_session(&state, "engine-b");
            assert!(!process_alive(pid_a));
            assert!(process_alive(pid_b));

            kill_solver_engine_for_launch(
                &state,
                "engine-a",
                "stale hung-kill after reconnect",
                true,
            )
            .expect("stale kill is a quiet no-op");

            {
                let guard = state.session.lock().expect("session lock");
                let session = guard
                    .as_ref()
                    .expect("engine B must remain after stale launch kill");
                assert_eq!(session.launch_id, "engine-b");
                assert_eq!(session.child.id(), pid_b);
                assert!(!session.io.shut_down.load(Ordering::SeqCst));
            }
            assert!(
                process_alive(pid_b),
                "engine B must survive hung-kill scoped to engine A"
            );

            kill_solver_engine(&state);
            assert!(!process_alive(pid_b));
        }

        #[test]
        fn hung_kill_with_matching_launch_id_kills() {
            let state = SolverEngineState::new();
            let (_io, pid) = install_test_session(&state, "engine-hung");
            assert!(process_alive(pid));
            kill_solver_engine_for_launch(
                &state,
                "engine-hung",
                "matching hung-kill",
                true,
            )
            .expect("matching kill ok");
            assert!(state.session.lock().expect("session lock").is_none());
            assert!(!process_alive(pid));
        }

        #[test]
        fn hung_kill_rejects_empty_launch_id() {
            let state = SolverEngineState::new();
            let (_io, pid) = install_test_session(&state, "engine-keep");
            let err = kill_solver_engine_for_launch(&state, "  ", "blind kill", true)
                .expect_err("empty launch id must refuse kill");
            assert!(err.contains("expected_launch_id"));
            assert!(process_alive(pid), "blind kill must not tear down the child");
            kill_solver_engine(&state);
        }
    }

    /// Supervisor concurrency with the controllable test sidecar (Unix).
    #[cfg(unix)]
    mod supervisor_concurrency {
        use super::super::*;
        use std::process::{Command, Stdio};

        fn test_sidecar_bin() -> PathBuf {
            // Standalone crate: desktop/ipc-test-sidecar (no Tauri/GTK deps).
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let candidates = [
                manifest
                    .join("..")
                    .join("ipc-test-sidecar")
                    .join("target")
                    .join("debug")
                    .join("ipc-test-sidecar"),
                manifest
                    .join("..")
                    .join("ipc-test-sidecar")
                    .join("target")
                    .join("release")
                    .join("ipc-test-sidecar"),
            ];
            for path in &candidates {
                if path.is_file() {
                    return path.clone();
                }
            }
            // Fall back to python script when the Rust bin is not built yet.
            let py = manifest
                .join("..")
                .join("..")
                .join("scripts")
                .join("desktop")
                .join("ipc_test_sidecar.py");
            if py.is_file() {
                return py;
            }
            candidates[0].clone()
        }

        fn spawn_test_sidecar_command(bin: &Path, launch_id: &str) -> Command {
            let mut cmd = if bin
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("py"))
                .unwrap_or(false)
            {
                let mut c = Command::new("python3");
                c.arg(bin);
                c
            } else {
                Command::new(bin)
            };
            cmd.arg("--launch-id").arg(launch_id);
            cmd
        }

        fn spawn_supervised_test_sidecar(launch_id: &str) -> PipeSession {
            let bin = test_sidecar_bin();
            assert!(
                bin.is_file(),
                "ipc-test-sidecar missing at {} — build with \
                 `cargo build` in desktop/ipc-test-sidecar (or use the .py fallback)",
                bin.display()
            );
            let mut child = spawn_test_sidecar_command(&bin, launch_id)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap_or_else(|err| panic!("spawn ipc-test-sidecar ({}): {err}", bin.display()));
            let stdin = child.stdin.take().expect("stdin");
            let stdout = child.stdout.take().expect("stdout");
            if let Some(mut stderr) = child.stderr.take() {
                let _ = thread::spawn(move || {
                    let mut buf = [0u8; 512];
                    while let Ok(n) = stderr.read(&mut buf) {
                        if n == 0 {
                            break;
                        }
                    }
                });
            }
            let shut_down = Arc::new(AtomicBool::new(false));
            let board = AdmissionBoard::new(Arc::clone(&shut_down));
            let writer = solver_admission::spawn_writer(stdin, Arc::clone(&board))
                .expect("spawn writer");
            let io = new_session_io(launch_id, shut_down, board);
            let reader_io = Arc::clone(&io);
            let reader = thread::spawn(move || reader_loop(stdout, reader_io));
            PipeSession {
                child,
                io,
                writer: Some(writer),
                reader: Some(reader),
                launch_id: launch_id.to_string(),
                info: SolverEngineInfo {
                    status: "test".into(),
                    transport: "ipc".into(),
                    protocol: PROTOCOL,
                    launch_id: launch_id.to_string(),
                    sidecar: "ipc-test-sidecar".into(),
                    workers: 1,
                    http_fallback_label: "test".into(),
                },
            }
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn status_and_cancel_complete_while_values_held() {
            let session = spawn_supervised_test_sidecar("accept-values-hold");
            let io = Arc::clone(&session.io);

            let ready = rpc_shared(&io, "ready", Value::Null, None, READY_TIMEOUT)
                .await
                .expect("ready");
            assert_eq!(ready["body"]["protocol"], 2);

            // Start values — test sidecar withholds the reply while still reading.
            let values_io = Arc::clone(&io);
            let values_task = tokio::spawn(async move {
                rpc_shared(
                    &values_io,
                    "values",
                    json!({ "node_index": 0 }),
                    None,
                    Duration::from_secs(30),
                )
                .await
            });

            // Give the values frame time to land and be withheld.
            tokio::time::sleep(Duration::from_millis(100)).await;

            let status = rpc_shared(&io, "status", Value::Null, None, STATUS_RPC_TIMEOUT)
                .await
                .expect("status while values pending");
            assert_eq!(status["body"]["held_values"], true);

            let cancel = rpc_shared(
                &io,
                "cancel",
                Value::Null,
                Some("j-accept".into()),
                STATUS_RPC_TIMEOUT,
            )
            .await
            .expect("cancel while values pending");
            assert_eq!(cancel["body"]["cancelled"], true);

            // Values must still be pending (sidecar withheld).
            assert!(
                !values_task.is_finished(),
                "values invoke must still be awaiting the withheld reply"
            );

            // Kill handle reaps independently of the pending values await.
            let state = SolverEngineState::new();
            {
                let mut guard = state.session.lock().unwrap();
                *guard = Some(session);
            }
            kill_solver_engine(&state);
            let values_result = values_task.await.expect("join values task");
            assert!(
                values_result.is_err(),
                "pending values must settle after kill/reap"
            );
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn status_polls_coalesce_onto_one_request() {
            let session = spawn_supervised_test_sidecar("accept-status-coalesce");
            let io = Arc::clone(&session.io);
            rpc_shared(&io, "ready", Value::Null, None, READY_TIMEOUT)
                .await
                .expect("ready");

            // Hold values so the pipe stays busy; status should still coalesce.
            let values_io = Arc::clone(&io);
            let values_task = tokio::spawn(async move {
                let _ = rpc_shared(
                    &values_io,
                    "values",
                    json!({ "node_index": 0 }),
                    None,
                    Duration::from_secs(30),
                )
                .await;
            });
            tokio::time::sleep(Duration::from_millis(50)).await;

            let a = Arc::clone(&io);
            let b = Arc::clone(&io);
            let (sa, sb) = tokio::join!(
                rpc_shared(&a, "status", Value::Null, None, STATUS_RPC_TIMEOUT),
                rpc_shared(&b, "status", Value::Null, None, STATUS_RPC_TIMEOUT),
            );
            let sa = sa.expect("status a");
            let sb = sb.expect("status b");
            assert_eq!(sa["body"]["held_values"], true);
            assert_eq!(sb["body"]["held_values"], true);

            let state = SolverEngineState::new();
            {
                let mut guard = state.session.lock().unwrap();
                *guard = Some(session);
            }
            kill_solver_engine(&state);
            let _ = values_task.await;
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn solve_admit_uses_short_deadline() {
            let session = spawn_supervised_test_sidecar("accept-solve-admit");
            let io = Arc::clone(&session.io);
            rpc_shared(&io, "ready", Value::Null, None, READY_TIMEOUT)
                .await
                .expect("ready");
            assert_eq!(timeout_for_op("solve"), TRAIN_ADMIT_TIMEOUT);
            let started = Instant::now();
            let reply = rpc_shared(
                &io,
                "solve",
                json!({ "iterations": 1 }),
                Some("j-solve".into()),
                timeout_for_op("solve"),
            )
            .await
            .expect("solve admit");
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "short-admit solve must return quickly"
            );
            // Test sidecar echoes unknown ops; body still proves a reply arrived.
            assert!(reply.get("ok").is_some() || reply.get("body").is_some());

            let state = SolverEngineState::new();
            {
                let mut guard = state.session.lock().unwrap();
                *guard = Some(session);
            }
            kill_solver_engine(&state);
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn admission_rejects_when_saturated() {
            let session = spawn_supervised_test_sidecar("accept-saturate");
            let io = Arc::clone(&session.io);
            solver_admission::force_outstanding_for_test(&io.board, MAX_OUTSTANDING);
            let err = rpc_shared(&io, "values", json!({}), None, Duration::from_secs(1))
                .await
                .unwrap_err();
            let err_s = err.to_string();
            assert!(err_s.contains("admission saturated"), "{err_s}");
            assert!(matches!(err, IpcError::QueueSaturation { .. }), "{err:?}");
            // Control reserve path for normal ops near the ceiling.
            solver_admission::force_outstanding_for_test(
                &io.board,
                MAX_OUTSTANDING - solver_admission::CONTROL_RESERVE_SLOTS,
            );
            let err = rpc_shared(&io, "values", json!({}), None, Duration::from_secs(1))
                .await
                .unwrap_err();
            let err_s = err.to_string();
            assert!(err_s.contains("control reserve"), "{err_s}");
            assert!(matches!(err, IpcError::QueueSaturation { .. }), "{err:?}");

            let state = SolverEngineState::new();
            {
                let mut guard = state.session.lock().unwrap();
                *guard = Some(session);
            }
            kill_solver_engine(&state);
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn unknown_after_write_for_save_timeout() {
            let session = spawn_supervised_test_sidecar("accept-unknown-save");
            let io = Arc::clone(&session.io);
            rpc_shared(&io, "ready", Value::Null, None, READY_TIMEOUT)
                .await
                .expect("ready");
            assert!(is_mutating("save"));
            // Sidecar sleeps ~80ms on save; 1ms deadline forces unknown-after-write.
            let err = rpc_shared(&io, "save", json!({ "path": "/tmp/x" }), None, Duration::from_millis(1))
                .await
                .unwrap_err();
            let s = err.to_string();
            assert!(
                s.contains("unknown-after-write") || s.contains("expired-before-write"),
                "expected deadline classification, got {s}"
            );
            assert!(matches!(err, IpcError::Timeout { .. }), "{err:?}");

            let state = SolverEngineState::new();
            {
                let mut guard = state.session.lock().unwrap();
                *guard = Some(session);
            }
            kill_solver_engine(&state);
        }

        fn spawn_supervised_test_sidecar_args(launch_id: &str, extra: &[&str]) -> PipeSession {
            let bin = test_sidecar_bin();
            assert!(bin.is_file(), "missing ipc-test-sidecar at {}", bin.display());
            let mut cmd = spawn_test_sidecar_command(&bin, launch_id);
            for a in extra {
                cmd.arg(a);
            }
            let mut child = cmd
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("spawn sidecar");
            let stdin = child.stdin.take().expect("stdin");
            let stdout = child.stdout.take().expect("stdout");
            if let Some(mut stderr) = child.stderr.take() {
                let _ = thread::spawn(move || {
                    let mut buf = [0u8; 512];
                    while let Ok(n) = stderr.read(&mut buf) {
                        if n == 0 {
                            break;
                        }
                    }
                });
            }
            let shut_down = Arc::new(AtomicBool::new(false));
            let board = AdmissionBoard::new(Arc::clone(&shut_down));
            let writer = solver_admission::spawn_writer(stdin, Arc::clone(&board)).expect("writer");
            let io = new_session_io(launch_id, shut_down, board);
            let reader_io = Arc::clone(&io);
            let reader = thread::spawn(move || reader_loop(stdout, reader_io));
            PipeSession {
                child,
                io,
                writer: Some(writer),
                reader: Some(reader),
                launch_id: launch_id.to_string(),
                info: SolverEngineInfo {
                    status: "test".into(),
                    transport: "ipc".into(),
                    protocol: PROTOCOL,
                    launch_id: launch_id.to_string(),
                    sidecar: "ipc-test-sidecar".into(),
                    workers: 1,
                    http_fallback_label: "test".into(),
                },
            }
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn malformed_reply_fails_pending_and_reconnect_is_fresh_launch() {
            let session = spawn_supervised_test_sidecar_args(
                "accept-malformed",
                &["--malformed-after-ready"],
            );
            let io_a = Arc::clone(&session.io);
            rpc_shared(&io_a, "ready", Value::Null, None, READY_TIMEOUT)
                .await
                .expect("ready");
            // Next RPC should observe connection loss from malformed framing.
            let err = rpc_shared(&io_a, "status", Value::Null, None, Duration::from_secs(2))
                .await
                .unwrap_err();
            assert!(
                err.is_connection_loss() || matches!(err, IpcError::ConnectionLoss { .. }),
                "{err:?}"
            );
            assert!(io_a.connection_closed.load(Ordering::SeqCst));

            // Fresh launch B must not share A's closed gate.
            let session_b = spawn_supervised_test_sidecar("accept-malformed-b");
            let io_b = Arc::clone(&session_b.io);
            assert!(!Arc::ptr_eq(&io_a, &io_b));
            let ready_b = rpc_shared(&io_b, "ready", Value::Null, None, READY_TIMEOUT)
                .await
                .expect("fresh launch ready");
            assert_eq!(ready_b["body"]["protocol"], 2);

            let state = SolverEngineState::new();
            {
                let mut guard = state.session.lock().unwrap();
                *guard = Some(session);
            }
            kill_solver_engine(&state);
            {
                let mut guard = state.session.lock().unwrap();
                *guard = Some(session_b);
            }
            kill_solver_engine(&state);
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn host_rejection_preserves_error_code_on_ok_envelope() {
            let session = spawn_supervised_test_sidecar_args(
                "accept-reject",
                &["--reject-next", "busy"],
            );
            let io = Arc::clone(&session.io);
            rpc_shared(&io, "ready", Value::Null, None, READY_TIMEOUT)
                .await
                .expect("ready");
            let reply = rpc_shared(&io, "node", json!({ "node_index": 0 }), None, Duration::from_secs(2))
                .await
                .expect("host rejection returns Ok(envelope)");
            assert_eq!(reply["ok"], false);
            assert_eq!(reply["error_code"], "busy");
            assert!(reply["error_message"].as_str().unwrap_or("").contains("rejection"));

            let state = SolverEngineState::new();
            {
                let mut guard = state.session.lock().unwrap();
                *guard = Some(session);
            }
            kill_solver_engine(&state);
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn stop_reading_bounds_queue_and_kill_reaps() {
            // Answer ready only, then stop reading — further writes queue/saturate.
            let session = spawn_supervised_test_sidecar_args(
                "accept-stop-read",
                &["--stop-reading-after", "1"],
            );
            let io = Arc::clone(&session.io);
            rpc_shared(&io, "ready", Value::Null, None, READY_TIMEOUT)
                .await
                .expect("ready");

            // Flood normal ops; at least one must hit admission saturation or deadline.
            let mut saw_bound = false;
            for i in 0..40 {
                let err = rpc_shared(
                    &io,
                    "node",
                    json!({ "node_index": i }),
                    None,
                    Duration::from_millis(200),
                )
                .await;
                if let Err(e) = err {
                    let s = e.to_string();
                    if s.contains("admission saturated")
                        || s.contains("queued bytes")
                        || s.contains("timed out")
                        || s.contains("expired-before-write")
                        || e.is_connection_loss()
                    {
                        saw_bound = true;
                        break;
                    }
                }
            }
            assert!(saw_bound, "queue/deadline must bound when sidecar stops reading");

            let started = Instant::now();
            let state = SolverEngineState::new();
            {
                let mut guard = state.session.lock().unwrap();
                *guard = Some(session);
            }
            kill_solver_engine(&state);
            assert!(
                started.elapsed() < EXIT_REAP_TIMEOUT + Duration::from_secs(2),
                "kill must reap within exit deadline"
            );
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn late_reply_from_launch_a_does_not_settle_launch_b() {
            let session_a = spawn_supervised_test_sidecar("late-a");
            let io_a = Arc::clone(&session_a.io);
            rpc_shared(&io_a, "ready", Value::Null, None, READY_TIMEOUT)
                .await
                .expect("ready a");
            // Hold values on A (withheld).
            let values_a = {
                let io = Arc::clone(&io_a);
                tokio::spawn(async move {
                    rpc_shared(
                        &io,
                        "values",
                        json!({ "node_index": 0 }),
                        None,
                        Duration::from_secs(30),
                    )
                    .await
                })
            };
            tokio::time::sleep(Duration::from_millis(50)).await;

            // Install B and prove it is live while A's values are still pending.
            let session_b = spawn_supervised_test_sidecar("late-b");
            let io_b = Arc::clone(&session_b.io);
            rpc_shared(&io_b, "ready", Value::Null, None, READY_TIMEOUT)
                .await
                .expect("ready b");
            let status_b = rpc_shared(&io_b, "status", Value::Null, None, STATUS_RPC_TIMEOUT)
                .await
                .expect("status on B while A pending");
            assert!(status_b.get("ok").is_some() || status_b.get("body").is_some());

            // Fail A once — must not mark B closed.
            fail_connection_once(
                &io_a,
                IpcError::connection_loss("test close A", "late-a", None),
            );
            assert!(io_a.connection_closed.load(Ordering::SeqCst));
            assert!(!io_b.connection_closed.load(Ordering::SeqCst));
            let status_b2 = rpc_shared(&io_b, "status", Value::Null, None, STATUS_RPC_TIMEOUT)
                .await
                .expect("B still live after A close");
            assert!(status_b2.get("body").is_some());

            let values_result = values_a.await.expect("join");
            assert!(values_result.is_err());

            let state = SolverEngineState::new();
            {
                let mut guard = state.session.lock().unwrap();
                *guard = Some(session_a);
            }
            kill_solver_engine(&state);
            {
                let mut guard = state.session.lock().unwrap();
                *guard = Some(session_b);
            }
            kill_solver_engine(&state);
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn diagnostics_record_queue_write_and_reply_timings() {
            let session = spawn_supervised_test_sidecar("accept-diag");
            let io = Arc::clone(&session.io);
            rpc_shared(&io, "ready", Value::Null, None, READY_TIMEOUT)
                .await
                .expect("ready");
            rpc_shared(&io, "status", Value::Null, None, STATUS_RPC_TIMEOUT)
                .await
                .expect("status");
            let snap = io.diag.snapshot();
            assert!(
                snap.iter().any(|s| s.op.as_deref() == Some("status") || s.op.as_deref() == Some("ready")),
                "expected diag samples, got {snap:?}"
            );
            assert!(
                snap.iter().any(|s| s.queue_wait_ms.is_some() || s.write_duration_ms.is_some() || s.reply_wait_ms.is_some()),
                "expected timing fields, got {snap:?}"
            );
            assert!(snap.iter().all(|s| s.launch_id == "accept-diag"));

            let state = SolverEngineState::new();
            {
                let mut guard = state.session.lock().unwrap();
                *guard = Some(session);
            }
            kill_solver_engine(&state);
        }
    }
}
