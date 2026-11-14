// Copyright (c) Matt Azar. UNLICENSED — no license is granted.
//! Bounded write admission for the solver-engine connection supervisor (PR2).
//!
//! - Cap outstanding requests by count and queued stdin bytes.
//! - Reserve slots for Stop/Pause (`cancel` / `pause`).
//! - Prefer control frames between writes.
//! - Coalesce concurrent `status` polls onto one in-flight request per launch.
//! - Deadlines start at admission; classify expired-before-write vs
//!   unknown-after-write (mutations must not auto-replay).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::io::Write;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::oneshot;

/// Soft cap on admitted-but-unsettled requests (queued + written + awaiting reply).
pub const MAX_OUTSTANDING: usize = 24;
/// Cap on bytes sitting in the writer queues (not yet written).
pub const MAX_QUEUED_BYTES: usize = 2 * 1024 * 1024;
/// Slots held back for Stop/Pause so analysis floods cannot starve control.
pub const CONTROL_RESERVE_SLOTS: usize = 2;
/// Warn when a control frame waited this long behind an in-flight write.
pub const CONTROL_BEHIND_WRITE_WARN: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpClass {
    /// `cancel` / `pause` — reserved capacity + write priority.
    Control,
    /// Coalesced per launch onto one in-flight poll.
    Status,
    /// `save` / `open` / `solve` / `resolve_locked` / `begin_config` — unknown if lost after write.
    Mutating,
    Normal,
}

pub fn classify_op(op: &str) -> OpClass {
    match op {
        "cancel" | "pause" => OpClass::Control,
        "status" => OpClass::Status,
        "save" | "open" | "solve" | "resolve_locked" | "begin_config" => OpClass::Mutating,
        _ => OpClass::Normal,
    }
}

pub fn is_mutating(op: &str) -> bool {
    matches!(classify_op(op), OpClass::Mutating)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Priority {
    Control,
    Normal,
}

struct QueuedWrite {
    frame: Vec<u8>,
    priority: Priority,
    op: String,
    admitted_at: Instant,
    deadline: Instant,
    /// True when a stdin write was already in flight at enqueue time.
    enqueued_behind_write: bool,
    done: oneshot::Sender<Result<WriteComplete, String>>,
}

#[derive(Debug)]
pub struct WriteComplete {
    pub queue_wait: Duration,
    pub write_duration: Duration,
    #[allow(dead_code)]
    pub behind_inflight_write: bool,
}

struct BoardInner {
    control: VecDeque<QueuedWrite>,
    normal: VecDeque<QueuedWrite>,
    queued_bytes: usize,
    write_inflight: bool,
}

/// Shared admission + priority write board for one launch.
pub struct AdmissionBoard {
    inner: Mutex<BoardInner>,
    wake: Condvar,
    outstanding: AtomicUsize,
    shut_down: Arc<AtomicBool>,
    /// Last observed control wait behind an in-flight write (nanoseconds).
    pub last_control_behind_write_ns: AtomicU64,
    /// Coalesce waiters for the in-flight status request (same launch).
    status_coalesce: Mutex<Option<StatusCoalesce>>,
}

struct StatusCoalesce {
    request_id: String,
    waiters: Vec<oneshot::Sender<Result<Value, String>>>,
}

impl AdmissionBoard {
    pub fn new(shut_down: Arc<AtomicBool>) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(BoardInner {
                control: VecDeque::new(),
                normal: VecDeque::new(),
                queued_bytes: 0,
                write_inflight: false,
            }),
            wake: Condvar::new(),
            outstanding: AtomicUsize::new(0),
            shut_down,
            last_control_behind_write_ns: AtomicU64::new(0),
            status_coalesce: Mutex::new(None),
        })
    }

    pub fn release_outstanding(&self) {
        let _ = self.outstanding.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            Some(n.saturating_sub(1))
        });
    }

    /// Try to join an in-flight status poll. Returns Some(rx) when coalesced.
    pub fn try_coalesce_status(
        &self,
    ) -> Option<oneshot::Receiver<Result<Value, String>>> {
        let mut slot = self.status_coalesce.lock().ok()?;
        let coalesce = slot.as_mut()?;
        let (tx, rx) = oneshot::channel();
        coalesce.waiters.push(tx);
        Some(rx)
    }

    pub fn begin_status_coalesce(&self, request_id: &str) {
        if let Ok(mut slot) = self.status_coalesce.lock() {
            *slot = Some(StatusCoalesce {
                request_id: request_id.to_string(),
                waiters: Vec::new(),
            });
        }
    }

    pub fn take_status_coalesce(
        &self,
        request_id: &str,
    ) -> Vec<oneshot::Sender<Result<Value, String>>> {
        let mut slot = match self.status_coalesce.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        match slot.take() {
            Some(c) if c.request_id == request_id => c.waiters,
            Some(other) => {
                // Different id still in flight — put it back.
                *slot = Some(other);
                Vec::new()
            }
            None => Vec::new(),
        }
    }

    pub fn clear_status_coalesce(&self) {
        if let Ok(mut slot) = self.status_coalesce.lock() {
            if let Some(c) = slot.take() {
                for w in c.waiters {
                    let _ = w.send(Err("solver-engine session killed".into()));
                }
            }
        }
    }

    /// Reserve an outstanding slot (count) before enqueueing a frame.
    pub fn try_reserve_slot(&self, class: OpClass) -> Result<(), String> {
        loop {
            let current = self.outstanding.load(Ordering::SeqCst);
            if current >= MAX_OUTSTANDING {
                return Err(format!(
                    "admission saturated: {current}/{MAX_OUTSTANDING} outstanding requests"
                ));
            }
            if class != OpClass::Control {
                let free = MAX_OUTSTANDING - current;
                if free <= CONTROL_RESERVE_SLOTS {
                    return Err(format!(
                        "admission saturated: control reserve ({CONTROL_RESERVE_SLOTS} slots) held for Stop/Pause \
                         ({current}/{MAX_OUTSTANDING} outstanding)"
                    ));
                }
            }
            match self.outstanding.compare_exchange(
                current,
                current + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => return Ok(()),
                Err(_) => continue,
            }
        }
    }

    /// Enqueue a framed write. Caller must already hold an outstanding reservation.
    pub fn enqueue_write(
        &self,
        op: &str,
        frame: Vec<u8>,
        admitted_at: Instant,
        deadline: Instant,
    ) -> Result<oneshot::Receiver<Result<WriteComplete, String>>, String> {
        let class = classify_op(op);
        let priority = match class {
            OpClass::Control => Priority::Control,
            _ => Priority::Normal,
        };
        let frame_len = frame.len();
        let (done_tx, done_rx) = oneshot::channel();

        let mut board = self
            .inner
            .lock()
            .map_err(|_| "solver-engine admission lock poisoned".to_string())?;

        let bytes_full = board.queued_bytes.saturating_add(frame_len) > MAX_QUEUED_BYTES;
        if bytes_full && class != OpClass::Control {
            return Err(format!(
                "admission saturated: queued bytes {}+{frame_len} exceed {MAX_QUEUED_BYTES}",
                board.queued_bytes
            ));
        }
        // Control may still enqueue a small cancel/pause when the byte budget is full.
        if bytes_full && class == OpClass::Control && frame_len > 64 * 1024 {
            return Err("admission saturated: control frame too large under byte cap".into());
        }

        let enqueued_behind_write = board.write_inflight;
        let item = QueuedWrite {
            frame,
            priority,
            op: op.to_string(),
            admitted_at,
            deadline,
            enqueued_behind_write,
            done: done_tx,
        };
        board.queued_bytes = board.queued_bytes.saturating_add(frame_len);
        match priority {
            Priority::Control => board.control.push_back(item),
            Priority::Normal => board.normal.push_back(item),
        }
        self.wake.notify_one();
        Ok(done_rx)
    }

    fn pop_next(board: &mut BoardInner) -> Option<QueuedWrite> {
        if let Some(q) = board.control.pop_front() {
            board.queued_bytes = board.queued_bytes.saturating_sub(q.frame.len());
            return Some(q);
        }
        if let Some(q) = board.normal.pop_front() {
            board.queued_bytes = board.queued_bytes.saturating_sub(q.frame.len());
            return Some(q);
        }
        None
    }

    pub fn signal_shutdown(&self) {
        self.wake.notify_all();
    }
}

/// Spawn the dedicated stdin writer that drains the admission board (control first).
pub fn spawn_writer(
    mut stdin: std::process::ChildStdin,
    board: Arc<AdmissionBoard>,
) -> Result<JoinHandle<()>, String> {
    thread::Builder::new()
        .name("solver-engine-stdin".into())
        .spawn(move || {
            loop {
                if board.shut_down.load(Ordering::SeqCst) {
                    // Drain: fail anything still queued.
                    if let Ok(mut inner) = board.inner.lock() {
                        while let Some(q) = AdmissionBoard::pop_next(&mut inner) {
                            let _ = q.done.send(Err("solver-engine session shut down".into()));
                        }
                        inner.write_inflight = false;
                    }
                    break;
                }

                let next = {
                    let mut inner = match board.inner.lock() {
                        Ok(g) => g,
                        Err(p) => p.into_inner(),
                    };
                    loop {
                        if let Some(q) = AdmissionBoard::pop_next(&mut inner) {
                            inner.write_inflight = true;
                            break Some(q);
                        }
                        if board.shut_down.load(Ordering::SeqCst) {
                            break None;
                        }
                        match board.wake.wait_timeout(inner, Duration::from_millis(50)) {
                            Ok((guard, _)) => {
                                inner = guard;
                            }
                            Err(poisoned) => {
                                let (guard, _) = poisoned.into_inner();
                                inner = guard;
                            }
                        }
                        if board.shut_down.load(Ordering::SeqCst) {
                            break None;
                        }
                    }
                };

                let Some(q) = next else {
                    continue;
                };

                if Instant::now() >= q.deadline {
                    if let Ok(mut inner) = board.inner.lock() {
                        inner.write_inflight = false;
                    }
                    board.wake.notify_one();
                    let _ = q.done.send(Err(format!(
                        "expired-before-write: op {} deadline elapsed while queued (never reached sidecar)",
                        q.op
                    )));
                    continue;
                }

                let started = Instant::now();
                let queue_wait = started.saturating_duration_since(q.admitted_at);
                if q.priority == Priority::Control && q.enqueued_behind_write {
                    board
                        .last_control_behind_write_ns
                        .store(queue_wait.as_nanos() as u64, Ordering::SeqCst);
                    if queue_wait >= CONTROL_BEHIND_WRITE_WARN {
                        eprintln!(
                            "info: control op {} waited {queue_wait:?} behind in-flight stdin write",
                            q.op
                        );
                    }
                }

                let write_started = Instant::now();
                let write_result = stdin
                    .write_all(&q.frame)
                    .and_then(|_| stdin.flush())
                    .map_err(|err| format!("solver-engine write: {err}"));
                let write_duration = write_started.elapsed();

                if let Ok(mut inner) = board.inner.lock() {
                    inner.write_inflight = false;
                }
                board.wake.notify_one();

                match write_result {
                    Ok(()) => {
                        let _ = q.done.send(Ok(WriteComplete {
                            queue_wait,
                            write_duration,
                            behind_inflight_write: q.enqueued_behind_write,
                        }));
                    }
                    Err(err) => {
                        // Signal shutdown so the reader/session can fail waiters once.
                        board.shut_down.store(true, Ordering::SeqCst);
                        board.signal_shutdown();
                        let _ = q.done.send(Err(err));
                    }
                }
            }
        })
        .map_err(|err| format!("spawn solver-engine writer: {err}"))
}

/// Test helper: push N dummy outstanding reservations (no frames).
#[cfg(test)]
pub fn force_outstanding_for_test(board: &AdmissionBoard, n: usize) {
    board.outstanding.store(n, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_ops() {
        assert_eq!(classify_op("cancel"), OpClass::Control);
        assert_eq!(classify_op("pause"), OpClass::Control);
        assert_eq!(classify_op("status"), OpClass::Status);
        assert_eq!(classify_op("save"), OpClass::Mutating);
        assert_eq!(classify_op("solve"), OpClass::Mutating);
        assert_eq!(classify_op("values"), OpClass::Normal);
    }

    #[test]
    fn control_reserve_blocks_normal_but_allows_cancel() {
        let board = AdmissionBoard::new(Arc::new(AtomicBool::new(false)));
        force_outstanding_for_test(&board, MAX_OUTSTANDING - CONTROL_RESERVE_SLOTS);
        let err = board.try_reserve_slot(OpClass::Normal).unwrap_err();
        assert!(err.contains("control reserve"), "{err}");
        board
            .try_reserve_slot(OpClass::Control)
            .expect("control may use reserve");
    }

    #[test]
    fn hard_cap_blocks_even_control() {
        let board = AdmissionBoard::new(Arc::new(AtomicBool::new(false)));
        force_outstanding_for_test(&board, MAX_OUTSTANDING);
        let err = board.try_reserve_slot(OpClass::Control).unwrap_err();
        assert!(err.contains("saturated"), "{err}");
    }
}
